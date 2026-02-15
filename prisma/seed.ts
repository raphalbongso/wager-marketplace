import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // Create admin
  const adminHash = await bcrypt.hash('admin123', 12);
  const admin = await prisma.user.upsert({
    where: { email: 'admin@wagermarket.com' },
    update: {},
    create: {
      email: 'admin@wagermarket.com',
      passwordHash: adminHash,
      role: 'ADMIN',
      wallet: { create: { balanceCents: 1_000_000 } }, // $10,000
    },
  });
  console.log(`  Admin: ${admin.email} (${admin.id})`);

  // Create demo users
  const userHash = await bcrypt.hash('user123', 12);

  const alice = await prisma.user.upsert({
    where: { email: 'alice@example.com' },
    update: {},
    create: {
      email: 'alice@example.com',
      passwordHash: userHash,
      wallet: { create: { balanceCents: 500_000 } }, // $5,000
    },
  });
  console.log(`  User: ${alice.email} (${alice.id})`);

  const bob = await prisma.user.upsert({
    where: { email: 'bob@example.com' },
    update: {},
    create: {
      email: 'bob@example.com',
      passwordHash: userHash,
      wallet: { create: { balanceCents: 500_000 } }, // $5,000
    },
  });
  console.log(`  User: ${bob.email} (${bob.id})`);

  const charlie = await prisma.user.upsert({
    where: { email: 'charlie@example.com' },
    update: {},
    create: {
      email: 'charlie@example.com',
      passwordHash: userHash,
      wallet: { create: { balanceCents: 250_000 } }, // $2,500
    },
  });
  console.log(`  User: ${charlie.email} (${charlie.id})`);

  // Create sample markets
  const market1 = await prisma.market.upsert({
    where: { slug: 'btc-100k-by-march' },
    update: {},
    create: {
      slug: 'btc-100k-by-march',
      title: 'Will Bitcoin hit $100K by March 2026?',
      description: 'Resolves YES if BTC/USD trades above $100,000 on any major exchange before April 1, 2026.',
      tickSizeCents: 1,
    },
  });
  console.log(`  Market: ${market1.title} (${market1.id})`);

  const market2 = await prisma.market.upsert({
    where: { slug: 'fed-rate-cut-q1' },
    update: {},
    create: {
      slug: 'fed-rate-cut-q1',
      title: 'Will the Fed cut rates in Q1 2026?',
      description: 'Resolves YES if the Federal Reserve announces a rate cut at any FOMC meeting in Q1 2026.',
      tickSizeCents: 1,
    },
  });
  console.log(`  Market: ${market2.title} (${market2.id})`);

  const market3 = await prisma.market.upsert({
    where: { slug: 'rain-amsterdam-tomorrow' },
    update: {},
    create: {
      slug: 'rain-amsterdam-tomorrow',
      title: 'Will it rain in Amsterdam tomorrow?',
      description: 'Resolves YES if measurable precipitation (>0.1mm) is recorded at Schiphol weather station.',
      tickSizeCents: 5,
    },
  });
  console.log(`  Market: ${market3.title} (${market3.id})`);

  // Create platform fee wallet
  await prisma.platformFeeWallet.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', balanceCents: 0 },
    update: {},
  });

  // Create a sample anchor bet
  const anchor = await prisma.anchorBet.create({
    data: {
      creatorUserId: alice.id,
      opponentUserId: bob.id,
      title: 'Arsenal wins Premier League 2025/26',
      rulesText: 'Resolves YES if Arsenal FC finishes 1st in the English Premier League 2025/26 season.',
      status: 'OPEN',
    },
  });
  console.log(`  AnchorBet: ${anchor.title} (${anchor.id})`);

  // Add a side bet
  await prisma.sideBet.create({
    data: {
      anchorBetId: anchor.id,
      userId: charlie.id,
      direction: 'YES',
      amountCents: 10_000,
    },
  });

  console.log('\nSeed complete!');
  console.log('\nDemo accounts:');
  console.log('  admin@wagermarket.com / admin123 (ADMIN, $10,000)');
  console.log('  alice@example.com / user123 (USER, $5,000)');
  console.log('  bob@example.com / user123 (USER, $5,000)');
  console.log('  charlie@example.com / user123 (USER, $2,500)');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
