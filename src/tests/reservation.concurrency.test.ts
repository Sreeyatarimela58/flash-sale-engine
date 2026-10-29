import { app } from "../app.js";
import { prisma } from "../db/prisma.js";
import type { Server } from "node:http";

let server: Server;
const TEST_PORT = 3998;
const BASE_URL = `http://localhost:${TEST_PORT}`;

async function runTests() {
  console.log("=== Running Reservation & Concurrency Integration Tests ===");

  await new Promise<void>((resolve) => {
    server = app.listen(TEST_PORT, () => {
      console.log(`Test server running on port ${TEST_PORT}`);
      resolve();
    });
  });

  try {
    // -------------------------------------------------------------
    // Setup: Create a test product
    // -------------------------------------------------------------
    const testProduct = await prisma.product.create({
      data: {
        name: "Limited Edition Collector Watch",
        description: "Only 10 available worldwide.",
        priceInCents: 50000,
        totalStock: 10,
        availableStock: 10,
      },
    });

    // -------------------------------------------------------------
    // Test 1: Single valid reservation
    // -------------------------------------------------------------
    console.log("\n[Test 1] Single valid reservation");
    const res1 = await fetch(`${BASE_URL}/reservations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: testProduct.id,
        userId: "user-alpha-1",
        quantity: 2,
      }),
    });
    if (res1.status !== 201) throw new Error(`Expected 201, got ${res1.status}`);
    const res1Data = (await res1.json()) as { data: { id: string; status: string; remainingStock: number } };
    if (res1Data.data.status !== "RESERVED") throw new Error("Status should be RESERVED");
    if (res1Data.data.remainingStock !== 8) throw new Error("Remaining stock should be 8");
    console.log(`✓ Single reservation created. Remaining stock: ${res1Data.data.remainingStock}`);

    // Verify database state directly
    const productAfterRes1 = await prisma.product.findUniqueOrThrow({ where: { id: testProduct.id } });
    if (productAfterRes1.availableStock !== 8) {
      throw new Error(`DB availableStock expected 8, found ${productAfterRes1.availableStock}`);
    }
    console.log("✓ Database availableStock verified in PostgreSQL.");

    // -------------------------------------------------------------
    // Test 2: Validation errors (negative quantity & missing fields)
    // -------------------------------------------------------------
    console.log("\n[Test 2] Validation rejection for non-positive quantity");
    const badReqRes = await fetch(`${BASE_URL}/reservations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: testProduct.id,
        userId: "user-bad",
        quantity: -1,
      }),
    });
    if (badReqRes.status !== 400) throw new Error(`Expected 400, got ${badReqRes.status}`);
    console.log("✓ Correctly rejected non-positive quantity with 400 Bad Request.");

    // -------------------------------------------------------------
    // Test 3: Insufficient stock (requesting more than available)
    // -------------------------------------------------------------
    console.log("\n[Test 3] Insufficient inventory rejection");
    const overRequestRes = await fetch(`${BASE_URL}/reservations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: testProduct.id,
        userId: "user-greedy",
        quantity: 10, // Only 8 available
      }),
    });
    if (overRequestRes.status !== 409) throw new Error(`Expected 409, got ${overRequestRes.status}`);
    console.log("✓ Correctly rejected over-quantity request with 409 Conflict.");

    // -------------------------------------------------------------
    // Test 4: HIGH-CONCURRENCY RACE CONDITION TEST
    // -------------------------------------------------------------
    console.log("\n[Test 4] High-concurrency test: 30 concurrent users fighting for 5 available items");

    const flashProduct = await prisma.product.create({
      data: {
        name: "Golden Ticket - Flash Drop",
        description: "Extremely limited. High contention test.",
        priceInCents: 9900,
        totalStock: 5,
        availableStock: 5,
      },
    });

    const CONCURRENT_REQUESTS = 30;
    console.log(`Firing ${CONCURRENT_REQUESTS} parallel reservation requests simultaneously...`);

    const requests = Array.from({ length: CONCURRENT_REQUESTS }, (_, index) => {
      return fetch(`${BASE_URL}/reservations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: flashProduct.id,
          userId: `concurrent-user-${index + 1}`,
          quantity: 1,
        }),
      });
    });

    const responses = await Promise.all(requests);
    const statusCodes = responses.map((r) => r.status);

    const successCount = statusCodes.filter((s) => s === 201).length;
    const conflictCount = statusCodes.filter((s) => s === 409).length;

    console.log(`Results: ${successCount} succeeded (201), ${conflictCount} rejected (409).`);

    // Invariant 1: Exactly 5 requests must succeed
    if (successCount !== 5) {
      throw new Error(`CRITICAL CONCURRENCY FAILURE: Expected 5 successes, got ${successCount}`);
    }

    // Invariant 2: Exactly 25 requests must fail with 409 Conflict
    if (conflictCount !== 25) {
      throw new Error(`CRITICAL CONCURRENCY FAILURE: Expected 25 conflicts, got ${conflictCount}`);
    }

    // Invariant 3: Database available stock must be EXACTLY 0, not negative
    const flashProductInDb = await prisma.product.findUniqueOrThrow({ where: { id: flashProduct.id } });
    if (flashProductInDb.availableStock !== 0) {
      throw new Error(`CRITICAL INVARIANT FAILURE: availableStock should be 0, found ${flashProductInDb.availableStock}`);
    }

    // Invariant 4: Total reservations created for this product must equal 5
    const reservationsCount = await prisma.reservation.count({
      where: { productId: flashProduct.id, status: "RESERVED" },
    });
    if (reservationsCount !== 5) {
      throw new Error(`CRITICAL INVARIANT FAILURE: Expected 5 reservations, found ${reservationsCount}`);
    }

    console.log("✓ Invariant verified: availableStock is exactly 0. Zero overselling occurred.");
    console.log("✓ Invariant verified: exactly 5 reservations recorded in PostgreSQL.");

    console.log("\n========================================================");
    console.log("🎉 All Reservation Concurrency Tests PASSED Successfully!");
    console.log("========================================================\n");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect();
  }
}

runTests().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
