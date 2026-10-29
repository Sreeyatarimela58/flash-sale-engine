import { z } from "zod";

export const createOrderSchema = z.object({
  productId: z.string().uuid("Invalid product ID format. Must be a valid UUID"),
  userId: z.string().trim().min(1, "User ID is required"),
  quantity: z.number().int().positive("Quantity must be a positive integer").max(10, "Maximum 10 units per order"),
});

export const getOrderParamsSchema = z.object({
  id: z.string().uuid("Invalid order ID format. Must be a valid UUID"),
});

export const cancelOrderSchema = z.object({
  userId: z.string().trim().min(1, "User ID is required"),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type CancelOrderInput = z.infer<typeof cancelOrderSchema>;
