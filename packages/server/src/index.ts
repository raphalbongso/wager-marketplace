import Fastify from "fastify";
import fastifyJwt from "@fastify/jwt";
import fastifyWebsocket from "@fastify/websocket";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "./config.js";
import { logger } from "./logger.js";
import { prisma } from "./db.js";
import { MatchingEngine } from "./engine/engine.js";
import { WsHub, wsRoutes } from "./routes/ws.js";
import { authRoutes } from "./routes/auth.js";
import { walletRoutes } from "./routes/wallet.js";
import { marketRoutes } from "./routes/markets.js";
import { orderRoutes } from "./routes/orders.js";
import { adminRoutes } from "./routes/admin.js";
import { anchorBetRoutes } from "./routes/anchor-bets.js";
import { checkRateLimit, getRateLimitKey } from "./middleware/rate-limit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// BigInt JSON serialization (Prisma returns BigInt for seq columns)
(BigInt.prototype as any).toJSON = function () {
  return Number(this);
};

async function main() {
  const app = Fastify({
    logger: false, // We use our own pino logger
    requestIdHeader: "x-request-id",
    genReqId: () => crypto.randomUUID(),
  });

  // ── Plugins ──────────────────────────────────────────────────

  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyJwt, { secret: config.JWT_SECRET });
  await app.register(fastifyWebsocket);
  await app.register(fastifyStatic, {
    root: path.join(__dirname, "..", "public"),
    prefix: "/",
  });

  // ── Request logging ──────────────────────────────────────────

  app.addHook("onRequest", (request, _reply, done) => {
    logger.info({ method: request.method, url: request.url, reqId: request.id }, "incoming request");
    done();
  });

  app.addHook("onResponse", (request, reply, done) => {
    logger.info(
      { method: request.method, url: request.url, statusCode: reply.statusCode, reqId: request.id },
      "request completed",
    );
    done();
  });

  // ── Rate limiting ────────────────────────────────────────────

  app.addHook("onRequest", (request, reply, done) => {
    const key = getRateLimitKey(request as any);
    if (!checkRateLimit(key)) {
      reply.code(429).send({ error: "Too many requests" });
      return;
    }
    done();
  });

  // ── Zod error handler ────────────────────────────────────────

  app.setErrorHandler((error, _request, reply) => {
    if (error.name === "ZodError") {
      return reply.code(400).send({ error: "Validation error", details: (error as any).issues });
    }
    if ((error as any).statusCode && (error as any).statusCode < 500) {
      return reply.code((error as any).statusCode).send({ error: error.message });
    }
    logger.error(error, "Unhandled error");
    reply.code(500).send({ error: "Internal server error" });
  });

  // ── Engine & WS Hub ──────────────────────────────────────────

  const engine = new MatchingEngine(config.TAKER_FEE_BPS);
  const wsHub = new WsHub();

  // ── Routes ───────────────────────────────────────────────────

  await app.register(async (instance) => {
    await authRoutes(instance);
    await walletRoutes(instance);
    await marketRoutes(instance, engine);
    await orderRoutes(instance, engine, wsHub);
    await adminRoutes(instance, engine, wsHub);
    await anchorBetRoutes(instance, engine);
    await wsRoutes(instance, wsHub);
  });

  // Health check
  app.get("/health", async () => ({ status: "ok" }));

  // ── Rebuild order books on startup ───────────────────────────

  await rebuildBooks(engine);

  // ── Ensure platform fee wallet exists ────────────────────────

  await prisma.platformFeeWallet.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", balanceCents: 0 },
    update: {},
  });

  // ── Start ────────────────────────────────────────────────────

  const address = await app.listen({ port: config.PORT, host: "0.0.0.0" });
  logger.info(`Server listening on ${address}`);
}

async function rebuildBooks(engine: MatchingEngine) {
  const openMarkets = await prisma.market.findMany({ where: { status: "OPEN" } });
  logger.info(`Rebuilding order books for ${openMarkets.length} open market(s)`);

  for (const market of openMarkets) {
    const orders = await prisma.order.findMany({
      where: { marketId: market.id, status: { in: ["OPEN", "PARTIAL"] } },
      orderBy: { seq: "asc" },
    });

    const refs = orders.map((o) => ({
      orderId: o.id,
      userId: o.userId,
      side: o.side as "BUY" | "SELL",
      priceCents: o.priceCents!,
      remainingQty: o.remainingQty,
      timestamp: o.createdAt,
      seq: o.seq,
    }));

    engine.rebuildBook(market.id, refs);
    logger.info({ marketId: market.id, slug: market.slug, orderCount: refs.length }, "Book rebuilt");
  }
}

main().catch((err) => {
  logger.fatal(err, "Failed to start server");
  process.exit(1);
});
