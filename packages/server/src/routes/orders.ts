import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { authenticate } from "../middleware/auth.js";
import { PlaceOrderSchema } from "../schemas/index.js";
import { lockRequired, lockPerShare, positionLockPerShare, computeTakerFee } from "../engine/collateral.js";
import { SHARE_PAYOUT_CENTS } from "../engine/types.js";
import type { MatchingEngine } from "../engine/engine.js";
import type { Fill, MatchResult } from "../engine/types.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { WsHub } from "./ws.js";

export async function orderRoutes(app: FastifyInstance, engine: MatchingEngine, wsHub: WsHub) {
  // ── Place order ────────────────────────────────────────────

  app.post("/markets/:id/orders", { preHandler: [authenticate] }, async (request, reply) => {
    const { id: marketId } = request.params as { id: string };
    const body = PlaceOrderSchema.parse(request.body);
    const userId = request.user.sub;

    // Validate market
    const market = await prisma.market.findUnique({ where: { id: marketId } });
    if (!market) return reply.code(404).send({ error: "Market not found" });
    if (market.status !== "OPEN") return reply.code(400).send({ error: "Market is not open" });

    // Validate tick size
    if (body.type === "LIMIT" && body.priceCents! % market.tickSizeCents !== 0) {
      return reply.code(400).send({ error: `Price must be multiple of ${market.tickSizeCents}` });
    }

    // Compute required lock
    const requiredLock = lockRequired(body.side, body.type, body.priceCents ?? null, body.qty, config.TAKER_FEE_BPS);

    try {
      const result = await prisma.$transaction(async (tx) => {
        // Check wallet
        const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId } });
        const available = wallet.balanceCents - wallet.lockedCents;
        if (available < requiredLock) {
          throw new InsufficientFundsError(available, requiredLock);
        }

        // Lock funds
        await tx.wallet.update({
          where: { userId },
          data: { lockedCents: { increment: requiredLock } },
        });

        // Create order
        const seq = engine.nextSeq(marketId);
        const order = await tx.order.create({
          data: {
            marketId,
            userId,
            side: body.side,
            type: body.type,
            priceCents: body.priceCents ?? null,
            qty: body.qty,
            remainingQty: body.qty,
            lockedCents: requiredLock,
            status: "OPEN",
            seq,
            clientOrderId: body.clientOrderId ?? null,
          },
        });

        // Log event
        await tx.eventLog.create({
          data: {
            marketId,
            type: "OrderAccepted",
            payload: {
              orderId: order.id,
              userId,
              side: body.side,
              type: body.type,
              priceCents: body.priceCents,
              qty: body.qty,
            },
            seq,
          },
        });

        // Run matching engine
        const matchResult = engine.processOrder({
          orderId: order.id,
          userId,
          marketId,
          side: body.side,
          type: body.type,
          priceCents: body.priceCents ?? null,
          qty: body.qty,
        });

        // Persist fills
        await persistFills(tx, matchResult, order.id, marketId, body.side, body.type, body.priceCents ?? null, body.qty);

        // Update order status
        const newStatus = matchResult.status;
        const filledQty = body.qty - matchResult.remainingQty;
        await tx.order.update({
          where: { id: order.id },
          data: {
            status: newStatus,
            remainingQty: matchResult.remainingQty,
            lockedCents: computeRemainingLock(
              body.side, body.type, body.priceCents ?? null, matchResult.remainingQty,
              requiredLock, filledQty, body.qty, matchResult.fills, config.TAKER_FEE_BPS,
            ),
          },
        });

        return { order: { ...order, status: newStatus, remainingQty: matchResult.remainingQty }, matchResult };
      });

      // After commit: apply to in-memory book
      engine.applyResult(marketId, result.matchResult);

      // Broadcast WS updates
      wsHub.broadcastBookUpdate(marketId, engine.getBookSnapshot(marketId));
      for (const fill of result.matchResult.fills) {
        wsHub.broadcastTrade(marketId, {
          priceCents: fill.priceCents,
          qty: fill.qty,
          takerSide: body.side,
        });
      }

      return reply.code(201).send(result.order);
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        return reply.code(400).send({ error: "Insufficient funds", available: err.available, required: err.required });
      }
      throw err;
    }
  });

  // ── Cancel order ───────────────────────────────────────────

  app.post("/markets/:id/orders/:orderId/cancel", { preHandler: [authenticate] }, async (request, reply) => {
    const { id: marketId, orderId } = request.params as { id: string; orderId: string };
    const userId = request.user.sub;

    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new OrderNotFoundError();
      if (order.userId !== userId && request.user.role !== "ADMIN") {
        throw new ForbiddenError();
      }
      if (order.status !== "OPEN" && order.status !== "PARTIAL") {
        return { already: true, order };
      }

      // Release locked funds
      const refund = order.lockedCents;
      await tx.wallet.update({
        where: { userId: order.userId },
        data: { lockedCents: { decrement: refund } },
      });

      const updated = await tx.order.update({
        where: { id: orderId },
        data: { status: "CANCELED", remainingQty: 0, lockedCents: 0 },
      });

      await tx.eventLog.create({
        data: {
          marketId,
          type: "OrderCanceled",
          payload: { orderId, userId: order.userId, refundCents: refund },
        },
      });

      return { already: false, order: updated };
    });

    if (result.already) {
      return reply.code(200).send({ message: "Order already terminal", order: result.order });
    }

    // Remove from in-memory book
    engine.cancelOrder(marketId, orderId);
    wsHub.broadcastBookUpdate(marketId, engine.getBookSnapshot(marketId));

    return result.order;
  });
}

// ── Persist fills in a transaction ──────────────────────────

async function persistFills(
  tx: any,
  matchResult: MatchResult,
  takerOrderId: string,
  marketId: string,
  takerSide: "BUY" | "SELL",
  takerType: "LIMIT" | "MARKET",
  takerPriceCents: number | null,
  takerQty: number,
) {
  const feeBps = config.TAKER_FEE_BPS;

  for (const fill of matchResult.fills) {
    // Create trade record
    await tx.trade.create({
      data: {
        marketId,
        takerOrderId,
        makerOrderId: fill.makerOrderId,
        priceCents: fill.priceCents,
        qty: fill.qty,
        takerUserId: fill.takerUserId,
        makerUserId: fill.makerUserId,
        takerFeeCents: fill.takerFeeCents,
      },
    });

    // Update maker order
    const makerOrder = await tx.order.findUniqueOrThrow({ where: { id: fill.makerOrderId } });
    const makerNewRemaining = makerOrder.remainingQty - fill.qty;
    const makerLockPerShare = lockPerShare(
      makerOrder.side as "BUY" | "SELL",
      makerOrder.type as "LIMIT" | "MARKET",
      makerOrder.priceCents,
    );
    const makerLockRelease = makerLockPerShare * fill.qty;
    // Also release fee portion from maker lock (maker fee is 0, but lock included fee estimate)
    const makerFeeEstRelease = Math.ceil(
      (makerOrder.priceCents ?? 99) * fill.qty * feeBps / 10_000,
    );

    await tx.order.update({
      where: { id: fill.makerOrderId },
      data: {
        remainingQty: makerNewRemaining,
        status: makerNewRemaining === 0 ? "FILLED" : "PARTIAL",
        lockedCents: { decrement: makerLockRelease + makerFeeEstRelease },
      },
    });

    // ── Wallet updates ────────────────────────────────────
    const execNotional = fill.priceCents * fill.qty;

    if (takerSide === "BUY") {
      // Taker (buyer): pay execNotional + fee. Release order lock.
      const takerLPS = lockPerShare(takerSide, takerType, takerPriceCents);
      const takerLockRelease = takerLPS * fill.qty;
      const takerFeeEstRelease = Math.ceil((takerPriceCents ?? 99) * fill.qty * feeBps / 10_000);

      await tx.wallet.update({
        where: { userId: fill.takerUserId },
        data: {
          balanceCents: { decrement: execNotional + fill.takerFeeCents },
          lockedCents: { decrement: takerLockRelease + takerFeeEstRelease },
        },
      });

      // Maker (seller): receive execNotional. Release order lock. Add position lock.
      const sellerPosLock = positionLockPerShare(fill.priceCents) * fill.qty;
      await tx.wallet.update({
        where: { userId: fill.makerUserId },
        data: {
          balanceCents: { increment: execNotional },
          lockedCents: { increment: -makerLockRelease - makerFeeEstRelease + sellerPosLock },
        },
      });

      // Positions
      await upsertPosition(tx, marketId, fill.takerUserId, fill.qty, fill.priceCents, 0);
      await upsertPosition(tx, marketId, fill.makerUserId, -fill.qty, fill.priceCents, sellerPosLock);
    } else {
      // Taker is SELLER
      const takerLPS = lockPerShare(takerSide, takerType, takerPriceCents);
      const takerLockRelease = takerLPS * fill.qty;
      const takerFeeEstRelease = Math.ceil((takerPriceCents ?? 99) * fill.qty * feeBps / 10_000);
      const sellerPosLock = positionLockPerShare(fill.priceCents) * fill.qty;

      // Taker (seller): receive execNotional - fee. Release order lock. Add position lock.
      await tx.wallet.update({
        where: { userId: fill.takerUserId },
        data: {
          balanceCents: { increment: execNotional - fill.takerFeeCents },
          lockedCents: { increment: -takerLockRelease - takerFeeEstRelease + sellerPosLock },
        },
      });

      // Maker (buyer): pay execNotional. Release order lock.
      await tx.wallet.update({
        where: { userId: fill.makerUserId },
        data: {
          balanceCents: { decrement: execNotional },
          lockedCents: { decrement: makerLockRelease + makerFeeEstRelease },
        },
      });

      // Positions
      await upsertPosition(tx, marketId, fill.takerUserId, -fill.qty, fill.priceCents, sellerPosLock);
      await upsertPosition(tx, marketId, fill.makerUserId, fill.qty, fill.priceCents, 0);
    }

    // Platform fee
    await tx.platformFeeWallet.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", balanceCents: fill.takerFeeCents },
      update: { balanceCents: { increment: fill.takerFeeCents } },
    });

    // Event log
    await tx.eventLog.create({
      data: {
        marketId,
        type: "TradeExecuted",
        payload: {
          takerOrderId,
          makerOrderId: fill.makerOrderId,
          priceCents: fill.priceCents,
          qty: fill.qty,
          takerFeeCents: fill.takerFeeCents,
        },
      },
    });
  }
}

async function upsertPosition(
  tx: any,
  marketId: string,
  userId: string,
  sharesDelta: number,
  priceCents: number,
  posLockDelta: number,
) {
  const existing = await tx.position.findUnique({
    where: { marketId_userId: { marketId, userId } },
  });

  if (existing) {
    const oldShares = existing.yesShares;
    const newShares = oldShares + sharesDelta;

    // If covering a short position, release proportional position lock
    let lockAdjust = posLockDelta;
    if (sharesDelta > 0 && oldShares < 0) {
      const covered = Math.min(sharesDelta, Math.abs(oldShares));
      const releasePerShare = existing.lockedCents > 0 && oldShares < 0
        ? Math.floor(existing.lockedCents * covered / Math.abs(oldShares))
        : 0;
      lockAdjust -= releasePerShare;

      // Also release from wallet
      if (releasePerShare > 0) {
        await tx.wallet.update({
          where: { userId },
          data: { lockedCents: { decrement: releasePerShare } },
        });
      }
    }

    // Update avg cost (simplified weighted average)
    let newAvgCost = existing.avgCostCents;
    if (sharesDelta > 0 && newShares > 0) {
      const oldValue = existing.avgCostCents * Math.max(0, oldShares);
      const newValue = priceCents * sharesDelta;
      newAvgCost = Math.floor((oldValue + newValue) / newShares);
    }

    await tx.position.update({
      where: { marketId_userId: { marketId, userId } },
      data: {
        yesShares: newShares,
        avgCostCents: newAvgCost,
        lockedCents: { increment: lockAdjust },
      },
    });
  } else {
    await tx.position.create({
      data: {
        marketId,
        userId,
        yesShares: sharesDelta,
        avgCostCents: priceCents,
        lockedCents: posLockDelta,
      },
    });
  }
}

function computeRemainingLock(
  side: "BUY" | "SELL",
  type: "LIMIT" | "MARKET",
  priceCents: number | null,
  remainingQty: number,
  originalLock: number,
  filledQty: number,
  totalQty: number,
  fills: Fill[],
  feeBps: number,
): number {
  if (remainingQty === 0) return 0;
  // Pro-rate the remaining lock based on remaining qty
  const lps = lockPerShare(side, type, priceCents);
  const feeEstPerShare = Math.ceil((priceCents ?? 99) * feeBps / 10_000);
  return (lps + feeEstPerShare) * remainingQty;
}

// ── Error classes ────────────────────────────────────────────

class InsufficientFundsError extends Error {
  constructor(public available: number, public required: number) {
    super("Insufficient funds");
  }
}

class OrderNotFoundError extends Error {
  constructor() { super("Order not found"); }
}

class ForbiddenError extends Error {
  constructor() { super("Forbidden"); }
}
