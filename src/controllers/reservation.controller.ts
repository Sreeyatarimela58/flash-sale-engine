import type { Request, Response, NextFunction } from "express";
import { prisma } from "../db/prisma.js";
import {
  createReservationSchema,
  getReservationParamsSchema,
} from "../schemas/reservation.schema.js";

// Reservation hold window: 5 minutes
const RESERVATION_TTL_MS = 5 * 60 * 1000;

export async function createReservation(req: Request, res: Response, next: NextFunction) {
  try {
    const parseResult = createReservationSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
    }

    const { productId, userId, quantity } = parseResult.data;
    const expiresAt = new Date(Date.now() + RESERVATION_TTL_MS);

    // Atomic transaction ensuring concurrency protection
    const result = await prisma.$transaction(async (tx) => {
      // 1. Conditional Atomic Decrement:
      // Decrements stock IF AND ONLY IF availableStock >= quantity.
      // PostgreSQL takes an exclusive row lock on this product row during update.
      const updatedProducts = await tx.$queryRaw<Array<{ id: string; availableStock: number; name: string }>>`
        UPDATE "products"
        SET "availableStock" = "availableStock" - ${quantity},
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${productId}
          AND "availableStock" >= ${quantity}
        RETURNING "id", "availableStock", "name";
      `;

      // If no row was updated, either the product doesn't exist or stock was insufficient
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

      const updatedProduct = updatedProducts[0]!;

      // 2. Create the reservation record
      const reservation = await tx.reservation.create({
        data: {
          productId,
          userId,
          quantity,
          status: "RESERVED",
          expiresAt,
        },
      });

      return {
        reservation,
        remainingStock: updatedProduct.availableStock,
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
      message: "Inventory reserved successfully",
      data: {
        ...result.reservation,
        remainingStock: result.remainingStock,
      },
    });
  } catch (err) {
    return next(err);
  }
}

export async function getReservationById(req: Request, res: Response, next: NextFunction) {
  try {
    const parseResult = getReservationParamsSchema.safeParse(req.params);
    if (!parseResult.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
    }

    const { id } = parseResult.data;

    const reservation = await prisma.reservation.findUnique({
      where: { id },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            priceInCents: true,
          },
        },
      },
    });

    if (!reservation) {
      return res.status(404).json({ error: "Reservation not found" });
    }

    return res.status(200).json({ data: reservation });
  } catch (err) {
    return next(err);
  }
}
