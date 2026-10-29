import { app } from "../app.js";
import { prisma } from "../db/prisma.js";
import type { Server } from "node:http";

let server: Server;
const TEST_PORT = 3997;
const BASE_URL = `http://localhost:${TEST_PORT}`;

async function runTests() {
  console.log("=== Running Order & Reservation State Machine Tests ===");

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
        name: "Mechanical Gaming Keyboard RGB",
        description: "Special sale edition.",
        priceInCents: 15000, // $150.00
        totalStock: 20,
        availableStock: 20,
      },
    });

    // -------------------------------------------------------------
    // Test 1: Successful Order Creation from Active Reservation
    // -------------------------------------------------------------
    console.log("\n[Test 1] Valid Order Creation (RESERVED -> CONFIRMED & Order PENDING)");
    const resRes = await fetch(`${BASE_URL}/reservations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: product.id,
        userId: "user-buyer-1",
        quantity: 2,
      }),
    });
    if (resRes.status !== 201) throw new Error(`Reservation failed with ${resRes.status}`);
    const { data: reservation1 } = (await resRes.json()) as { data: { id: string } };

    const orderRes = await fetch(`${BASE_URL}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reservationId: reservation1.id,
        userId: "user-buyer-1",
      }),
    });
    if (orderRes.status !== 201) throw new Error(`Order creation failed with ${orderRes.status}`);
    const orderData = (await orderRes.json()) as {
      data: {
        order: { id: string; status: string; totalAmountInCents: number; quantity: number };
        reservationStatus: string;
      };
    };

    if (orderData.data.order.status !== "PENDING") {
      throw new Error(`Expected order status PENDING, got ${orderData.data.order.status}`);
    }
    if (orderData.data.order.totalAmountInCents !== 30000) {
      throw new Error(`Expected total 30000 cents, got ${orderData.data.order.totalAmountInCents}`);
    }

    // Verify DB state: reservation should now be CONFIRMED
    const dbReservation1 = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation1.id } });
    if (dbReservation1.status !== "CONFIRMED") {
      throw new Error(`Expected DB reservation CONFIRMED, found ${dbReservation1.status}`);
    }
    console.log("✓ Order created successfully. Reservation transitioned to CONFIRMED.");

    // -------------------------------------------------------------
    // Test 2: Cannot double-order on already CONFIRMED reservation
    // -------------------------------------------------------------
    console.log("\n[Test 2] Double-order prevention on CONFIRMED reservation");
    const duplicateOrderRes = await fetch(`${BASE_URL}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reservationId: reservation1.id,
        userId: "user-buyer-1",
      }),
    });
    if (duplicateOrderRes.status !== 409) {
      throw new Error(`Expected 409 on duplicate order, got ${duplicateOrderRes.status}`);
    }
    console.log("✓ Correctly rejected double-order attempt with 409 Conflict.");

    // -------------------------------------------------------------
    // Test 3: Unauthorized user attempting to convert someone else's reservation
    // -------------------------------------------------------------
    console.log("\n[Test 3] Authorization check: user-imposter ordering user-buyer-1's hold");
    const resRes2 = await fetch(`${BASE_URL}/reservations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: product.id,
        userId: "user-legit",
        quantity: 1,
      }),
    });
    const { data: reservation2 } = (await resRes2.json()) as { data: { id: string } };

    const imposterOrderRes = await fetch(`${BASE_URL}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reservationId: reservation2.id,
        userId: "user-imposter",
      }),
    });
    if (imposterOrderRes.status !== 403) {
      throw new Error(`Expected 403 Forbidden, got ${imposterOrderRes.status}`);
    }
    console.log("✓ Correctly rejected unauthorized user with 403 Forbidden.");

    // -------------------------------------------------------------
    // Test 4: Cannot order an EXPIRED reservation
    // -------------------------------------------------------------
    console.log("\n[Test 4] Cannot create order from an expired reservation");
    const expiredReservation = await prisma.reservation.create({
      data: {
        productId: product.id,
        userId: "user-late",
        quantity: 1,
        status: "RESERVED",
        expiresAt: new Date(Date.now() - 10000), // 10 seconds in the past
      },
    });

    const expiredOrderRes = await fetch(`${BASE_URL}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reservationId: expiredReservation.id,
        userId: "user-late",
      }),
    });
    if (expiredOrderRes.status !== 409) {
      throw new Error(`Expected 409 for expired hold, got ${expiredOrderRes.status}`);
    }
    console.log("✓ Correctly rejected expired reservation with 409 Conflict.");

    // -------------------------------------------------------------
    // Test 5: Manual Cancellation & Immediate Stock Restoration
    // -------------------------------------------------------------
    console.log("\n[Test 5] Manual reservation cancellation & stock restoration");
    const productBeforeCancel = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    const stockBefore = productBeforeCancel.availableStock;

    // Reserve 3 units
    const resCancel = await fetch(`${BASE_URL}/reservations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: product.id,
        userId: "user-canceller",
        quantity: 3,
      }),
    });
    const { data: reservationToCancel } = (await resCancel.json()) as { data: { id: string } };

    // Stock should have decreased by 3
    const productAfterHold = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    if (productAfterHold.availableStock !== stockBefore - 3) {
      throw new Error("Stock did not decrement after hold");
    }

    // Now cancel the reservation
    const cancelRes = await fetch(`${BASE_URL}/reservations/${reservationToCancel.id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-canceller" }),
    });
    if (cancelRes.status !== 200) {
      throw new Error(`Cancel failed with status ${cancelRes.status}`);
    }

    // Verify DB states: reservation is CANCELLED and product availableStock is fully restored
    const dbCancelledRes = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationToCancel.id } });
    if (dbCancelledRes.status !== "CANCELLED") {
      throw new Error(`Expected CANCELLED status, found ${dbCancelledRes.status}`);
    }

    const productAfterCancel = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    if (productAfterCancel.availableStock !== stockBefore) {
      throw new Error(`Expected stock ${stockBefore} after cancel, found ${productAfterCancel.availableStock}`);
    }
    console.log("✓ Reservation cancelled. Status = CANCELLED. Available stock restored in DB.");

    // -------------------------------------------------------------
    // Test 6: Cannot create order on CANCELLED reservation
    // -------------------------------------------------------------
    console.log("\n[Test 6] Cannot order on CANCELLED reservation");
    const cancelledOrderRes = await fetch(`${BASE_URL}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reservationId: reservationToCancel.id,
        userId: "user-canceller",
      }),
    });
    if (cancelledOrderRes.status !== 409) {
      throw new Error(`Expected 409 for cancelled hold, got ${cancelledOrderRes.status}`);
    }
    console.log("✓ Correctly rejected order on cancelled reservation with 409 Conflict.");

    console.log("\n========================================================");
    console.log("🎉 All Order & Reservation State Machine Tests PASSED!");
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
