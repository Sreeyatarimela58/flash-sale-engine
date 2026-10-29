import { z } from "zod";

export const createProductSchema = z.object({
  name: z.string().trim().min(1, "Product name is required").max(255),
  description: z.string().trim().optional(),
  priceInCents: z.number().int().nonnegative("Price must be a non-negative integer in cents"),
  totalStock: z.number().int().positive("Initial stock must be greater than 0"),
});

export const getProductParamsSchema = z.object({
  id: z.string().uuid("Invalid product ID format. Must be a valid UUID"),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;
