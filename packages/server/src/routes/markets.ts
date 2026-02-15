import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { authenticate, requireAdmin } from "../middleware/auth.js";
import { CreateMarketSchema } from "../schemas/index.js";
import type { MatchingEngine } from "../engine/engine.js";

export async function marketRoutes(app: FastifyInstance, engine: MatchingEngine) {
  // Create market (admin)
  app.post("/markets", { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = CreateMarketSchema.parse(request.body);

    const existing = await prisma.market.findUnique({ where: { slug: body.slug } });
    if (existing) {
      return reply.code(409).send({ error: "Market slug already exists" });
    }

    const market = await prisma.$transaction(async (tx) => {
      const m = await tx.market.create({
        data: {
          slug: body.slug,
          title: body.title,
          description: body.description,
          tickSizeCents: body.tickSizeCents,
        },
      });

      await tx.eventLog.create({
        data: {
          marketId: m.id,
          type: "MarketCreated",
          payload: { slug: m.slug, title: m.title },
          seq: 1,
        },
      });

      return m;
    });

    engine.getOrCreateBook(market.id);

    return reply.code(201).send(market);
  });

  // List markets
  app.get("/markets", async (_request) => {
    const markets = await prisma.market.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        slug: true,
        title: true,
        description: true,
        status: true,
        resolvesTo: true,
        tickSizeCents: true,
        createdAt: true,
        resolvedAt: true,
      },
    });
    return markets;
  });

  // Get single market
  app.get("/markets/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const market = await prisma.market.findUnique({ where: { id } });
    if (!market) return reply.code(404).send({ error: "Market not found" });

    const snapshot = engine.getBookSnapshot(market.id);
    return { ...market, book: snapshot };
  });

  // Get order book
  app.get("/markets/:id/book", async (request) => {
    const { id } = request.params as { id: string };
    return engine.getBookSnapshot(id);
  });

  // Get recent trades
  app.get("/markets/:id/trades", async (request) => {
    const { id } = request.params as { id: string };
    const trades = await prisma.trade.findMany({
      where: { marketId: id },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        priceCents: true,
        qty: true,
        takerFeeCents: true,
        takerUserId: true,
        makerUserId: true,
        createdAt: true,
      },
    });
    return trades;
  });

  // Get user's orders in a market
  app.get("/markets/:id/orders", { preHandler: [authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const orders = await prisma.order.findMany({
      where: { marketId: id, userId: request.user.sub },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return orders;
  });

  // Get user's position in a market
  app.get("/markets/:id/position", { preHandler: [authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const position = await prisma.position.findUnique({
      where: { marketId_userId: { marketId: id, userId: request.user.sub } },
    });
    return position ?? { yesShares: 0, avgCostCents: 0, realizedPnlCents: 0, lockedCents: 0 };
  });
}
