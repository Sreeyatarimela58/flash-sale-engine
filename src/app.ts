import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { healthRouter } from "./routes/health.routes.js";
import { productRouter } from "./routes/product.routes.js";
import { reservationRouter } from "./routes/reservation.routes.js";
import { orderRouter } from "./routes/order.routes.js";

export const app = express();

app.use(cors());
app.use(express.json());

// Routes
app.use("/health", healthRouter);
app.use("/products", productRouter);
app.use("/reservations", reservationRouter);
app.use("/orders", orderRouter);

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Route not found" });
});

// Global error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});
