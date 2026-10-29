import { Router } from "express";
import {
  createProduct,
  listProducts,
  getProductById,
} from "../controllers/product.controller.js";

export const productRouter = Router();

productRouter.post("/", createProduct);
productRouter.get("/", listProducts);
productRouter.get("/:id", getProductById);
