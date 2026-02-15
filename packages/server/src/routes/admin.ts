import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { requireAdmin } from "../middleware/auth.js";
import { DepositSchema, ResolveMarketSchema } from "../schemas/index.js";
import type { MatchingEngine } from "../engine/engine.js";
import { settleMarket } from "../services/settlement.js";
import type { WsHub } from "./ws.js";

export async function adminRoutes(app: FastifyInstance, engine: MatchingEngine, wsHub: WsHub) {
  // Deposit funds to a user wallet (testing utility)
  app.post("/wallet/deposit", { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = DepositSchema.parse(request.body);

    const wallet = await prisma.$transaction(async (tx) => {
      const w = await tx.wallet.update({
        where: { userId: body.userId },
        data: { balanceCents: { increment: body.amountCents } },
      });

      await tx.eventLog.create({
        data: {
          type: "WalletDeposit",
          payload: { userId: body.userId, amountCents: body.amountCents },
        },
      });

      return w;
    });

    return {
      userId: body.userId,
      balanceCents: wallet.balanceCents,
      lockedCents: wallet.lockedCents,
      availableCents: wallet.balanceCents - wallet.lockedCents,
    };
  });

  // Resolve market
  app.post("/markets/:id/resolve", { preHandler: [requireAdmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = ResolveMarketSchema.parse(request.body);

    const market = await prisma.market.findUnique({ where: { id } });
    if (!market) return reply.code(404).send({ error: "Market not found" });
    if (market.status !== "OPEN") return reply.code(400).send({ error: "Market already resolved" });

    await settleMarket(id, body.resolvesTo, engine);

    wsHub.broadcastMarketResolved(id, body.resolvesTo);

    const updated = await prisma.market.findUniqueOrThrow({ where: { id } });
    return updated;
  });

  // Admin metrics
  app.get("/admin/metrics", { preHandler: [requireAdmin] }, async () => {
    const [
      totalUsers,
      openMarkets,
      resolvedMarkets,
      totalOpenOrders,
      walletAgg,
      platformFee,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.market.count({ where: { status: "OPEN" } }),
      prisma.market.count({ where: { status: "RESOLVED" } }),
      prisma.order.count({ where: { status: { in: ["OPEN", "PARTIAL"] } } }),
      prisma.wallet.aggregate({ _sum: { balanceCents: true, lockedCents: true } }),
      prisma.platformFeeWallet.findUnique({ where: { id: "singleton" } }),
    ]);

    return {
      totalUsers,
      openMarkets,
      resolvedMarkets,
      totalOpenOrders,
      totalBalanceCents: walletAgg._sum.balanceCents ?? 0,
      totalLockedCents: walletAgg._sum.lockedCents ?? 0,
      platformFeeCents: platformFee?.balanceCents ?? 0,
    };
  });

  // Admin users list
  app.get("/admin/users", { preHandler: [requireAdmin] }, async () => {
    const users = await prisma.user.findMany({
      include: { wallet: true },
      orderBy: { createdAt: "desc" },
    });
    return users.map((u) => ({
      id: u.id,
      email: u.email,
      role: u.role,
      createdAt: u.createdAt,
      balanceCents: u.wallet?.balanceCents ?? 0,
      lockedCents: u.wallet?.lockedCents ?? 0,
    }));
  });

  // Event log
  app.get("/admin/events", { preHandler: [requireAdmin] }, async (request) => {
    const { market_id, limit } = request.query as { market_id?: string; limit?: string };
    const take = Math.min(parseInt(limit ?? "100", 10), 500);

    const where = market_id ? { marketId: market_id } : {};
    const events = await prisma.eventLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
    });
    return events;
  });
}
