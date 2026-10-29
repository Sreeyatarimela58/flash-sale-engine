import { Router } from "express";
import {
  createReservation,
  getReservationById,
} from "../controllers/reservation.controller.js";

export const reservationRouter = Router();

reservationRouter.post("/", createReservation);
reservationRouter.get("/:id", getReservationById);
