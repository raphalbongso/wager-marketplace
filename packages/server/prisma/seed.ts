import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding database...");

  // Create admin user
  const adminHash = await bcrypt.hash("admin123!", 12);
  const admin = await prisma.user.upsert({
    where: { email: "admin@wager.exchange" },
    update: {},
    create: {
      email: "admin@wager.exchange",
      passwordHash: adminHash,
      role: "ADMIN",
      wallet: { create: { balanceCents: 1_000_00 } }, // $1000
    },
  });
  console.log(`  Admin: ${admin.email} (${admin.id})`);

  // Create demo users
  const userHash = await bcrypt.hash("password123", 12);
  const alice = await prisma.user.upsert({
    where: { email: "alice@example.com" },
    update: {},
    create: {
      email: "alice@example.com",
      passwordHash: userHash,
      wallet: { create: { balanceCents: 500_00 } }, // $500
    },
  });
  console.log(`  Alice: ${alice.email} (${alice.id})`);

  const bob = await prisma.user.upsert({
    where: { email: "bob@example.com" },
    update: {},
    create: {
      email: "bob@example.com",
      passwordHash: userHash,
      wallet: { create: { balanceCents: 500_00 } }, // $500
    },
  });
  console.log(`  Bob: ${bob.email} (${bob.id})`);

  // Create sample markets
  const market1 = await prisma.market.upsert({
    where: { slug: "btc-100k-2026" },
    update: {},
    create: {
      slug: "btc-100k-2026",
      title: "Will Bitcoin reach $100K by end of 2026?",
      description: "Resolves YES if BTC/USD >= $100,000 on any major exchange before Dec 31, 2026 23:59 UTC.",
    },
  });
  console.log(`  Market: ${market1.slug} (${market1.id})`);

  const market2 = await prisma.market.upsert({
    where: { slug: "rain-tomorrow" },
    update: {},
    create: {
      slug: "rain-tomorrow",
      title: "Will it rain in NYC tomorrow?",
      description: "Resolves YES if official NWS records >= 0.01 inches of precipitation in Central Park.",
    },
  });
  console.log(`  Market: ${market2.slug} (${market2.id})`);

  const market3 = await prisma.market.upsert({
    where: { slug: "ai-agi-2027" },
    update: {},
    create: {
      slug: "ai-agi-2027",
      title: "Will AGI be achieved by 2027?",
      description: "Resolves YES if a credible research lab publicly claims AGI milestone. Admin oracle resolves.",
    },
  });
  console.log(`  Market: ${market3.slug} (${market3.id})`);

  // Platform fee wallet
  await prisma.platformFeeWallet.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", balanceCents: 0 },
    update: {},
  });

  console.log("\nSeed complete!");
  console.log("\nDemo credentials:");
  console.log("  Admin: admin@wager.exchange / admin123!");
  console.log("  Alice: alice@example.com / password123");
  console.log("  Bob:   bob@example.com / password123");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
