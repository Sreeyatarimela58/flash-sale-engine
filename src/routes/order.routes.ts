import { Router } from "express";
import {
  createOrder,
  getOrderById,
  cancelOrder,
} from "../controllers/order.controller.js";

export const orderRouter = Router();

orderRouter.post("/", createOrder);
orderRouter.get("/:id", getOrderById);
orderRouter.post("/:id/cancel", cancelOrder);
