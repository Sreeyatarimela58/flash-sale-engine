import { prisma } from "../db/prisma.js";

async function main() {
  console.log("Seeding flash sale products...");

  // Clean up existing products for a fresh seed
  await prisma.payment.deleteMany();
  await prisma.order.deleteMany();
  await prisma.reservation.deleteMany();
  await prisma.product.deleteMany();

  const product1 = await prisma.product.create({
    data: {
      name: "PlayStation 5 Pro - 30th Anniversary Limited Edition",
      description: "Ultra-rare limited edition flash sale bundle. Maximum 1 per customer.",
      priceInCents: 99999, // $999.99
      totalStock: 50,
      availableStock: 50,
    },
  });

  const product2 = await prisma.product.create({
    data: {
      name: "NVIDIA GeForce RTX 5090 Founders Edition",
      description: "Next-gen flagship GPU. Flash sale special pricing.",
      priceInCents: 199999, // $1999.99
      totalStock: 10,
      availableStock: 10,
    },
  });

  console.log("Seeded products:");
  console.log(`- ${product1.name} (Stock: ${product1.availableStock}, ID: ${product1.id})`);
  console.log(`- ${product2.name} (Stock: ${product2.availableStock}, ID: ${product2.id})`);
}

main()
  .catch((e) => {
    console.error("Error during seeding:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
