import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebSocket from '@fastify/websocket';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { config } from './config.js';
import { requestLogger } from './lib/logger.js';
import { authRoutes } from './routes/auth.js';
import { walletRoutes } from './routes/wallet.js';
import { marketRoutes } from './routes/markets.js';
import { orderRoutes } from './routes/orders.js';
import { anchorBetRoutes } from './routes/anchor-bets.js';
import { adminRoutes } from './routes/admin.js';
import { wsRoutes } from './ws/handler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function buildServer() {
  const app = Fastify({
    logger: false, // We use our own structured logger
  });

  // Plugins
  await app.register(cors, { origin: true });
  await app.register(fastifyWebSocket);

  // Serve static admin UI
  await app.register(fastifyStatic, {
    root: path.join(__dirname, '..', 'public'),
    prefix: '/',
  });

  // Request logging
  app.addHook('onRequest', requestLogger);

  // Health check
  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  // API Routes
  await app.register(authRoutes);
  await app.register(walletRoutes);
  await app.register(marketRoutes);
  await app.register(orderRoutes);
  await app.register(anchorBetRoutes);
  await app.register(adminRoutes);

  // WebSocket
  await app.register(wsRoutes);

  return app;
}
