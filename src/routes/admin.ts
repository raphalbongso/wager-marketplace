import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { requireAdmin } from '../auth/middleware.js';

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin);

  // Metrics overview
  app.get('/admin/metrics', async (_req, reply) => {
    const [
      openMarkets,
      totalOrders,
      openOrders,
      totalTrades,
      totalLockedResult,
      feeWallet,
      userCount,
    ] = await Promise.all([
      prisma.market.count({ where: { status: 'OPEN' } }),
      prisma.order.count(),
      prisma.order.count({ where: { status: { in: ['OPEN', 'PARTIAL'] } } }),
      prisma.trade.count(),
      prisma.wallet.aggregate({ _sum: { lockedCents: true } }),
      prisma.platformFeeWallet.findUnique({ where: { id: 'singleton' } }),
      prisma.user.count(),
    ]);

    return reply.send({
      openMarkets,
      totalOrders,
      openOrders,
      totalTrades,
      totalLockedCents: totalLockedResult._sum.lockedCents ?? 0,
      platformFeeCents: feeWallet?.balanceCents ?? 0,
      userCount,
    });
  });

  // Event log query
  app.get('/admin/events', async (req, reply) => {
    const { market_id, limit, type } = req.query as {
      market_id?: string;
      limit?: string;
      type?: string;
    };

    const where: any = {};
    if (market_id) where.marketId = market_id;
    if (type) where.type = type;

    const events = await prisma.eventLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(parseInt(limit ?? '50', 10), 500),
    });

    return reply.send(events);
  });

  // List all users (admin)
  app.get('/admin/users', async (_req, reply) => {
    const users = await prisma.user.findMany({
      include: { wallet: true },
      orderBy: { createdAt: 'desc' },
    });
    return reply.send(
      users.map((u) => ({
        id: u.id,
        email: u.email,
        role: u.role,
        createdAt: u.createdAt,
        wallet: u.wallet
          ? {
              balanceCents: u.wallet.balanceCents,
              lockedCents: u.wallet.lockedCents,
              availableCents: u.wallet.balanceCents - u.wallet.lockedCents,
            }
          : null,
      })),
    );
  });
}
