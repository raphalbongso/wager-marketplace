import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticate } from '../auth/middleware.js';
import { processOrder, cancelOrder, getBook } from '../engine/matching.js';
import { broadcast } from '../ws/handler.js';

const placeOrderSchema = z.object({
  side: z.enum(['BUY', 'SELL']),
  type: z.enum(['LIMIT', 'MARKET']),
  priceCents: z.number().int().min(1).max(99).optional(),
  qty: z.number().int().min(1).max(100_000),
  clientOrderId: z.string().max(64).optional(),
}).refine(
  (d) => d.type === 'MARKET' || d.priceCents !== undefined,
  { message: 'priceCents required for LIMIT orders', path: ['priceCents'] },
);

export async function orderRoutes(app: FastifyInstance) {
  // Place order
  app.post('/markets/:id/orders', { preHandler: authenticate }, async (req, reply) => {
    const { id: marketId } = req.params as { id: string };
    const parsed = placeOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    }

    const result = await processOrder(prisma, {
      marketId,
      userId: req.user!.sub,
      side: parsed.data.side,
      type: parsed.data.type,
      priceCents: parsed.data.priceCents,
      qty: parsed.data.qty,
      clientOrderId: parsed.data.clientOrderId,
    });

    if (result.status === 'REJECTED') {
      return reply.status(400).send({ error: result.reason, orderId: result.orderId });
    }

    // Broadcast book + trade updates via WebSocket
    if (result.trades.length > 0) {
      const book = getBook(marketId);
      broadcast(marketId, { type: 'book_snapshot', data: book.getBook(20) });
      for (const trade of result.trades) {
        broadcast(marketId, {
          type: 'trade',
          data: {
            priceCents: trade.priceCents,
            qty: trade.qty,
            takerSide: parsed.data.side,
            timestamp: new Date().toISOString(),
          },
        });
      }
    } else if (result.status === 'OPEN') {
      const book = getBook(marketId);
      broadcast(marketId, { type: 'book_snapshot', data: book.getBook(20) });
    }

    // Send order update to the user
    broadcast(marketId, {
      type: 'order_update',
      userId: req.user!.sub,
      data: {
        orderId: result.orderId,
        status: result.status,
        fills: result.trades.length,
      },
    });

    return reply.status(201).send(result);
  });

  // Cancel order
  app.post('/markets/:id/orders/:orderId/cancel', { preHandler: authenticate }, async (req, reply) => {
    const { id: marketId, orderId } = req.params as { id: string; orderId: string };

    const success = await cancelOrder(prisma, marketId, orderId, req.user!.sub);
    if (!success) {
      return reply.status(400).send({ error: 'Cannot cancel order (not found, not yours, or already filled)' });
    }

    const book = getBook(marketId);
    broadcast(marketId, { type: 'book_snapshot', data: book.getBook(20) });

    return reply.send({ success: true });
  });

  // Get my orders for a market
  app.get('/markets/:id/orders', { preHandler: authenticate }, async (req, reply) => {
    const { id: marketId } = req.params as { id: string };
    const orders = await prisma.order.findMany({
      where: { marketId, userId: req.user!.sub },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return reply.send(orders);
  });
}
