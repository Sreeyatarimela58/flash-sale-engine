import type { Request, Response, NextFunction } from "express";
import { prisma } from "../db/prisma.js";
import { createProductSchema, getProductParamsSchema } from "../schemas/product.schema.js";

export async function createProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const parseResult = createProductSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
    }

    const { name, description, priceInCents, totalStock } = parseResult.data;

    const product = await prisma.product.create({
      data: {
        name,
        description: description ?? null,
        priceInCents,
        totalStock,
        availableStock: totalStock, // Available stock initially equals total stock
      },
    });

    return res.status(201).json({
      message: "Product created successfully",
      data: product,
    });
  } catch (err) {
    return next(err);
  }
}

export async function listProducts(_req: Request, res: Response, next: NextFunction) {
  try {
    const products = await prisma.product.findMany({
      orderBy: { createdAt: "desc" },
    });

    return res.status(200).json({
      data: products,
    });
  } catch (err) {
    return next(err);
  }
}

export async function getProductById(req: Request, res: Response, next: NextFunction) {
  try {
    const parseResult = getProductParamsSchema.safeParse(req.params);
    if (!parseResult.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
    }

    const { id } = parseResult.data;

    const product = await prisma.product.findUnique({
      where: { id },
    });

    if (!product) {
      return res.status(404).json({
        error: "Product not found",
      });
    }

    return res.status(200).json({
      data: product,
    });
  } catch (err) {
    return next(err);
  }
}
