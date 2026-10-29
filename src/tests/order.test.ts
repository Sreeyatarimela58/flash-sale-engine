import { app } from "../app.js";
import { prisma } from "../db/prisma.js";
import type { Server } from "node:http";

let server: Server;
const TEST_PORT = 3996;
const BASE_URL = `http://localhost:${TEST_PORT}`;

async function runTests() {
  console.log("=== Running Unified Order Checkout & Lifecycle Integration Tests ===");

  await new Promise<void>((resolve) => {
    server = app.listen(TEST_PORT, () => {
      console.log(`Test server running on port ${TEST_PORT}`);
      resolve();
    });
  });

  try {
    // -------------------------------------------------------------
    // Setup: Seed a product for testing orders
    // -------------------------------------------------------------
    const product = await prisma.product.create({
      data: {
        name: "PlayStation Portal Remote Player",
        description: "Flash drop exclusive bundle.",
        priceInCents: 19999, // $199.99
        totalStock: 10,
        availableStock: 10,
      },
    });

    // -------------------------------------------------------------
    // Test 1: Unified "Buy Now" Checkout
    // (Stock atomically held + Reservation created + Order created PENDING)
    // -------------------------------------------------------------
    console.log("\n[Test 1] Unified 'Buy Now' Checkout (POST /orders)");
    const checkoutRes = await fetch(`${BASE_URL}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: product.id,
        userId: "user-buyer-1",
        quantity: 2,
      }),
    });
    if (checkoutRes.status !== 201) throw new Error(`Expected 201, got ${checkoutRes.status}`);
    const checkoutData = (await checkoutRes.json()) as {
      data: {
        order: { id: string; status: string; totalAmountInCents: number; reservationId: string };
        reservation: { id: string; status: string; expiresAt: string };
        remainingStock: number;
      };
    };

    if (checkoutData.data.order.status !== "PENDING") {
      throw new Error(`Expected order status PENDING, got ${checkoutData.data.order.status}`);
    }
    if (checkoutData.data.order.totalAmountInCents !== 39998) {
      throw new Error(`Expected total 39998 cents, got ${checkoutData.data.order.totalAmountInCents}`);
    }
    if (checkoutData.data.reservation.status !== "RESERVED") {
      throw new Error(`Expected reservation status RESERVED, got ${checkoutData.data.reservation.status}`);
    }
    if (checkoutData.data.remainingStock !== 8) {
      throw new Error(`Expected remaining stock 8, got ${checkoutData.data.remainingStock}`);
    }

    // Verify DB states directly in PostgreSQL
    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: checkoutData.data.order.id } });
    const dbReservation = await prisma.reservation.findUniqueOrThrow({ where: { id: dbOrder.reservationId } });
    const dbProduct = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });

    if (dbOrder.status !== "PENDING" || dbReservation.status !== "RESERVED" || dbProduct.availableStock !== 8) {
      throw new Error("PostgreSQL state mismatch after unified checkout");
    }
    console.log("✓ Unified order created. Internal reservation active (RESERVED) with 5-min timer. DB stock: 8.");

    // -------------------------------------------------------------
    // Test 2: Input validation
    // -------------------------------------------------------------
    console.log("\n[Test 2] Input validation: non-positive quantity rejected");
    const badInputRes = await fetch(`${BASE_URL}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: product.id,
        userId: "user-buyer-1",
        quantity: 0,
      }),
    });
    if (badInputRes.status !== 400) throw new Error(`Expected 400, got ${badInputRes.status}`);
    console.log("✓ Correctly rejected non-positive quantity with 400 Bad Request.");

    // -------------------------------------------------------------
    // Test 3: Insufficient stock rejection
    // -------------------------------------------------------------
    console.log("\n[Test 3] Insufficient inventory rejection");
    const overstockRes = await fetch(`${BASE_URL}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: product.id,
        userId: "user-greedy",
        quantity: 9, // Only 8 left
      }),
    });
    if (overstockRes.status !== 409) throw new Error(`Expected 409, got ${overstockRes.status}`);
    console.log("✓ Correctly rejected checkout exceeding available inventory with 409 Conflict.");

    // -------------------------------------------------------------
    // Test 4: HIGH-CONCURRENCY UNIFIED CHECKOUT RUSH
    // -------------------------------------------------------------
    console.log("\n[Test 4] High-concurrency flash sale rush: 30 parallel users buying 5 items");
    const flashItem = await prisma.product.create({
      data: {
        name: "Yeezy Boost 350 V2 - Midnight Black Drop",
        description: "Extremely limited supply.",
        priceInCents: 22000,
        totalStock: 5,
        availableStock: 5,
      },
    });

    const requests = Array.from({ length: 30 }, (_, index) => {
      return fetch(`${BASE_URL}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: flashItem.id,
          userId: `flash-user-${index + 1}`,
          quantity: 1,
        }),
      });
    });

    const responses = await Promise.all(requests);
    const successCount = responses.filter((r) => r.status === 201).length;
    const conflictCount = responses.filter((r) => r.status === 409).length;

    console.log(`Results: ${successCount} orders created (201), ${conflictCount} rejected (409).`);

    if (successCount !== 5 || conflictCount !== 25) {
      throw new Error(`CONCURRENCY INVARIANT BROKEN: Expected 5 successes and 25 conflicts.`);
    }

    // Verify DB stock is exactly 0
    const flashItemDb = await prisma.product.findUniqueOrThrow({ where: { id: flashItem.id } });
    if (flashItemDb.availableStock !== 0) {
      throw new Error(`Stock mismatch: Expected 0, found ${flashItemDb.availableStock}`);
    }

    const orderCount = await prisma.order.count({ where: { productId: flashItem.id } });
    if (orderCount !== 5) {
      throw new Error(`Expected 5 orders in DB, found ${orderCount}`);
    }
    console.log("✓ Concurrency invariant verified: exactly 5 orders created, 0 overselling, DB stock = 0.");

    // -------------------------------------------------------------
    // Test 5: Order Cancellation & Stock Restoration
    // -------------------------------------------------------------
    console.log("\n[Test 5] Order Cancellation restores stock");
    const stockBeforeCancel = (await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).availableStock;

    // Create a 1-item order to cancel
    const cancelOrderSetup = await fetch(`${BASE_URL}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: product.id,
        userId: "user-canceller",
        quantity: 1,
      }),
    });
    const { data: orderToCancel } = (await cancelOrderSetup.json()) as { data: { order: { id: string } } };

    // Stock should now be stockBeforeCancel - 1
    const stockDuringHold = (await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).availableStock;
    if (stockDuringHold !== stockBeforeCancel - 1) throw new Error("Stock did not decrement for order");

    // Cancel order
    const cancelRes = await fetch(`${BASE_URL}/orders/${orderToCancel.order.id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-canceller" }),
    });
    if (cancelRes.status !== 200) throw new Error(`Cancel returned ${cancelRes.status}`);

    // Verify stock is restored
    const stockAfterCancel = (await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).availableStock;
    if (stockAfterCancel !== stockBeforeCancel) {
      throw new Error(`Stock not restored: Expected ${stockBeforeCancel}, got ${stockAfterCancel}`);
    }

    const dbCancelledOrder = await prisma.order.findUniqueOrThrow({
      where: { id: orderToCancel.order.id },
      include: { reservation: true },
    });
    if (dbCancelledOrder.status !== "CANCELLED" || dbCancelledOrder.reservation.status !== "CANCELLED") {
      throw new Error("Order or reservation was not marked CANCELLED");
    }
    console.log("✓ Order and linked reservation marked CANCELLED. Inventory immediately returned to product.");

    // -------------------------------------------------------------
    // Test 6: Security & Idempotency: Imposter cancel & Double-cancel
    // -------------------------------------------------------------
    console.log("\n[Test 6] Security & State invariants: unauthorized cancel and re-cancel rejected");
    const imposterCancel = await fetch(`${BASE_URL}/orders/${orderToCancel.order.id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-imposter" }),
    });
    if (imposterCancel.status !== 403) throw new Error(`Expected 403, got ${imposterCancel.status}`);

    const doubleCancel = await fetch(`${BASE_URL}/orders/${orderToCancel.order.id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-canceller" }),
    });
    if (doubleCancel.status !== 409) throw new Error(`Expected 409, got ${doubleCancel.status}`);
    console.log("✓ Imposter cancel rejected with 403. Re-cancellation rejected with 409.");

    console.log("\n========================================================");
    console.log("🎉 All Unified Order Integration Tests PASSED!");
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
