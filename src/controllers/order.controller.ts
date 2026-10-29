import type { Request, Response, NextFunction } from "express";
import { prisma } from "../db/prisma.js";
import {
  createOrderSchema,
  getOrderParamsSchema,
  cancelOrderSchema,
} from "../schemas/order.schema.js";

// Reservation hold duration: 5 minutes
const RESERVATION_TTL_MS = 5 * 60 * 1000;

/**
 * Unified Flash Sale Checkout:
 * User clicks "Buy Now" -> Single atomic transaction:
 * 1. Atomically decrements product inventory (conditional lock: availableStock >= quantity)
 * 2. Creates the internal reservation record with a 5-minute countdown (RESERVED)
 * 3. Creates the customer Order with status PENDING awaiting payment
 */
export async function createOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const parseResult = createOrderSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
    }

    const { productId, userId, quantity } = parseResult.data;
    const expiresAt = new Date(Date.now() + RESERVATION_TTL_MS);

    const result = await prisma.$transaction(async (tx) => {
      // 1. Atomic Conditional Decrement:
      // Holds exclusive row-lock on product. Fails if availableStock < quantity.
      const updatedProducts = await tx.$queryRaw<Array<{
        id: string;
        name: string;
        priceInCents: number;
        availableStock: number;
      }>>`
        UPDATE "products"
        SET "availableStock" = "availableStock" - ${quantity},
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${productId}
          AND "availableStock" >= ${quantity}
        RETURNING "id", "name", "priceInCents", "availableStock";
      `;

      if (!updatedProducts || updatedProducts.length === 0) {
        const productExists = await tx.product.findUnique({
          where: { id: productId },
          select: { id: true, availableStock: true },
        });

        if (!productExists) {
          return { error: "NOT_FOUND" as const };
        }

        return {
          error: "INSUFFICIENT_STOCK" as const,
          availableStock: productExists.availableStock,
        };
      }

      const product = updatedProducts[0]!;
      const totalAmountInCents = quantity * product.priceInCents;

      // 2. Create internal Reservation holding inventory
      const reservation = await tx.reservation.create({
        data: {
          productId,
          userId,
          quantity,
          status: "RESERVED",
          expiresAt,
        },
      });

      // 3. Create customer Order linked 1-to-1 with the reservation
      const order = await tx.order.create({
        data: {
          reservationId: reservation.id,
          productId,
          userId,
          quantity,
          totalAmountInCents,
          status: "PENDING",
        },
      });

      return {
        order,
        reservation,
        remainingStock: product.availableStock,
      };
    });

    if ("error" in result) {
      if (result.error === "NOT_FOUND") {
        return res.status(404).json({ error: "Product not found" });
      }
      return res.status(409).json({
        error: "Insufficient inventory available",
        availableStock: result.availableStock,
      });
    }

    return res.status(201).json({
      message: "Order created successfully. Inventory held for 5 minutes awaiting payment.",
      data: {
        order: result.order,
        reservation: {
          id: result.reservation.id,
          status: result.reservation.status,
          expiresAt: result.reservation.expiresAt,
        },
        remainingStock: result.remainingStock,
      },
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * Fetch Order details by ID with live countdown information
 */
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

    const now = new Date();
    const isExpired = order.status === "PENDING" && now > order.reservation.expiresAt;
    const expiresInSeconds = Math.max(
      0,
      Math.floor((order.reservation.expiresAt.getTime() - now.getTime()) / 1000)
    );

    return res.status(200).json({
      data: {
        ...order,
        isExpired,
        expiresInSeconds,
      },
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * Safe, Atomic Order Cancellation:
 * Protects against race conditions and double-restoration:
 * 1. Checks ownership and validates state.
 * 2. Conditionally transitions order PENDING -> CANCELLED.
 * 3. Conditionally transitions reservation RESERVED -> CANCELLED (ensuring expiresAt > NOW).
 * 4. Only if both transitions succeed, restores stock atomically to Product.
 */
export async function cancelOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const paramsResult = getOrderParamsSchema.safeParse(req.params);
    if (!paramsResult.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: paramsResult.error.flatten().fieldErrors,
      });
    }

    const bodyResult = cancelOrderSchema.safeParse(req.body);
    if (!bodyResult.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: bodyResult.error.flatten().fieldErrors,
      });
    }

    const { id } = paramsResult.data;
    const { userId } = bodyResult.data;

    const result = await prisma.$transaction(async (tx) => {
      // 1. Fetch current order to inspect ownership and current state
      const order = await tx.order.findUnique({
        where: { id },
        include: { reservation: true },
      });

      if (!order) return { error: "NOT_FOUND" as const };
      if (order.userId !== userId) return { error: "FORBIDDEN" as const };
      if (order.status !== "PENDING") {
        return { error: "INVALID_STATUS" as const, currentStatus: order.status };
      }
      if (order.reservation.status !== "RESERVED") {
        return {
          error: "INVALID_RESERVATION_STATUS" as const,
          currentStatus: order.reservation.status,
        };
      }
      if (new Date() > order.reservation.expiresAt) {
        return { error: "EXPIRED" as const };
      }

      // 2. Atomic conditional update on order (guarantees idempotent state transition)
      const cancelledOrders = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        UPDATE "orders"
        SET "status" = 'CANCELLED'::"OrderStatus",
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${id}
          AND "status" = 'PENDING'::"OrderStatus"
        RETURNING "id", "status"::text;
      `;

      if (!cancelledOrders || cancelledOrders.length === 0) {
        return { error: "ALREADY_PROCESSED" as const };
      }

      // 3. Atomic conditional update on reservation (ensures not expired or already cancelled)
      const cancelledReservations = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE "reservations"
        SET "status" = 'CANCELLED'::"ReservationStatus",
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${order.reservationId}
          AND "status" = 'RESERVED'::"ReservationStatus"
          AND "expiresAt" > CURRENT_TIMESTAMP
        RETURNING "id";
      `;

      if (!cancelledReservations || cancelledReservations.length === 0) {
        return { error: "EXPIRED_OR_PROCESSED" as const };
      }

      // 4. Atomically restore inventory to product (only executed if both transitions succeeded)
      const updatedProducts = await tx.$queryRaw<Array<{ id: string; availableStock: number }>>`
        UPDATE "products"
        SET "availableStock" = "availableStock" + ${order.quantity},
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${order.productId}
        RETURNING "id", "availableStock";
      `;

      return {
        orderId: order.id,
        status: "CANCELLED",
        restoredStock: updatedProducts[0]?.availableStock,
      };
    });

    if ("error" in result) {
      switch (result.error) {
        case "NOT_FOUND":
          return res.status(404).json({ error: "Order not found" });
        case "FORBIDDEN":
          return res.status(403).json({ error: "Order does not belong to this user" });
        case "INVALID_STATUS":
          return res.status(409).json({
            error: `Cannot cancel order. Current order status is ${result.currentStatus}`,
          });
        case "INVALID_RESERVATION_STATUS":
          return res.status(409).json({
            error: `Cannot cancel order. Associated reservation is ${result.currentStatus}`,
          });
        case "EXPIRED":
        case "EXPIRED_OR_PROCESSED":
          return res.status(409).json({
            error: "Reservation hold has already expired and cannot be manually cancelled",
          });
        case "ALREADY_PROCESSED":
          return res.status(409).json({
            error: "Order was already cancelled or processed by another request",
          });
      }
    }

    return res.status(200).json({
      message: "Order cancelled successfully and inventory restored to stock",
      data: {
        orderId: result.orderId,
        status: result.status,
        availableStock: result.restoredStock,
      },
    });
  } catch (err) {
    return next(err);
  }
}
