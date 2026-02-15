import { prisma } from "../db.js";
import { SHARE_PAYOUT_CENTS } from "../engine/types.js";
import type { MatchingEngine } from "../engine/engine.js";
import { logger } from "../logger.js";

/**
 * Settle a market by resolving it to YES or NO.
 *
 * Steps:
 * 1. Cancel all open/partial orders, releasing their locked funds.
 * 2. For each position:
 *    - Release position collateral (locked_cents on Position).
 *    - If YES resolution: credit yes_shares * 100 to wallet.
 *    - If NO resolution: yes_shares worth 0 (no credit).
 * 3. Mark market as RESOLVED.
 * 4. Remove in-memory book.
 * 5. Emit settlement events.
 */
export async function settleMarket(
  marketId: string,
  resolvesTo: "YES" | "NO",
  engine: MatchingEngine,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const market = await tx.market.findUniqueOrThrow({ where: { id: marketId } });
    if (market.status !== "OPEN") {
      throw new Error("Market is not open");
    }

    // 1. Cancel all open orders
    const openOrders = await tx.order.findMany({
      where: { marketId, status: { in: ["OPEN", "PARTIAL"] } },
    });

    for (const order of openOrders) {
      // Release order lock
      if (order.lockedCents > 0) {
        await tx.wallet.update({
          where: { userId: order.userId },
          data: { lockedCents: { decrement: order.lockedCents } },
        });
      }

      await tx.order.update({
        where: { id: order.id },
        data: { status: "CANCELED", remainingQty: 0, lockedCents: 0 },
      });

      await tx.eventLog.create({
        data: {
          marketId,
          type: "OrderCanceled",
          payload: { orderId: order.id, reason: "MarketSettlement" },
        },
      });
    }

    // 2. Settle positions
    const positions = await tx.position.findMany({ where: { marketId } });

    for (const pos of positions) {
      // Release position collateral
      if (pos.lockedCents > 0) {
        await tx.wallet.update({
          where: { userId: pos.userId },
          data: { lockedCents: { decrement: pos.lockedCents } },
        });
      }

      // Compute payout
      let payout = 0;
      if (resolvesTo === "YES" && pos.yesShares > 0) {
        payout = pos.yesShares * SHARE_PAYOUT_CENTS;
      } else if (resolvesTo === "NO" && pos.yesShares < 0) {
        // Short YES wins when NO resolves: their collateral covers it, return it.
        // The collateral was already released above. The "profit" is implicit
        // (they received cash when selling + collateral returned).
        payout = 0;
      } else if (resolvesTo === "YES" && pos.yesShares < 0) {
        // Short YES loses: they owe |shares| * 100. Deduct from balance.
        // Their position collateral (already released above) covers this.
        payout = pos.yesShares * SHARE_PAYOUT_CENTS; // negative
      }

      if (payout !== 0) {
        await tx.wallet.update({
          where: { userId: pos.userId },
          data: { balanceCents: { increment: payout } },
        });
      }

      // Compute realized PnL
      const totalCost = pos.avgCostCents * Math.abs(pos.yesShares);
      const realizedPnl = payout - (pos.yesShares > 0 ? totalCost : -totalCost);

      await tx.position.update({
        where: { id: pos.id },
        data: {
          realizedPnlCents: pos.realizedPnlCents + realizedPnl,
          lockedCents: 0,
        },
      });

      await tx.eventLog.create({
        data: {
          marketId,
          type: "PositionSettled",
          payload: {
            userId: pos.userId,
            yesShares: pos.yesShares,
            payoutCents: payout,
            realizedPnlCents: realizedPnl,
          },
        },
      });
    }

    // Clamp wallet locked to 0 (rounding safety net)
    const affectedUserIds = [...new Set(positions.map((p) => p.userId).concat(openOrders.map((o) => o.userId)))];
    for (const uid of affectedUserIds) {
      const w = await tx.wallet.findUnique({ where: { userId: uid } });
      if (w && w.lockedCents < 0) {
        await tx.wallet.update({ where: { userId: uid }, data: { lockedCents: 0 } });
      }
    }

    // 3. Mark market resolved
    await tx.market.update({
      where: { id: marketId },
      data: {
        status: "RESOLVED",
        resolvesTo,
        resolvedAt: new Date(),
      },
    });

    await tx.eventLog.create({
      data: {
        marketId,
        type: "MarketResolved",
        payload: { resolvesTo },
      },
    });
  });

  // 4. Remove in-memory book
  engine.removeBook(marketId);

  logger.info({ marketId, resolvesTo }, "Market settled");
}
