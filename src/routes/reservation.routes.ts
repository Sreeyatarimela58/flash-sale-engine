import { Router } from "express";
import {
  createReservation,
  getReservationById,
  cancelReservation,
} from "../controllers/reservation.controller.js";

export const reservationRouter = Router();

reservationRouter.post("/", createReservation);
reservationRouter.get("/:id", getReservationById);
reservationRouter.post("/:id/cancel", cancelReservation);

