import { z } from "zod";

export const createReservationSchema = z.object({
  productId: z.string().uuid("Invalid product ID format. Must be a valid UUID"),
  userId: z.string().trim().min(1, "User ID is required"),
  quantity: z.number().int().positive("Quantity must be a positive integer").max(10, "Maximum 10 units per reservation"),
});

export const getReservationParamsSchema = z.object({
  id: z.string().uuid("Invalid reservation ID format. Must be a valid UUID"),
});

export type CreateReservationInput = z.infer<typeof createReservationSchema>;
