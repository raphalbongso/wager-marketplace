import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { authenticate, requireAdmin } from "../middleware/auth.js";
import { CreateAnchorBetSchema, CreateSideBetSchema, PromoteAnchorBetSchema } from "../schemas/index.js";
import type { MatchingEngine } from "../engine/engine.js";

export async function anchorBetRoutes(app: FastifyInstance, engine: MatchingEngine) {
  // Create anchor bet
  app.post("/anchor-bets", { preHandler: [authenticate] }, async (request, reply) => {
    const body = CreateAnchorBetSchema.parse(request.body);
    const userId = request.user.sub;

    const anchorBet = await prisma.$transaction(async (tx) => {
      const ab = await tx.anchorBet.create({
        data: {
          creatorUserId: userId,
          opponentUserId: body.opponentUserId ?? null,
          title: body.title,
          rulesText: body.rulesText,
          arbitratorUserId: body.arbitratorUserId ?? null,
        },
      });

      await tx.eventLog.create({
        data: {
          type: "AnchorBetCreated",
          payload: { anchorBetId: ab.id, title: ab.title, creatorUserId: userId },
        },
      });

      return ab;
    });

    return reply.code(201).send(anchorBet);
  });

  // List anchor bets
  app.get("/anchor-bets", async () => {
    return prisma.anchorBet.findMany({
      include: {
        sideBets: { select: { id: true, direction: true, amountCents: true, userId: true } },
        _count: { select: { sideBets: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  });

  // Add side bet
  app.post("/anchor-bets/:id/side-bets", { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = CreateSideBetSchema.parse(request.body);
    const userId = request.user.sub;

    const anchorBet = await prisma.anchorBet.findUnique({ where: { id } });
    if (!anchorBet) return reply.code(404).send({ error: "Anchor bet not found" });
    if (anchorBet.status !== "OPEN") return reply.code(400).send({ error: "Anchor bet not open" });

    const sideBet = await prisma.$transaction(async (tx) => {
      const sb = await tx.sideBet.create({
        data: {
          anchorBetId: id,
          userId,
          direction: body.direction,
          amountCents: body.amountCents,
        },
      });

      await tx.eventLog.create({
        data: {
          type: "SideBetCreated",
          payload: { sideBetId: sb.id, anchorBetId: id, userId, direction: body.direction, amountCents: body.amountCents },
        },
      });

      return sb;
    });

    return reply.code(201).send(sideBet);
  });

  // Promote anchor bet to market (admin)
  app.post("/anchor-bets/:id/promote", { preHandler: [requireAdmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = PromoteAnchorBetSchema.parse(request.body);

    const anchorBet = await prisma.anchorBet.findUnique({
      where: { id },
      include: { sideBets: true },
    });
    if (!anchorBet) return reply.code(404).send({ error: "Anchor bet not found" });
    if (anchorBet.status !== "OPEN") return reply.code(400).send({ error: "Anchor bet not open" });

    const totalVolume = anchorBet.sideBets.reduce((s, sb) => s + sb.amountCents, 0);

    const result = await prisma.$transaction(async (tx) => {
      const market = await tx.market.create({
        data: {
          slug: body.slug,
          title: anchorBet.title,
          description: anchorBet.rulesText,
        },
      });

      const promotion = await tx.promotion.create({
        data: {
          anchorBetId: id,
          marketId: market.id,
          thresholdCents: body.thresholdCents,
        },
      });

      await tx.anchorBet.update({
        where: { id },
        data: { status: "PROMOTED" },
      });

      await tx.eventLog.create({
        data: {
          marketId: market.id,
          type: "MarketPromoted",
          payload: {
            anchorBetId: id,
            totalSideBetVolumeCents: totalVolume,
            thresholdCents: body.thresholdCents,
          },
        },
      });

      return { market, promotion };
    });

    engine.getOrCreateBook(result.market.id);

    return reply.code(201).send(result);
  });
}
