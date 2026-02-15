import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticate, requireAdmin } from '../auth/middleware.js';

const createAnchorSchema = z.object({
  title: z.string().min(3).max(500),
  rulesText: z.string().min(10).max(5000),
  opponentUserId: z.string().uuid().optional(),
  arbitratorUserId: z.string().uuid().optional(),
});

const sideBetSchema = z.object({
  direction: z.enum(['YES', 'NO']),
  amountCents: z.number().int().min(100).max(10_000_000),
});

const promoteSchema = z.object({
  slug: z.string().min(3).max(100).regex(/^[a-z0-9-]+$/),
  title: z.string().min(3).max(500),
  thresholdCents: z.number().int().min(0).optional(),
});

export async function anchorBetRoutes(app: FastifyInstance) {
  // Create anchor bet
  app.post('/anchor-bets', { preHandler: authenticate }, async (req, reply) => {
    const parsed = createAnchorSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    }

    const anchorBet = await prisma.anchorBet.create({
      data: {
        creatorUserId: req.user!.sub,
        opponentUserId: parsed.data.opponentUserId,
        title: parsed.data.title,
        rulesText: parsed.data.rulesText,
        arbitratorUserId: parsed.data.arbitratorUserId,
      },
    });

    await prisma.eventLog.create({
      data: {
        type: 'AnchorBetCreated',
        payload: { anchorBetId: anchorBet.id, creatorUserId: req.user!.sub },
      },
    });

    return reply.status(201).send(anchorBet);
  });

  // Add side bet
  app.post('/anchor-bets/:id/side-bets', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = sideBetSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    }

    const anchor = await prisma.anchorBet.findUnique({ where: { id } });
    if (!anchor || anchor.status !== 'OPEN') {
      return reply.status(404).send({ error: 'Anchor bet not found or not open' });
    }

    const sideBet = await prisma.sideBet.create({
      data: {
        anchorBetId: id,
        userId: req.user!.sub,
        direction: parsed.data.direction,
        amountCents: parsed.data.amountCents,
      },
    });

    return reply.status(201).send(sideBet);
  });

  // Promote anchor bet to market (admin)
  app.post('/anchor-bets/:id/promote', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = promoteSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    }

    const anchor = await prisma.anchorBet.findUnique({
      where: { id },
      include: { sideBets: true },
    });
    if (!anchor || anchor.status !== 'OPEN') {
      return reply.status(404).send({ error: 'Anchor bet not found or not open' });
    }

    // Calculate total side bet volume
    const totalVolume = anchor.sideBets.reduce((sum, sb) => sum + sb.amountCents, 0);

    const result = await prisma.$transaction(async (tx) => {
      // Create market
      const market = await tx.market.create({
        data: {
          slug: parsed.data.slug,
          title: parsed.data.title,
          description: `Promoted from AnchorBet: ${anchor.title}\n\nRules: ${anchor.rulesText}`,
        },
      });

      // Create promotion record
      const promotion = await tx.promotion.create({
        data: {
          anchorBetId: id,
          marketId: market.id,
          thresholdCents: parsed.data.thresholdCents ?? 0,
        },
      });

      // Update anchor bet status
      await tx.anchorBet.update({
        where: { id },
        data: { status: 'PROMOTED' },
      });

      // Event log
      await tx.eventLog.create({
        data: {
          marketId: market.id,
          type: 'MarketPromoted',
          payload: {
            anchorBetId: id,
            totalSideVolume: totalVolume,
            adminUserId: req.user!.sub,
          },
        },
      });

      return { market, promotion };
    });

    return reply.status(201).send(result);
  });

  // List anchor bets
  app.get('/anchor-bets', { preHandler: authenticate }, async (_req, reply) => {
    const bets = await prisma.anchorBet.findMany({
      include: { sideBets: true, promotions: true },
      orderBy: { createdAt: 'desc' },
    });
    return reply.send(bets);
  });
}
