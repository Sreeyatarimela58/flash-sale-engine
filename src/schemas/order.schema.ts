import { z } from "zod";

export const createOrderSchema = z.object({
  reservationId: z.string().uuid("Invalid reservation ID format. Must be a valid UUID"),
  userId: z.string().trim().min(1, "User ID is required"),
});

export const getOrderParamsSchema = z.object({
  id: z.string().uuid("Invalid order ID format. Must be a valid UUID"),
});

export const cancelReservationSchema = z.object({
  userId: z.string().trim().min(1, "User ID is required"),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
