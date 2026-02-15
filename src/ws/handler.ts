/**
 * WebSocket handler for real-time market data.
 *
 * Clients connect to /ws?market_id=<id>&token=<jwt_optional>
 *
 * Server emits:
 *   - book_snapshot: full order book on connect and on changes
 *   - trade: last trade
 *   - order_update: for authenticated user's own orders
 */

import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { verifyToken, type JwtPayload } from '../auth/jwt.js';
import { getBook } from '../engine/matching.js';
import { log } from '../lib/logger.js';

interface WsClient {
  ws: WebSocket;
  marketId: string;
  userId?: string;
}

const clients: WsClient[] = [];

export function broadcast(marketId: string, message: { type: string; userId?: string; data: any }) {
  const payload = JSON.stringify({ v: 1, ...message });
  for (const client of clients) {
    if (client.ws.readyState !== 1) continue; // OPEN
    if (client.marketId !== marketId) continue;
    // If message has userId filter, only send to that user
    if (message.userId && client.userId !== message.userId) continue;
    try {
      client.ws.send(payload);
    } catch {
      // Client disconnected
    }
  }
}

export async function wsRoutes(app: FastifyInstance) {
  app.get('/ws', { websocket: true }, (socket, req) => {
    const ws = socket as unknown as WebSocket;
    const query = req.query as { market_id?: string; token?: string };
    const marketId = query.market_id;

    if (!marketId) {
      ws.close(4000, 'market_id query param required');
      return;
    }

    let userId: string | undefined;
    if (query.token) {
      try {
        const payload = verifyToken(query.token);
        userId = payload.sub;
      } catch {
        // Not authenticated, that's fine for public data
      }
    }

    const client: WsClient = { ws, marketId, userId };
    clients.push(client);

    log('info', 'WS connected', { marketId, userId });

    // Send initial book snapshot
    const book = getBook(marketId);
    const snapshot = book.getBook(20);
    ws.send(JSON.stringify({ v: 1, type: 'book_snapshot', data: snapshot }));

    ws.on('close', () => {
      const idx = clients.indexOf(client);
      if (idx !== -1) clients.splice(idx, 1);
      log('info', 'WS disconnected', { marketId, userId });
    });

    ws.on('error', () => {
      const idx = clients.indexOf(client);
      if (idx !== -1) clients.splice(idx, 1);
    });

    // We don't expect client messages in v1, but handle ping
    ws.on('message', (data) => {
      const msg = data.toString();
      if (msg === 'ping') {
        ws.send('pong');
      }
    });
  });
}
