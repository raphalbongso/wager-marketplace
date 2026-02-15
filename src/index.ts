import 'dotenv/config';
import { config } from './config.js';
import { buildServer } from './server.js';
import { prisma } from './lib/prisma.js';
import { rebuildAllBooks } from './engine/matching.js';
import { log } from './lib/logger.js';

async function main() {
  log('info', 'Starting Wager Market Exchange...');

  // Rebuild order books from DB state
  await rebuildAllBooks(prisma);

  // Ensure platform fee wallet exists
  await prisma.platformFeeWallet.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', balanceCents: 0 },
    update: {},
  });

  const app = await buildServer();

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    log('info', `Server listening on http://${config.HOST}:${config.PORT}`);
  } catch (err) {
    log('error', 'Failed to start server', { error: String(err) });
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async () => {
    log('info', 'Shutting down...');
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
