import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticate, requireAdmin } from '../auth/middleware.js';
import { settleMarket } from '../engine/settlement.js';
import { getBook } from '../engine/matching.js';

const createMarketSchema = z.object({
  slug: z.string().min(3).max(100).regex(/^[a-z0-9-]+$/),
  title: z.string().min(3).max(500),
  description: z.string().max(5000).optional(),
  tickSizeCents: z.number().int().min(1).max(10).optional(),
});

const resolveSchema = z.object({
  resolvesTo: z.enum(['YES', 'NO']),
});

export async function marketRoutes(app: FastifyInstance) {
  // Create market (admin)
  app.post('/markets', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = createMarketSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    }

    const existing = await prisma.market.findUnique({ where: { slug: parsed.data.slug } });
    if (existing) {
      return reply.status(409).send({ error: 'Slug already exists' });
    }

    const market = await prisma.market.create({
      data: {
        slug: parsed.data.slug,
        title: parsed.data.title,
        description: parsed.data.description,
        tickSizeCents: parsed.data.tickSizeCents ?? 1,
      },
    });

    await prisma.eventLog.create({
      data: {
        marketId: market.id,
        type: 'MarketCreated',
        payload: {
          slug: market.slug,
          title: market.title,
          adminUserId: req.user!.sub,
        },
      },
    });

    return reply.status(201).send(market);
  });

  // List markets
  app.get('/markets', async (_req, reply) => {
    const markets = await prisma.market.findMany({
      orderBy: { createdAt: 'desc' },
    });

    // Enrich with book data
    const enriched = markets.map((m) => {
      if (m.status === 'OPEN') {
        const book = getBook(m.id);
        return {
          ...m,
          bestBid: book.bestBid(),
          bestAsk: book.bestAsk(),
        };
      }
      return { ...m, bestBid: null, bestAsk: null };
    });

    return reply.send(enriched);
  });

  // Get market detail
  app.get('/markets/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const market = await prisma.market.findUnique({ where: { id } });
    if (!market) return reply.status(404).send({ error: 'Market not found' });

    let bookData = null;
    if (market.status === 'OPEN') {
      const book = getBook(market.id);
      bookData = book.getBook(20);
    }

    const recentTrades = await prisma.trade.findMany({
      where: { marketId: id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    return reply.send({ ...market, book: bookData, recentTrades });
  });

  // Resolve market (admin)
  app.post('/markets/:id/resolve', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = resolveSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed' });
    }

    try {
      const result = await settleMarket(prisma, id, parsed.data.resolvesTo, req.user!.sub);
      return reply.send(result);
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // Get order book
  app.get('/markets/:id/book', async (req, reply) => {
    const { id } = req.params as { id: string };
    const market = await prisma.market.findUnique({ where: { id } });
    if (!market) return reply.status(404).send({ error: 'Market not found' });

    const book = getBook(id);
    return reply.send(book.getBook(20));
  });

  // Get recent trades
  app.get('/markets/:id/trades', async (req, reply) => {
    const { id } = req.params as { id: string };
    const trades = await prisma.trade.findMany({
      where: { marketId: id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return reply.send(trades);
  });
}
