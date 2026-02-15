// @ts-nocheck
import Fastify from "fastify";
import fastifyJwt from "@fastify/jwt";
import fastifyCors from "@fastify/cors";
import { z } from "zod";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// BigInt JSON serialization
(BigInt.prototype as any).toJSON = function () {
  return Number(this);
};

// ── Config ─────────────────────────────────────────────────
const config = {
  JWT_SECRET: process.env.JWT_SECRET ?? "dev-secret-at-least-32-characters!!",
  TAKER_FEE_BPS: parseInt(process.env.TAKER_FEE_BPS ?? "100", 10),
};

const prisma = new PrismaClient();

// ── Inline engine helpers ──────────────────────────────────
function lockRequired(side, type, priceCents, qty, feeBps) {
  const price = type === "MARKET" ? 99 : priceCents;
  const base = side === "BUY" ? price * qty : (100 - price) * qty;
  const fee = Math.ceil(price * qty * feeBps / 10_000);
  return base + fee;
}

function computeTakerFee(execPrice, qty, feeBps) {
  return Math.floor(execPrice * qty * feeBps / 10_000);
}

// ── Lazy Fastify init (avoid top-level await) ──────────────
let app;
let ready;

function buildApp() {
  if (app) return ready;

  app = Fastify({ logger: false });

  app.register(fastifyCors, { origin: true });
  app.register(fastifyJwt, { secret: config.JWT_SECRET });

  app.setErrorHandler((error, _req, reply) => {
    if (error.name === "ZodError") {
      return reply.code(400).send({ error: "Validation error", details: error.issues });
    }
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: error.message });
    }
    console.error(error);
    reply.code(500).send({ error: "Internal server error" });
  });

  const authenticate = async (req, reply) => {
    try { await req.jwtVerify(); } catch { reply.code(401).send({ error: "Unauthorized" }); }
  };
  const requireAdmin = async (req, reply) => {
    await authenticate(req, reply);
    if (reply.sent) return;
    if (req.user.role !== "ADMIN") reply.code(403).send({ error: "Admin access required" });
  };

  // ── Auth ───────────────────────────────────────────────────
  app.post("/auth/register", async (req, reply) => {
    const { email, password } = z.object({ email: z.string().email(), password: z.string().min(8) }).parse(req.body);
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return reply.code(409).send({ error: "Email already registered" });
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({ data: { email, passwordHash, wallet: { create: {} } }, include: { wallet: true } });
    const token = app.jwt.sign({ sub: user.id, role: user.role });
    return reply.code(201).send({ token, user: { id: user.id, email: user.email, role: user.role } });
  });

  app.post("/auth/login", async (req, reply) => {
    const { email, password } = z.object({ email: z.string().email(), password: z.string() }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) return reply.code(401).send({ error: "Invalid credentials" });
    const token = app.jwt.sign({ sub: user.id, role: user.role });
    return { token, user: { id: user.id, email: user.email, role: user.role } };
  });

  // ── Wallet ─────────────────────────────────────────────────
  app.get("/me", { preHandler: [authenticate] }, async (req) => {
    return prisma.user.findUniqueOrThrow({ where: { id: req.user.sub }, select: { id: true, email: true, role: true, createdAt: true } });
  });

  app.get("/wallet", { preHandler: [authenticate] }, async (req) => {
    const w = await prisma.wallet.findUnique({ where: { userId: req.user.sub } });
    if (!w) return { balanceCents: 0, lockedCents: 0, availableCents: 0 };
    return { balanceCents: w.balanceCents, lockedCents: w.lockedCents, availableCents: w.balanceCents - w.lockedCents };
  });

  app.post("/wallet/deposit", { preHandler: [requireAdmin] }, async (req) => {
    const { userId, amountCents } = z.object({ userId: z.string().uuid(), amountCents: z.number().int().min(1) }).parse(req.body);
    const w = await prisma.wallet.update({ where: { userId }, data: { balanceCents: { increment: amountCents } } });
    return { userId, balanceCents: w.balanceCents, lockedCents: w.lockedCents, availableCents: w.balanceCents - w.lockedCents };
  });

  // ── Markets ────────────────────────────────────────────────
  app.post("/markets", { preHandler: [requireAdmin] }, async (req, reply) => {
    const body = z.object({ slug: z.string().min(1).regex(/^[a-z0-9-]+$/), title: z.string().min(1), description: z.string().default("") }).parse(req.body);
    const existing = await prisma.market.findUnique({ where: { slug: body.slug } });
    if (existing) return reply.code(409).send({ error: "Slug exists" });
    const m = await prisma.market.create({ data: body });
    await prisma.eventLog.create({ data: { marketId: m.id, type: "MarketCreated", payload: { slug: m.slug, title: m.title }, seq: 1 } });
    return reply.code(201).send(m);
  });

  app.get("/markets", async () => prisma.market.findMany({ orderBy: { createdAt: "desc" } }));

  app.get("/markets/:id", async (req, reply) => {
    const { id } = req.params;
    const m = await prisma.market.findUnique({ where: { id } });
    if (!m) return reply.code(404).send({ error: "Not found" });
    const orders = await prisma.order.findMany({ where: { marketId: id, status: { in: ["OPEN", "PARTIAL"] } } });
    const bidsMap = new Map();
    const asksMap = new Map();
    for (const o of orders) {
      const map = o.side === "BUY" ? bidsMap : asksMap;
      map.set(o.priceCents, (map.get(o.priceCents) ?? 0) + o.remainingQty);
    }
    const bids = [...bidsMap.entries()].map(([p, q]) => ({ priceCents: p, totalQty: q, orderCount: 1 })).sort((a, b) => b.priceCents - a.priceCents).slice(0, 20);
    const asks = [...asksMap.entries()].map(([p, q]) => ({ priceCents: p, totalQty: q, orderCount: 1 })).sort((a, b) => a.priceCents - b.priceCents).slice(0, 20);
    return { ...m, book: { bids, asks } };
  });

  app.get("/markets/:id/book", async (req) => {
    const { id } = req.params;
    const orders = await prisma.order.findMany({ where: { marketId: id, status: { in: ["OPEN", "PARTIAL"] } } });
    const bidsMap = new Map();
    const asksMap = new Map();
    for (const o of orders) {
      const map = o.side === "BUY" ? bidsMap : asksMap;
      map.set(o.priceCents, (map.get(o.priceCents) ?? 0) + o.remainingQty);
    }
    return {
      bids: [...bidsMap.entries()].map(([p, q]) => ({ priceCents: p, totalQty: q })).sort((a, b) => b.priceCents - a.priceCents).slice(0, 20),
      asks: [...asksMap.entries()].map(([p, q]) => ({ priceCents: p, totalQty: q })).sort((a, b) => a.priceCents - b.priceCents).slice(0, 20),
    };
  });

  app.get("/markets/:id/trades", async (req) => {
    const { id } = req.params;
    return prisma.trade.findMany({ where: { marketId: id }, orderBy: { createdAt: "desc" }, take: 50,
      select: { id: true, priceCents: true, qty: true, takerFeeCents: true, takerUserId: true, makerUserId: true, createdAt: true } });
  });

  app.get("/markets/:id/orders", { preHandler: [authenticate] }, async (req) => {
    const { id } = req.params;
    return prisma.order.findMany({ where: { marketId: id, userId: req.user.sub }, orderBy: { createdAt: "desc" }, take: 100 });
  });

  app.get("/markets/:id/position", { preHandler: [authenticate] }, async (req) => {
    const { id } = req.params;
    const p = await prisma.position.findUnique({ where: { marketId_userId: { marketId: id, userId: req.user.sub } } });
    return p ?? { yesShares: 0, avgCostCents: 0, realizedPnlCents: 0, lockedCents: 0 };
  });

  // ── Orders (DB-based matching for serverless) ──────────────
  app.post("/markets/:id/orders", { preHandler: [authenticate] }, async (req, reply) => {
    const { id: marketId } = req.params;
    const body = z.object({
      side: z.enum(["BUY", "SELL"]), type: z.enum(["LIMIT", "MARKET"]),
      priceCents: z.number().int().min(1).max(99).optional(), qty: z.number().int().min(1).max(100000),
    }).refine(d => d.type === "MARKET" || d.priceCents != null, { message: "priceCents required for LIMIT" }).parse(req.body);
    const userId = req.user.sub;

    const market = await prisma.market.findUnique({ where: { id: marketId } });
    if (!market || market.status !== "OPEN") return reply.code(400).send({ error: "Market not open" });

    const required = lockRequired(body.side, body.type, body.priceCents ?? null, body.qty, config.TAKER_FEE_BPS);

    const result = await prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId } });
      if (wallet.balanceCents - wallet.lockedCents < required) throw new Error("INSUFFICIENT_FUNDS");

      await tx.wallet.update({ where: { userId }, data: { lockedCents: { increment: required } } });

      const maxSeq = await tx.order.aggregate({ where: { marketId }, _max: { seq: true } });
      const seq = (maxSeq._max.seq ?? 0n) + 1n;

      const order = await tx.order.create({
        data: { marketId, userId, side: body.side, type: body.type, priceCents: body.priceCents ?? null,
          qty: body.qty, remainingQty: body.qty, lockedCents: required, status: "OPEN", seq },
      });

      await tx.eventLog.create({ data: { marketId, type: "OrderAccepted", payload: { orderId: order.id, side: body.side, type: body.type, priceCents: body.priceCents, qty: body.qty }, seq } });

      let remaining = body.qty;
      const fills = [];

      if (body.side === "BUY") {
        const resting = await tx.order.findMany({
          where: { marketId, side: "SELL", status: { in: ["OPEN", "PARTIAL"] }, ...(body.type === "LIMIT" ? { priceCents: { lte: body.priceCents } } : {}) },
          orderBy: [{ priceCents: "asc" }, { seq: "asc" }],
        });
        for (const maker of resting) {
          if (remaining <= 0) break;
          const fillQty = Math.min(remaining, maker.remainingQty);
          const execPrice = maker.priceCents;
          const fee = computeTakerFee(execPrice, fillQty, config.TAKER_FEE_BPS);
          const notional = execPrice * fillQty;

          await tx.trade.create({ data: { marketId, takerOrderId: order.id, makerOrderId: maker.id, priceCents: execPrice, qty: fillQty, takerUserId: userId, makerUserId: maker.userId, takerFeeCents: fee } });

          const makerNewRem = maker.remainingQty - fillQty;
          const makerLockPerShare = 100 - maker.priceCents;
          const makerFeeEst = Math.ceil(maker.priceCents * fillQty * config.TAKER_FEE_BPS / 10_000);
          const makerLockRelease = makerLockPerShare * fillQty + makerFeeEst;
          const sellerPosLock = (100 - execPrice) * fillQty;

          await tx.order.update({ where: { id: maker.id }, data: { remainingQty: makerNewRem, status: makerNewRem === 0 ? "FILLED" : "PARTIAL", lockedCents: { decrement: makerLockRelease } } });

          const buyerLockPerShare = body.type === "MARKET" ? 99 : body.priceCents;
          const buyerFeeEst = Math.ceil(buyerLockPerShare * fillQty * config.TAKER_FEE_BPS / 10_000);
          await tx.wallet.update({ where: { userId }, data: { balanceCents: { decrement: notional + fee }, lockedCents: { decrement: buyerLockPerShare * fillQty + buyerFeeEst } } });
          await tx.wallet.update({ where: { userId: maker.userId }, data: { balanceCents: { increment: notional }, lockedCents: { increment: -makerLockRelease + sellerPosLock } } });

          await upsertPos(tx, marketId, userId, fillQty, execPrice, 0);
          await upsertPos(tx, marketId, maker.userId, -fillQty, execPrice, sellerPosLock);

          await tx.platformFeeWallet.upsert({ where: { id: "singleton" }, create: { id: "singleton", balanceCents: fee }, update: { balanceCents: { increment: fee } } });

          remaining -= fillQty;
          fills.push({ priceCents: execPrice, qty: fillQty, fee });
        }
      } else {
        const resting = await tx.order.findMany({
          where: { marketId, side: "BUY", status: { in: ["OPEN", "PARTIAL"] }, ...(body.type === "LIMIT" ? { priceCents: { gte: body.priceCents } } : {}) },
          orderBy: [{ priceCents: "desc" }, { seq: "asc" }],
        });
        for (const maker of resting) {
          if (remaining <= 0) break;
          const fillQty = Math.min(remaining, maker.remainingQty);
          const execPrice = maker.priceCents;
          const fee = computeTakerFee(execPrice, fillQty, config.TAKER_FEE_BPS);
          const notional = execPrice * fillQty;

          await tx.trade.create({ data: { marketId, takerOrderId: order.id, makerOrderId: maker.id, priceCents: execPrice, qty: fillQty, takerUserId: userId, makerUserId: maker.userId, takerFeeCents: fee } });

          const makerNewRem = maker.remainingQty - fillQty;
          const makerLockPerShare = maker.priceCents;
          const makerFeeEst = Math.ceil(maker.priceCents * fillQty * config.TAKER_FEE_BPS / 10_000);
          const makerLockRelease = makerLockPerShare * fillQty + makerFeeEst;

          await tx.order.update({ where: { id: maker.id }, data: { remainingQty: makerNewRem, status: makerNewRem === 0 ? "FILLED" : "PARTIAL", lockedCents: { decrement: makerLockRelease } } });

          const sellerLockPerShare = body.type === "MARKET" ? 99 : (100 - body.priceCents);
          const sellerFeeEst = Math.ceil((body.priceCents ?? 99) * fillQty * config.TAKER_FEE_BPS / 10_000);
          const sellerPosLock = (100 - execPrice) * fillQty;
          await tx.wallet.update({ where: { userId }, data: { balanceCents: { increment: notional - fee }, lockedCents: { increment: -(sellerLockPerShare * fillQty + sellerFeeEst) + sellerPosLock } } });
          await tx.wallet.update({ where: { userId: maker.userId }, data: { balanceCents: { decrement: notional }, lockedCents: { decrement: makerLockRelease } } });

          await upsertPos(tx, marketId, userId, -fillQty, execPrice, sellerPosLock);
          await upsertPos(tx, marketId, maker.userId, fillQty, execPrice, 0);

          await tx.platformFeeWallet.upsert({ where: { id: "singleton" }, create: { id: "singleton", balanceCents: fee }, update: { balanceCents: { increment: fee } } });

          remaining -= fillQty;
          fills.push({ priceCents: execPrice, qty: fillQty, fee });
        }
      }

      let status;
      if (remaining === 0) status = "FILLED";
      else if (body.type === "MARKET") status = fills.length > 0 ? "CANCELED" : "REJECTED";
      else status = fills.length > 0 ? "PARTIAL" : "OPEN";

      const feePerShare = Math.ceil((body.priceCents ?? 99) * config.TAKER_FEE_BPS / 10_000);
      const lps = body.side === "BUY" ? (body.type === "MARKET" ? 99 : body.priceCents) : (body.type === "MARKET" ? 1 : (100 - body.priceCents));
      const remainingLock = status === "FILLED" || status === "CANCELED" || status === "REJECTED" ? 0 : (lps + feePerShare) * remaining;

      const updated = await tx.order.update({ where: { id: order.id }, data: { status, remainingQty: remaining, lockedCents: remainingLock } });

      if (status === "CANCELED" || status === "REJECTED") {
        const unfilledLock = (lps + feePerShare) * remaining;
        if (unfilledLock > 0) {
          await tx.wallet.update({ where: { userId }, data: { lockedCents: { decrement: unfilledLock } } });
        }
      }

      return updated;
    });

    return reply.code(201).send(result);
  });

  app.post("/markets/:id/orders/:orderId/cancel", { preHandler: [authenticate] }, async (req, reply) => {
    const { id: marketId, orderId } = req.params;
    const userId = req.user.sub;
    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new Error("NOT_FOUND");
      if (order.userId !== userId && req.user.role !== "ADMIN") throw new Error("FORBIDDEN");
      if (order.status !== "OPEN" && order.status !== "PARTIAL") return order;
      await tx.wallet.update({ where: { userId: order.userId }, data: { lockedCents: { decrement: order.lockedCents } } });
      return tx.order.update({ where: { id: orderId }, data: { status: "CANCELED", remainingQty: 0, lockedCents: 0 } });
    });
    return result;
  });

  // ── Settlement ─────────────────────────────────────────────
  app.post("/markets/:id/resolve", { preHandler: [requireAdmin] }, async (req, reply) => {
    const { id } = req.params;
    const { resolvesTo } = z.object({ resolvesTo: z.enum(["YES", "NO"]) }).parse(req.body);
    await prisma.$transaction(async (tx) => {
      const market = await tx.market.findUniqueOrThrow({ where: { id } });
      if (market.status !== "OPEN") throw new Error("NOT_OPEN");
      const openOrders = await tx.order.findMany({ where: { marketId: id, status: { in: ["OPEN", "PARTIAL"] } } });
      for (const o of openOrders) {
        if (o.lockedCents > 0) await tx.wallet.update({ where: { userId: o.userId }, data: { lockedCents: { decrement: o.lockedCents } } });
        await tx.order.update({ where: { id: o.id }, data: { status: "CANCELED", remainingQty: 0, lockedCents: 0 } });
      }
      const positions = await tx.position.findMany({ where: { marketId: id } });
      for (const pos of positions) {
        if (pos.lockedCents > 0) await tx.wallet.update({ where: { userId: pos.userId }, data: { lockedCents: { decrement: pos.lockedCents } } });
        let payout = 0;
        if (resolvesTo === "YES") payout = pos.yesShares * 100;
        if (payout !== 0) await tx.wallet.update({ where: { userId: pos.userId }, data: { balanceCents: { increment: payout } } });
        await tx.position.update({ where: { id: pos.id }, data: { lockedCents: 0 } });
      }
      await tx.market.update({ where: { id }, data: { status: "RESOLVED", resolvesTo, resolvedAt: new Date() } });
    });
    return prisma.market.findUniqueOrThrow({ where: { id } });
  });

  // ── Admin ──────────────────────────────────────────────────
  app.get("/admin/metrics", { preHandler: [requireAdmin] }, async () => {
    const [users, open, resolved, openOrders, wallets, fee] = await Promise.all([
      prisma.user.count(), prisma.market.count({ where: { status: "OPEN" } }), prisma.market.count({ where: { status: "RESOLVED" } }),
      prisma.order.count({ where: { status: { in: ["OPEN", "PARTIAL"] } } }),
      prisma.wallet.aggregate({ _sum: { balanceCents: true, lockedCents: true } }),
      prisma.platformFeeWallet.findUnique({ where: { id: "singleton" } }),
    ]);
    return { totalUsers: users, openMarkets: open, resolvedMarkets: resolved, totalOpenOrders: openOrders,
      totalBalanceCents: wallets._sum.balanceCents ?? 0, totalLockedCents: wallets._sum.lockedCents ?? 0, platformFeeCents: fee?.balanceCents ?? 0 };
  });

  app.get("/admin/users", { preHandler: [requireAdmin] }, async () => {
    const users = await prisma.user.findMany({ include: { wallet: true }, orderBy: { createdAt: "desc" } });
    return users.map(u => ({ id: u.id, email: u.email, role: u.role, createdAt: u.createdAt, balanceCents: u.wallet?.balanceCents ?? 0, lockedCents: u.wallet?.lockedCents ?? 0 }));
  });

  app.get("/admin/events", { preHandler: [requireAdmin] }, async (req) => {
    const { market_id, limit } = req.query;
    return prisma.eventLog.findMany({ where: market_id ? { marketId: market_id } : {}, orderBy: { createdAt: "desc" }, take: Math.min(parseInt(limit ?? "100"), 500) });
  });

  // ── Anchor Bets ────────────────────────────────────────────
  app.post("/anchor-bets", { preHandler: [authenticate] }, async (req, reply) => {
    const body = z.object({ title: z.string().min(1), rulesText: z.string().min(1), opponentUserId: z.string().uuid().optional(), arbitratorUserId: z.string().uuid().optional() }).parse(req.body);
    const ab = await prisma.anchorBet.create({ data: { creatorUserId: req.user.sub, ...body } });
    return reply.code(201).send(ab);
  });

  app.get("/anchor-bets", async () => prisma.anchorBet.findMany({ include: { sideBets: true, _count: { select: { sideBets: true } } }, orderBy: { createdAt: "desc" } }));

  app.post("/anchor-bets/:id/side-bets", { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params;
    const body = z.object({ direction: z.enum(["YES", "NO"]), amountCents: z.number().int().min(1) }).parse(req.body);
    const sb = await prisma.sideBet.create({ data: { anchorBetId: id, userId: req.user.sub, ...body } });
    return reply.code(201).send(sb);
  });

  app.post("/anchor-bets/:id/promote", { preHandler: [requireAdmin] }, async (req, reply) => {
    const { id } = req.params;
    const body = z.object({ slug: z.string().min(1).regex(/^[a-z0-9-]+$/), thresholdCents: z.number().int().min(0) }).parse(req.body);
    const ab = await prisma.anchorBet.findUniqueOrThrow({ where: { id } });
    const market = await prisma.market.create({ data: { slug: body.slug, title: ab.title, description: ab.rulesText } });
    await prisma.promotion.create({ data: { anchorBetId: id, marketId: market.id, thresholdCents: body.thresholdCents } });
    await prisma.anchorBet.update({ where: { id }, data: { status: "PROMOTED" } });
    return reply.code(201).send({ market });
  });

  // ── Health ─────────────────────────────────────────────────
  app.get("/health", async () => ({ status: "ok" }));

  ready = app.ready();
  return ready;
}

// ── Position helper ──────────────────────────────────────────
async function upsertPos(tx, marketId, userId, sharesDelta, priceCents, posLockDelta) {
  const existing = await tx.position.findUnique({ where: { marketId_userId: { marketId, userId } } });
  if (existing) {
    const newShares = existing.yesShares + sharesDelta;
    let lockAdjust = posLockDelta;
    if (sharesDelta > 0 && existing.yesShares < 0) {
      const covered = Math.min(sharesDelta, Math.abs(existing.yesShares));
      const release = existing.lockedCents > 0 ? Math.floor(existing.lockedCents * covered / Math.abs(existing.yesShares)) : 0;
      lockAdjust -= release;
      if (release > 0) await tx.wallet.update({ where: { userId }, data: { lockedCents: { decrement: release } } });
    }
    let newAvg = existing.avgCostCents;
    if (sharesDelta > 0 && newShares > 0) newAvg = Math.floor((existing.avgCostCents * Math.max(0, existing.yesShares) + priceCents * sharesDelta) / newShares);
    await tx.position.update({ where: { marketId_userId: { marketId, userId } }, data: { yesShares: newShares, avgCostCents: newAvg, lockedCents: { increment: lockAdjust } } });
  } else {
    await tx.position.create({ data: { marketId, userId, yesShares: sharesDelta, avgCostCents: priceCents, lockedCents: posLockDelta } });
  }
}

// ── Export for Vercel ──────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  await buildApp();
  app.server.emit("request", req, res);
}
