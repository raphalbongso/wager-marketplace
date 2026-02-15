/**
 * Settlement: resolves a market and pays out positions.
 *
 * YES resolution: each YES share pays 100 cents.
 *   - Long positions (yesShares > 0) receive yesShares * 100
 *   - Short positions (yesShares < 0) pay |yesShares| * 100
 *
 * NO resolution: YES shares are worthless.
 *   - Short positions get their collateral released
 *   - Long positions lose their investment (already paid at trade time)
 */

import { PrismaClient, Prisma } from '@prisma/client';
import { getBook, cancelOrder } from './matching.js';
import { log } from '../lib/logger.js';

export async function settleMarket(
  prisma: PrismaClient,
  marketId: string,
  resolvesTo: 'YES' | 'NO',
  adminUserId: string,
): Promise<{ settledPositions: number; totalPayout: number }> {
  // Validate market
  const market = await prisma.market.findUnique({ where: { id: marketId } });
  if (!market) throw new Error('Market not found');
  if (market.status !== 'OPEN') throw new Error('Market already resolved');

  // Cancel all open orders first (return collateral)
  const openOrders = await prisma.order.findMany({
    where: { marketId, status: { in: ['OPEN', 'PARTIAL'] } },
  });

  for (const order of openOrders) {
    await cancelOrder(prisma, marketId, order.id, order.userId);
  }

  // Get all positions for this market
  const positions = await prisma.position.findMany({ where: { marketId } });

  let totalPayout = 0;
  let settledPositions = 0;

  await prisma.$transaction(async (tx) => {
    for (const pos of positions) {
      if (pos.yesShares === 0) continue;

      let payout = 0;
      let lockRelease = 0;

      if (resolvesTo === 'YES') {
        if (pos.yesShares > 0) {
          // Long YES wins: receives 100 per share
          payout = pos.yesShares * 100;
        } else {
          // Short YES loses: pays 100 per share (from locked collateral)
          payout = pos.yesShares * 100; // negative number
          lockRelease = Math.abs(pos.yesShares) * 100; // release the position lock
        }
      } else {
        // NO resolution: YES shares are worthless
        if (pos.yesShares > 0) {
          payout = 0; // Long loses, but they already paid at trade time
        } else {
          // Short wins: gets collateral back (position lock released)
          payout = 0;
          lockRelease = Math.abs(pos.yesShares) * 100;
        }
      }

      // Update wallet
      if (payout !== 0 || lockRelease > 0) {
        await tx.wallet.update({
          where: { userId: pos.userId },
          data: {
            balanceCents: { increment: payout },
            lockedCents: { decrement: lockRelease },
          },
        });
      }

      // Update position realized PnL
      const realizedFromSettlement = payout - (pos.yesShares > 0 ? pos.costBasisCents * pos.yesShares : 0);
      await tx.position.update({
        where: { id: pos.id },
        data: {
          realizedPnlCents: { increment: payout > 0 ? payout : payout },
        },
      });

      if (payout > 0) totalPayout += payout;
      settledPositions++;
    }

    // Resolve market
    await tx.market.update({
      where: { id: marketId },
      data: {
        status: 'RESOLVED',
        resolvesTo: resolvesTo,
        resolvedAt: new Date(),
      },
    });

    // Event log
    await tx.eventLog.create({
      data: {
        marketId,
        type: 'MarketResolved',
        payload: {
          resolvesTo,
          adminUserId,
          settledPositions,
          totalPayout,
        } as unknown as Prisma.InputJsonValue,
      },
    });
  });

  log('info', 'Market settled', { marketId, resolvesTo, settledPositions, totalPayout });
  return { settledPositions, totalPayout };
}
