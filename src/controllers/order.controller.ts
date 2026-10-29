import type { Request, Response, NextFunction } from "express";
import { prisma } from "../db/prisma.js";
import { createOrderSchema, getOrderParamsSchema } from "../schemas/order.schema.js";

export async function createOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const parseResult = createOrderSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
    }

    const { reservationId, userId } = parseResult.data;

    // Transaction ensures atomic transition from RESERVED -> CONFIRMED and Order creation
    const result = await prisma.$transaction(async (tx) => {
      // 1. Fetch the reservation with product pricing details
      const reservation = await tx.reservation.findUnique({
        where: { id: reservationId },
        include: { product: true },
      });

      if (!reservation) {
        return { error: "NOT_FOUND" as const };
      }

      // 2. Authorization check: ensure the user placing the order owns the reservation
      if (reservation.userId !== userId) {
        return { error: "FORBIDDEN" as const };
      }

      // 3. State verification: reservation must be in RESERVED state
      if (reservation.status !== "RESERVED") {
        return {
          error: "INVALID_STATUS" as const,
          currentStatus: reservation.status,
        };
      }

      // 4. Expiration check: verify reservation has not expired
      if (new Date() > reservation.expiresAt) {
        return { error: "EXPIRED" as const, expiresAt: reservation.expiresAt };
      }

      // 5. Calculate total amount
      const totalAmountInCents = reservation.quantity * reservation.product.priceInCents;

      // 6. Transition reservation status: RESERVED -> CONFIRMED
      const updatedReservation = await tx.reservation.update({
        where: { id: reservationId },
        data: { status: "CONFIRMED" },
      });

      // 7. Create the order in PENDING status awaiting payment
      const order = await tx.order.create({
        data: {
          reservationId,
          productId: reservation.productId,
          userId,
          quantity: reservation.quantity,
          totalAmountInCents,
          status: "PENDING",
        },
      });

      return {
        order,
        reservation: updatedReservation,
      };
    });

    if ("error" in result) {
      switch (result.error) {
        case "NOT_FOUND":
          return res.status(404).json({ error: "Reservation not found" });
        case "FORBIDDEN":
          return res.status(403).json({ error: "Reservation does not belong to this user" });
        case "INVALID_STATUS":
          return res.status(409).json({
            error: `Cannot convert reservation to order. Current status is ${result.currentStatus}`,
          });
        case "EXPIRED":
          return res.status(409).json({
            error: "Reservation has expired and cannot be converted to an order",
            expiresAt: result.expiresAt,
          });
      }
    }

    return res.status(201).json({
      message: "Order created successfully",
      data: {
        order: result.order,
        reservationStatus: result.reservation.status,
      },
    });
  } catch (err) {
    return next(err);
  }
}

export async function getOrderById(req: Request, res: Response, next: NextFunction) {
  try {
    const parseResult = getOrderParamsSchema.safeParse(req.params);
    if (!parseResult.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
    }

    const { id } = parseResult.data;

    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            priceInCents: true,
          },
        },
        reservation: {
          select: {
            id: true,
            status: true,
            expiresAt: true,
          },
        },
      },
    });

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    return res.status(200).json({ data: order });
  } catch (err) {
    return next(err);
  }
}
