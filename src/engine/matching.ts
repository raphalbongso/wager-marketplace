/**
 * Deterministic Matching Engine
 *
 * Single-threaded per market. Processes orders sequentially.
 * All money in integer cents. Fully collateralized.
 *
 * Collateral model:
 *   BUY LIMIT at P, qty Q  → lock = P*Q + floor(P*Q * feeBps / 10000)
 *   SELL LIMIT at P, qty Q → lock = (100-P)*Q + floor(99*Q * feeBps / 10000)
 *   BUY MARKET             → lock = 99*Q + floor(99*Q * feeBps / 10000)
 *   SELL MARKET             → lock = 99*Q + floor(99*Q * feeBps / 10000)
 *
 * On fill:
 *   - Release proportional order lock
 *   - Transfer cash (buyer pays, seller receives minus taker fee)
 *   - Update positions; re-lock for short positions (100 * |shortShares|)
 *   - Fee charged to taker only
 *
 * On cancel: release remaining order lock
 * On settlement: pay out from positions, release all position locks
 */

import { PrismaClient, Prisma } from '@prisma/client';
import { v4 as uuid } from 'uuid';
import { OrderBook, type OrderEntry } from './orderbook.js';
import { config } from '../config.js';
import { log } from '../lib/logger.js';

// ── Types ───────────────────────────────────────────

export interface NewOrder {
  marketId: string;
  userId: string;
  side: 'BUY' | 'SELL';
  type: 'LIMIT' | 'MARKET';
  priceCents?: number; // required for LIMIT
  qty: number;
  clientOrderId?: string;
}

export interface TradeResult {
  tradeId: string;
  takerOrderId: string;
  makerOrderId: string;
  priceCents: number;
  qty: number;
  takerUserId: string;
  makerUserId: string;
  feeCents: number;
  seq: bigint;
}

export interface OrderResult {
  orderId: string;
  status: 'OPEN' | 'PARTIAL' | 'FILLED' | 'CANCELED' | 'REJECTED';
  trades: TradeResult[];
  reason?: string;
}

// ── Engine State ────────────────────────────────────

/** Per-market sequence counter */
const marketSeqs = new Map<string, bigint>();

/** Per-market order book */
const marketBooks = new Map<string, OrderBook>();

/** Per-market processing lock (ensures single-threaded) */
const marketLocks = new Map<string, Promise<void>>();

function nextSeq(marketId: string): bigint {
  const current = marketSeqs.get(marketId) ?? 0n;
  const next = current + 1n;
  marketSeqs.set(marketId, next);
  return next;
}

export function getBook(marketId: string): OrderBook {
  let book = marketBooks.get(marketId);
  if (!book) {
    book = new OrderBook();
    marketBooks.set(marketId, book);
  }
  return book;
}

export function getSeq(marketId: string): bigint {
  return marketSeqs.get(marketId) ?? 0n;
}

// ── Collateral Calculation ──────────────────────────

const FEE_BPS = () => config.TAKER_FEE_BPS;

export function calcLock(side: 'BUY' | 'SELL', type: 'LIMIT' | 'MARKET', priceCents: number | undefined, qty: number): number {
  if (type === 'MARKET') {
    const base = 99 * qty;
    const fee = Math.floor(99 * qty * FEE_BPS() / 10000);
    return base + fee;
  }
  const p = priceCents!;
  if (side === 'BUY') {
    const base = p * qty;
    const fee = Math.floor(p * qty * FEE_BPS() / 10000);
    return base + fee;
  } else {
    const base = (100 - p) * qty;
    const fee = Math.floor(99 * qty * FEE_BPS() / 10000);
    return base + fee;
  }
}

function calcTakerFee(priceCents: number, qty: number): number {
  return Math.floor(priceCents * qty * FEE_BPS() / 10000);
}

// ── Serialized Market Processing ────────────────────

function withMarketLock<T>(marketId: string, fn: () => Promise<T>): Promise<T> {
  const prev = marketLocks.get(marketId) ?? Promise.resolve();
  const next = prev.then(fn, fn); // Always run even if prev failed
  marketLocks.set(marketId, next.then(() => {}, () => {}));
  return next;
}

// ── Core Order Processing ───────────────────────────

export async function processOrder(prisma: PrismaClient, order: NewOrder): Promise<OrderResult> {
  return withMarketLock(order.marketId, () => processOrderInner(prisma, order));
}

async function processOrderInner(prisma: PrismaClient, order: NewOrder): Promise<OrderResult> {
  const { marketId, userId, side, type, qty } = order;
  const priceCents = order.priceCents ?? null;
  const orderId = uuid();
  const trades: TradeResult[] = [];

  // Validate market is OPEN
  const market = await prisma.market.findUnique({ where: { id: marketId } });
  if (!market || market.status !== 'OPEN') {
    return { orderId, status: 'REJECTED', trades: [], reason: 'Market not open' };
  }

  // Validate price
  if (type === 'LIMIT') {
    if (priceCents === null || priceCents < 1 || priceCents > 99) {
      return { orderId, status: 'REJECTED', trades: [], reason: 'Price must be 1-99 cents' };
    }
    if (priceCents % market.tickSizeCents !== 0) {
      return { orderId, status: 'REJECTED', trades: [], reason: `Price must be multiple of tick size ${market.tickSizeCents}` };
    }
  }
  if (qty < 1) {
    return { orderId, status: 'REJECTED', trades: [], reason: 'Quantity must be >= 1' };
  }

  // Check duplicate clientOrderId
  if (order.clientOrderId) {
    const existing = await prisma.order.findUnique({
      where: { userId_clientOrderId: { userId, clientOrderId: order.clientOrderId } },
    });
    if (existing) {
      return { orderId, status: 'REJECTED', trades: [], reason: 'Duplicate clientOrderId' };
    }
  }

  // Calculate required lock
  const requiredLock = calcLock(side, type, priceCents ?? undefined, qty);

  // Check wallet balance
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) {
    return { orderId, status: 'REJECTED', trades: [], reason: 'No wallet found' };
  }
  const available = wallet.balanceCents - wallet.lockedCents;
  if (available < requiredLock) {
    return { orderId, status: 'REJECTED', trades: [], reason: `Insufficient balance. Need ${requiredLock}, have ${available}` };
  }

  // Find matches against the book
  const book = getBook(marketId);
  const matches = book.findMatches(side, priceCents, qty, userId);

  // Calculate total fill qty
  let fillQty = 0;
  for (const m of matches) fillQty += m.fillQty;
  const remainingQty = qty - fillQty;

  // Determine final order status
  let status: 'OPEN' | 'PARTIAL' | 'FILLED' | 'CANCELED';
  if (fillQty === qty) {
    status = 'FILLED';
  } else if (fillQty > 0 && type === 'LIMIT') {
    status = 'PARTIAL';
  } else if (fillQty > 0 && type === 'MARKET') {
    status = remainingQty > 0 ? 'FILLED' : 'FILLED'; // market order: cancel remainder
    // Actually if partially filled, the filled portion is done, remainder canceled
    status = 'FILLED';
  } else if (type === 'MARKET' && fillQty === 0) {
    status = 'CANCELED'; // Nothing to match, cancel
  } else {
    status = 'OPEN'; // Limit order rests
  }

  // Compute actual lock needed (only for resting portion + position locks)
  // For filled portion, lock is released; for resting portion, lock stays
  let actualLockForOrder: number;
  if (type === 'MARKET') {
    // Market orders don't rest; lock only what's needed for fills
    actualLockForOrder = 0;
    for (const m of matches) {
      if (side === 'BUY') {
        actualLockForOrder += m.fillPrice * m.fillQty + calcTakerFee(m.fillPrice, m.fillQty);
      } else {
        actualLockForOrder += (100 - m.fillPrice) * m.fillQty + calcTakerFee(m.fillPrice, m.fillQty);
      }
    }
    if (available < actualLockForOrder) {
      return { orderId, status: 'REJECTED', trades: [], reason: 'Insufficient balance for market order fills' };
    }
  } else {
    actualLockForOrder = requiredLock;
  }

  // Assign sequence
  const seq = nextSeq(marketId);

  // Execute everything in a transaction
  const result = await prisma.$transaction(async (tx) => {
    // Lock wallet
    await tx.wallet.update({
      where: { userId },
      data: { lockedCents: { increment: actualLockForOrder } },
    });

    // Create order record
    const orderRecord = await tx.order.create({
      data: {
        id: orderId,
        marketId,
        userId,
        side,
        type,
        priceCents: priceCents,
        qty,
        remainingQty: status === 'FILLED' || status === 'CANCELED' ? 0 : remainingQty,
        lockedCents: actualLockForOrder,
        status: status === 'PARTIAL' ? 'PARTIAL' : status,
        seq,
        clientOrderId: order.clientOrderId,
      },
    });

    // Log order accepted event
    await tx.eventLog.create({
      data: {
        marketId,
        type: status === 'CANCELED' ? 'OrderRejected' : 'OrderAccepted',
        payload: {
          orderId,
          side,
          type,
          priceCents,
          qty,
          userId,
          status,
        } as unknown as Prisma.InputJsonValue,
        seq,
      },
    });

    // Process each match
    let takerLockReleased = 0;
    let takerCashDelta = 0; // positive = received, negative = paid
    let takerPositionDelta = 0;
    let totalFees = 0;

    for (const match of matches) {
      const tradeSeq = nextSeq(marketId);
      const tradeId = uuid();
      const { entry: makerEntry, fillQty: fq, fillPrice: ep } = match;
      const fee = calcTakerFee(ep, fq);
      totalFees += fee;

      // ── Maker side updates ──

      // Update maker order in book
      book.applyFill(makerEntry.orderId, fq);

      // Compute maker lock release (proportional to fill)
      const makerOrigOrder = await tx.order.findUniqueOrThrow({ where: { id: makerEntry.orderId } });
      const makerLockRelease = makerOrigOrder.remainingQty + fq === 0
        ? makerEntry.lockedCents // Release all remaining if fully filled
        : Math.floor(makerEntry.lockedCents * fq / (makerEntry.remainingQty + fq));

      const makerNewRemaining = makerEntry.remainingQty; // Already decremented by applyFill
      const makerNewStatus = makerNewRemaining === 0 ? 'FILLED' : 'PARTIAL';

      // Update maker entry locked
      makerEntry.lockedCents -= makerLockRelease;

      await tx.order.update({
        where: { id: makerEntry.orderId },
        data: {
          remainingQty: makerNewRemaining,
          lockedCents: { decrement: makerLockRelease },
          status: makerNewStatus,
        },
      });

      // Maker wallet: release lock, adjust balance
      let makerCashDelta: number;
      if (makerOrigOrder.side === 'BUY') {
        // Maker is buyer: pays ep * fq
        makerCashDelta = -(ep * fq);
      } else {
        // Maker is seller: receives ep * fq (no fee for maker)
        makerCashDelta = ep * fq;
      }

      await tx.wallet.update({
        where: { userId: makerEntry.userId },
        data: {
          balanceCents: { increment: makerCashDelta },
          lockedCents: { decrement: makerLockRelease },
        },
      });

      // Maker position update
      const makerPosDelta = makerOrigOrder.side === 'BUY' ? fq : -fq;
      await upsertPosition(tx, marketId, makerEntry.userId, makerPosDelta, ep, fq);

      // ── Taker side accumulation ──
      if (side === 'BUY') {
        // Taker buys: pays ep * fq + fee
        const lockForThisFill = ep * fq + fee;
        takerLockReleased += lockForThisFill;
        takerCashDelta -= (ep * fq + fee);
        takerPositionDelta += fq;
      } else {
        // Taker sells: receives ep * fq - fee
        const lockForThisFill = (100 - ep) * fq + fee;
        takerLockReleased += lockForThisFill;
        takerCashDelta += (ep * fq - fee);
        takerPositionDelta -= fq;
      }

      // Create trade record
      const takerIsBuyer = side === 'BUY';
      await tx.trade.create({
        data: {
          id: tradeId,
          marketId,
          takerOrderId: orderId,
          makerOrderId: makerEntry.orderId,
          priceCents: ep,
          qty: fq,
          takerUserId: userId,
          makerUserId: makerEntry.userId,
          feeCents: fee,
          seq: tradeSeq,
        },
      });

      // Platform fee wallet
      if (fee > 0) {
        await tx.platformFeeWallet.upsert({
          where: { id: 'singleton' },
          create: { id: 'singleton', balanceCents: fee },
          update: { balanceCents: { increment: fee } },
        });
      }

      // Trade event
      await tx.eventLog.create({
        data: {
          marketId,
          type: 'TradeExecuted',
          payload: {
            tradeId,
            takerOrderId: orderId,
            makerOrderId: makerEntry.orderId,
            priceCents: ep,
            qty: fq,
            takerUserId: userId,
            makerUserId: makerEntry.userId,
            feeCents: fee,
            takerSide: side,
          } as unknown as Prisma.InputJsonValue,
          seq: tradeSeq,
        },
      });

      // Maker fill event
      if (makerNewStatus === 'FILLED') {
        await tx.eventLog.create({
          data: {
            marketId,
            type: 'OrderFilled',
            payload: { orderId: makerEntry.orderId } as unknown as Prisma.InputJsonValue,
            seq: tradeSeq,
          },
        });
      }

      trades.push({
        tradeId,
        takerOrderId: orderId,
        makerOrderId: makerEntry.orderId,
        priceCents: ep,
        qty: fq,
        takerUserId: userId,
        makerUserId: makerEntry.userId,
        feeCents: fee,
        seq: tradeSeq,
      });
    }

    // ── Taker wallet update (batched) ──
    if (fillQty > 0) {
      // The taker locked `actualLockForOrder` at the start.
      // For the filled portion, release the lock and apply cash delta.
      // For resting portion (LIMIT), keep lock.
      const lockToRelease = type === 'MARKET' ? actualLockForOrder : takerLockReleased;
      const lockRemaining = actualLockForOrder - lockToRelease;

      await tx.wallet.update({
        where: { userId },
        data: {
          balanceCents: { increment: takerCashDelta },
          lockedCents: { decrement: lockToRelease },
        },
      });

      // Update order locked amount
      await tx.order.update({
        where: { id: orderId },
        data: { lockedCents: lockRemaining },
      });

      // Taker position update
      await upsertPosition(tx, marketId, userId, takerPositionDelta, 0, fillQty);
    }

    // ── Position lock adjustments (for short positions) ──
    // After all fills, recalculate position locks for all affected users
    const affectedUsers = new Set<string>([userId]);
    for (const m of matches) affectedUsers.add(m.entry.userId);

    for (const uid of affectedUsers) {
      await adjustPositionLock(tx, marketId, uid);
    }

    // If taker order status is FILLED, log it
    if (status === 'FILLED' && fillQty > 0) {
      await tx.eventLog.create({
        data: {
          marketId,
          type: 'OrderFilled',
          payload: { orderId } as unknown as Prisma.InputJsonValue,
          seq: nextSeq(marketId),
        },
      });
    }

    // If market order with no fills, log rejection
    if (status === 'CANCELED') {
      await tx.eventLog.create({
        data: {
          marketId,
          type: 'OrderCanceled',
          payload: { orderId, reason: 'No liquidity for market order' } as unknown as Prisma.InputJsonValue,
          seq,
        },
      });
    }

    return status;
  });

  // Add resting order to in-memory book (after DB commit)
  if (result === 'OPEN' || result === 'PARTIAL') {
    const restingEntry: OrderEntry = {
      orderId,
      userId,
      side,
      priceCents: priceCents!,
      remainingQty,
      lockedCents: type === 'MARKET' ? 0 : calcLock(side, 'LIMIT', priceCents!, remainingQty),
      seq,
    };
    book.add(restingEntry);
  }

  log('info', 'Order processed', { orderId, status: result, fills: trades.length, marketId });
  return { orderId, status: result as OrderResult['status'], trades };
}

// ── Cancel Order ────────────────────────────────────

export async function cancelOrder(prisma: PrismaClient, marketId: string, orderId: string, userId: string): Promise<boolean> {
  return withMarketLock(marketId, async () => {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return false;
    if (order.userId !== userId) return false;
    if (order.status !== 'OPEN' && order.status !== 'PARTIAL') return false;

    const book = getBook(marketId);
    const entry = book.remove(orderId);

    await prisma.$transaction(async (tx) => {
      // Release remaining locked funds
      await tx.order.update({
        where: { id: orderId },
        data: { status: 'CANCELED', remainingQty: 0, lockedCents: 0 },
      });

      await tx.wallet.update({
        where: { userId },
        data: { lockedCents: { decrement: order.lockedCents } },
      });

      await tx.eventLog.create({
        data: {
          marketId,
          type: 'OrderCanceled',
          payload: { orderId, userId, remainingQty: order.remainingQty } as unknown as Prisma.InputJsonValue,
          seq: nextSeq(marketId),
        },
      });
    });

    log('info', 'Order canceled', { orderId, marketId });
    return true;
  });
}

// ── Position Helpers ────────────────────────────────

async function upsertPosition(
  tx: Prisma.TransactionClient,
  marketId: string,
  userId: string,
  sharesDelta: number,
  priceCents: number,
  fillQty: number,
) {
  const existing = await tx.position.findUnique({
    where: { marketId_userId: { marketId, userId } },
  });

  if (existing) {
    // Update cost basis (weighted average for buys)
    let newCostBasis = existing.costBasisCents;
    if (sharesDelta > 0 && existing.yesShares >= 0) {
      // Buying more: weighted average
      const totalShares = existing.yesShares + sharesDelta;
      newCostBasis = totalShares > 0
        ? Math.floor((existing.costBasisCents * existing.yesShares + priceCents * sharesDelta) / totalShares)
        : 0;
    } else if (sharesDelta < 0 && existing.yesShares > 0) {
      // Selling: realize PnL
      const soldQty = Math.min(Math.abs(sharesDelta), existing.yesShares);
      const pnl = (priceCents - existing.costBasisCents) * soldQty;
      await tx.position.update({
        where: { marketId_userId: { marketId, userId } },
        data: {
          yesShares: { increment: sharesDelta },
          realizedPnlCents: { increment: pnl },
          costBasisCents: newCostBasis,
        },
      });
      return;
    }

    await tx.position.update({
      where: { marketId_userId: { marketId, userId } },
      data: {
        yesShares: { increment: sharesDelta },
        costBasisCents: newCostBasis,
      },
    });
  } else {
    await tx.position.create({
      data: {
        marketId,
        userId,
        yesShares: sharesDelta,
        costBasisCents: sharesDelta > 0 ? priceCents : 0,
      },
    });
  }
}

/**
 * After fills, adjust wallet locked_cents for short position collateral.
 * Short position lock = max(0, -yesShares) * 100 per share.
 */
async function adjustPositionLock(
  tx: Prisma.TransactionClient,
  marketId: string,
  userId: string,
) {
  const position = await tx.position.findUnique({
    where: { marketId_userId: { marketId, userId } },
  });

  if (!position) return;

  // Calculate total required position lock across ALL markets for this user
  const allPositions = await tx.position.findMany({ where: { userId } });

  let totalPositionLock = 0;
  for (const pos of allPositions) {
    if (pos.yesShares < 0) {
      totalPositionLock += Math.abs(pos.yesShares) * 100;
    }
  }

  // Calculate total order lock for this user
  const openOrders = await tx.order.findMany({
    where: { userId, status: { in: ['OPEN', 'PARTIAL'] } },
  });
  const totalOrderLock = openOrders.reduce((sum, o) => sum + o.lockedCents, 0);

  // Set wallet locked = order lock + position lock
  const targetLocked = totalOrderLock + totalPositionLock;

  await tx.wallet.update({
    where: { userId },
    data: { lockedCents: targetLocked },
  });
}

// ── Book Rebuild on Startup ─────────────────────────

export async function rebuildBook(prisma: PrismaClient, marketId: string): Promise<void> {
  const book = new OrderBook();
  marketBooks.set(marketId, book);

  // Load all OPEN/PARTIAL orders for this market, ordered by seq
  const orders = await prisma.order.findMany({
    where: {
      marketId,
      status: { in: ['OPEN', 'PARTIAL'] },
    },
    orderBy: { seq: 'asc' },
  });

  for (const order of orders) {
    if (order.priceCents === null) continue; // Skip market orders (shouldn't be resting)
    book.add({
      orderId: order.id,
      userId: order.userId,
      side: order.side as 'BUY' | 'SELL',
      priceCents: order.priceCents,
      remainingQty: order.remainingQty,
      lockedCents: order.lockedCents,
      seq: order.seq,
    });
  }

  // Restore seq counter
  const lastEvent = await prisma.eventLog.findFirst({
    where: { marketId },
    orderBy: { seq: 'desc' },
  });
  if (lastEvent?.seq) {
    marketSeqs.set(marketId, lastEvent.seq);
  }

  log('info', 'Book rebuilt', { marketId, orders: orders.length });
}

export async function rebuildAllBooks(prisma: PrismaClient): Promise<void> {
  const openMarkets = await prisma.market.findMany({ where: { status: 'OPEN' } });
  for (const market of openMarkets) {
    await rebuildBook(prisma, market.id);
  }
  log('info', 'All books rebuilt', { count: openMarkets.length });
}
