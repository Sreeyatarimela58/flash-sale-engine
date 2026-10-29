import { app } from "../app.js";
import { prisma } from "../db/prisma.js";
import type { Server } from "node:http";

let server: Server;
const TEST_PORT = 3999;
const BASE_URL = `http://localhost:${TEST_PORT}`;

async function runTests() {
  console.log("=== Running Product API Integration Tests ===");

  await new Promise<void>((resolve) => {
    server = app.listen(TEST_PORT, () => {
      console.log(`Test server running on port ${TEST_PORT}`);
      resolve();
    });
  });

  try {
    // 1. Test GET /products
    console.log("\n[Test 1] GET /products");
    const listRes = await fetch(`${BASE_URL}/products`);
    if (listRes.status !== 200) throw new Error(`Expected 200, got ${listRes.status}`);
    const listJson = (await listRes.json()) as { data: Array<{ id: string; name: string }> };
    if (!Array.isArray(listJson.data)) throw new Error("Expected data to be an array");
    console.log(`✓ GET /products succeeded. Found ${listJson.data.length} products.`);

    // 2. Test POST /products (Valid creation)
    console.log("\n[Test 2] POST /products (Valid payload)");
    const newProductPayload = {
      name: "Nintendo Switch 2 Special Edition",
      description: "Next-gen hybrid console.",
      priceInCents: 44999,
      totalStock: 25,
    };
    const createRes = await fetch(`${BASE_URL}/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newProductPayload),
    });
    if (createRes.status !== 201) throw new Error(`Expected 201, got ${createRes.status}`);
    const createJson = (await createRes.json()) as { data: { id: string; availableStock: number; totalStock: number } };
    const createdId = createJson.data.id;
    if (createJson.data.availableStock !== 25 || createJson.data.totalStock !== 25) {
      throw new Error("availableStock or totalStock does not match initial stock");
    }
    console.log(`✓ POST /products created product with ID: ${createdId}`);

    // 3. Test GET /products/:id (Existing product)
    console.log("\n[Test 3] GET /products/:id (Existing product)");
    const getRes = await fetch(`${BASE_URL}/products/${createdId}`);
    if (getRes.status !== 200) throw new Error(`Expected 200, got ${getRes.status}`);
    const getJson = (await getRes.json()) as { data: { id: string; name: string } };
    if (getJson.data.name !== newProductPayload.name) throw new Error("Product name mismatch");
    console.log("✓ GET /products/:id returned expected product.");

    // 4. Test GET /products/:id (Non-existent UUID -> 404)
    console.log("\n[Test 4] GET /products/:id (Non-existent UUID)");
    const notFoundRes = await fetch(`${BASE_URL}/products/00000000-0000-0000-0000-000000000000`);
    if (notFoundRes.status !== 404) throw new Error(`Expected 404, got ${notFoundRes.status}`);
    console.log("✓ GET /products/:id correctly returned 404 for non-existent product.");

    // 5. Test GET /products/:id (Invalid UUID format -> 400)
    console.log("\n[Test 5] GET /products/:id (Invalid UUID format)");
    const badIdRes = await fetch(`${BASE_URL}/products/invalid-uuid-123`);
    if (badIdRes.status !== 400) throw new Error(`Expected 400, got ${badIdRes.status}`);
    console.log("✓ GET /products/:id correctly returned 400 for invalid UUID format.");

    // 6. Test POST /products (Validation error: negative stock -> 400)
    console.log("\n[Test 6] POST /products (Validation error: non-positive stock)");
    const invalidStockRes = await fetch(`${BASE_URL}/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Broken Product",
        priceInCents: 1000,
        totalStock: -5,
      }),
    });
    if (invalidStockRes.status !== 400) throw new Error(`Expected 400, got ${invalidStockRes.status}`);
    console.log("✓ POST /products correctly rejected negative stock with 400 Bad Request.");

    console.log("\n============================================");
    console.log("🎉 All Product API integration tests PASSED!");
    console.log("============================================\n");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect();
  }
}

runTests().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
