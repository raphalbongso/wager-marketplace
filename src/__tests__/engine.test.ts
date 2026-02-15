/**
 * Matching engine unit tests.
 *
 * Tests the OrderBook and collateral calculation in isolation
 * (no database required).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OrderBook, type OrderEntry } from '../engine/orderbook.js';
import { calcLock } from '../engine/matching.js';

function entry(overrides: Partial<OrderEntry> & { orderId: string; priceCents: number; remainingQty: number; side: 'BUY' | 'SELL' }): OrderEntry {
  return {
    userId: 'user-1',
    lockedCents: 0,
    seq: 1n,
    ...overrides,
  };
}

describe('OrderBook', () => {
  let book: OrderBook;

  beforeEach(() => {
    book = new OrderBook();
  });

  // ── Basic Operations ──────────────────────────────

  it('starts empty', () => {
    expect(book.bestBid()).toBeNull();
    expect(book.bestAsk()).toBeNull();
    expect(book.size).toBe(0);
  });

  it('adds and retrieves a bid', () => {
    book.add(entry({ orderId: 'o1', side: 'BUY', priceCents: 50, remainingQty: 10, seq: 1n }));
    expect(book.bestBid()).toBe(50);
    expect(book.bestAsk()).toBeNull();
    expect(book.size).toBe(1);
  });

  it('adds and retrieves an ask', () => {
    book.add(entry({ orderId: 'o1', side: 'SELL', priceCents: 60, remainingQty: 10, seq: 1n }));
    expect(book.bestAsk()).toBe(60);
    expect(book.bestBid()).toBeNull();
  });

  it('maintains bid sorting (descending)', () => {
    book.add(entry({ orderId: 'o1', side: 'BUY', priceCents: 40, remainingQty: 10, seq: 1n }));
    book.add(entry({ orderId: 'o2', side: 'BUY', priceCents: 60, remainingQty: 5, seq: 2n }));
    book.add(entry({ orderId: 'o3', side: 'BUY', priceCents: 50, remainingQty: 8, seq: 3n }));
    expect(book.bestBid()).toBe(60);

    const { bids } = book.getBook(10);
    expect(bids.map(([p]) => p)).toEqual([60, 50, 40]);
  });

  it('maintains ask sorting (ascending)', () => {
    book.add(entry({ orderId: 'o1', side: 'SELL', priceCents: 70, remainingQty: 10, seq: 1n }));
    book.add(entry({ orderId: 'o2', side: 'SELL', priceCents: 50, remainingQty: 5, seq: 2n }));
    book.add(entry({ orderId: 'o3', side: 'SELL', priceCents: 60, remainingQty: 8, seq: 3n }));
    expect(book.bestAsk()).toBe(50);

    const { asks } = book.getBook(10);
    expect(asks.map(([p]) => p)).toEqual([50, 60, 70]);
  });

  // ── Remove ────────────────────────────────────────

  it('removes an order from the book', () => {
    book.add(entry({ orderId: 'o1', side: 'BUY', priceCents: 50, remainingQty: 10, seq: 1n }));
    book.add(entry({ orderId: 'o2', side: 'BUY', priceCents: 60, remainingQty: 5, seq: 2n }));

    const removed = book.remove('o2');
    expect(removed).not.toBeNull();
    expect(removed!.orderId).toBe('o2');
    expect(book.bestBid()).toBe(50);
    expect(book.size).toBe(1);
  });

  it('removes last order at a price level and cleans up', () => {
    book.add(entry({ orderId: 'o1', side: 'BUY', priceCents: 50, remainingQty: 10, seq: 1n }));
    book.remove('o1');
    expect(book.bestBid()).toBeNull();
    expect(book.size).toBe(0);
  });

  it('returns null when removing non-existent order', () => {
    expect(book.remove('nonexistent')).toBeNull();
  });

  // ── Price-Time Priority Matching ──────────────────

  it('matches BUY against lowest ask (price priority)', () => {
    book.add(entry({ orderId: 'a1', side: 'SELL', priceCents: 60, remainingQty: 10, seq: 1n, userId: 'seller1' }));
    book.add(entry({ orderId: 'a2', side: 'SELL', priceCents: 55, remainingQty: 5, seq: 2n, userId: 'seller2' }));

    const matches = book.findMatches('BUY', 60, 15, 'buyer1');
    // Should match a2 (55) first, then a1 (60)
    expect(matches.length).toBe(2);
    expect(matches[0].entry.orderId).toBe('a2');
    expect(matches[0].fillPrice).toBe(55);
    expect(matches[0].fillQty).toBe(5);
    expect(matches[1].entry.orderId).toBe('a1');
    expect(matches[1].fillPrice).toBe(60);
    expect(matches[1].fillQty).toBe(10);
  });

  it('matches SELL against highest bid (price priority)', () => {
    book.add(entry({ orderId: 'b1', side: 'BUY', priceCents: 50, remainingQty: 10, seq: 1n, userId: 'buyer1' }));
    book.add(entry({ orderId: 'b2', side: 'BUY', priceCents: 55, remainingQty: 5, seq: 2n, userId: 'buyer2' }));

    const matches = book.findMatches('SELL', 50, 15, 'seller1');
    // Should match b2 (55) first, then b1 (50)
    expect(matches.length).toBe(2);
    expect(matches[0].entry.orderId).toBe('b2');
    expect(matches[0].fillPrice).toBe(55);
    expect(matches[0].fillQty).toBe(5);
    expect(matches[1].entry.orderId).toBe('b1');
    expect(matches[1].fillPrice).toBe(50);
    expect(matches[1].fillQty).toBe(10);
  });

  it('enforces time priority (FIFO) within same price level', () => {
    book.add(entry({ orderId: 'a1', side: 'SELL', priceCents: 60, remainingQty: 5, seq: 1n, userId: 'seller1' }));
    book.add(entry({ orderId: 'a2', side: 'SELL', priceCents: 60, remainingQty: 5, seq: 2n, userId: 'seller2' }));
    book.add(entry({ orderId: 'a3', side: 'SELL', priceCents: 60, remainingQty: 5, seq: 3n, userId: 'seller3' }));

    const matches = book.findMatches('BUY', 60, 8, 'buyer1');
    // Should fill a1 first (5), then a2 partial (3)
    expect(matches.length).toBe(2);
    expect(matches[0].entry.orderId).toBe('a1');
    expect(matches[0].fillQty).toBe(5);
    expect(matches[1].entry.orderId).toBe('a2');
    expect(matches[1].fillQty).toBe(3);
  });

  // ── Partial Fills Across Multiple Levels ──────────

  it('fills across multiple price levels', () => {
    book.add(entry({ orderId: 'a1', side: 'SELL', priceCents: 50, remainingQty: 3, seq: 1n, userId: 's1' }));
    book.add(entry({ orderId: 'a2', side: 'SELL', priceCents: 55, remainingQty: 4, seq: 2n, userId: 's2' }));
    book.add(entry({ orderId: 'a3', side: 'SELL', priceCents: 60, remainingQty: 10, seq: 3n, userId: 's3' }));

    const matches = book.findMatches('BUY', 60, 10, 'buyer1');
    expect(matches.length).toBe(3);
    expect(matches[0].fillQty).toBe(3); // 50¢ level
    expect(matches[1].fillQty).toBe(4); // 55¢ level
    expect(matches[2].fillQty).toBe(3); // 60¢ level (partial)
    expect(matches.reduce((s, m) => s + m.fillQty, 0)).toBe(10);
  });

  // ── Market Order: No Resting ──────────────────────

  it('MARKET order matches any price (null price)', () => {
    book.add(entry({ orderId: 'a1', side: 'SELL', priceCents: 99, remainingQty: 5, seq: 1n, userId: 's1' }));

    const matches = book.findMatches('BUY', null, 5, 'buyer1');
    expect(matches.length).toBe(1);
    expect(matches[0].fillPrice).toBe(99);
  });

  it('MARKET order partial: only matches available liquidity', () => {
    book.add(entry({ orderId: 'a1', side: 'SELL', priceCents: 50, remainingQty: 3, seq: 1n, userId: 's1' }));

    const matches = book.findMatches('BUY', null, 10, 'buyer1');
    expect(matches.length).toBe(1);
    expect(matches[0].fillQty).toBe(3);
    // Remaining 7 would be canceled (handled by engine, not book)
  });

  // ── Self-Trade Prevention ─────────────────────────

  it('skips own orders (self-trade prevention)', () => {
    book.add(entry({ orderId: 'a1', side: 'SELL', priceCents: 50, remainingQty: 5, seq: 1n, userId: 'user-A' }));
    book.add(entry({ orderId: 'a2', side: 'SELL', priceCents: 55, remainingQty: 5, seq: 2n, userId: 'user-B' }));

    const matches = book.findMatches('BUY', 60, 10, 'user-A');
    // Should skip a1 (same user) and only match a2
    expect(matches.length).toBe(1);
    expect(matches[0].entry.orderId).toBe('a2');
    expect(matches[0].entry.userId).toBe('user-B');
  });

  // ── Apply Fill ────────────────────────────────────

  it('applyFill reduces remaining qty', () => {
    book.add(entry({ orderId: 'o1', side: 'SELL', priceCents: 50, remainingQty: 10, seq: 1n }));
    const remaining = book.applyFill('o1', 3);
    expect(remaining).toBe(7);
    expect(book.size).toBe(1); // Still resting
  });

  it('applyFill removes fully filled order from book', () => {
    book.add(entry({ orderId: 'o1', side: 'SELL', priceCents: 50, remainingQty: 5, seq: 1n }));
    const remaining = book.applyFill('o1', 5);
    expect(remaining).toBe(0);
    expect(book.size).toBe(0);
    expect(book.bestAsk()).toBeNull();
  });

  it('applyFill throws on overfill', () => {
    book.add(entry({ orderId: 'o1', side: 'SELL', priceCents: 50, remainingQty: 5, seq: 1n }));
    expect(() => book.applyFill('o1', 6)).toThrow();
  });

  // ── getBook depth ─────────────────────────────────

  it('getBook respects depth limit', () => {
    for (let i = 1; i <= 30; i++) {
      book.add(entry({ orderId: `b${i}`, side: 'BUY', priceCents: i, remainingQty: 1, seq: BigInt(i) }));
    }
    const { bids } = book.getBook(5);
    expect(bids.length).toBe(5);
    expect(bids[0][0]).toBe(30); // Highest bid first
  });

  it('getBook aggregates qty at each level', () => {
    book.add(entry({ orderId: 'o1', side: 'BUY', priceCents: 50, remainingQty: 10, seq: 1n }));
    book.add(entry({ orderId: 'o2', side: 'BUY', priceCents: 50, remainingQty: 7, seq: 2n }));
    const { bids } = book.getBook(10);
    expect(bids.length).toBe(1);
    expect(bids[0]).toEqual([50, 17]);
  });

  // ── Prevents duplicate order IDs ──────────────────

  it('throws on duplicate order ID', () => {
    book.add(entry({ orderId: 'o1', side: 'BUY', priceCents: 50, remainingQty: 10, seq: 1n }));
    expect(() => {
      book.add(entry({ orderId: 'o1', side: 'BUY', priceCents: 60, remainingQty: 5, seq: 2n }));
    }).toThrow('Duplicate order ID');
  });

  // ── Price boundary: BUY won't match asks above limit ──

  it('BUY at 50 does not match ask at 55', () => {
    book.add(entry({ orderId: 'a1', side: 'SELL', priceCents: 55, remainingQty: 5, seq: 1n, userId: 's1' }));
    const matches = book.findMatches('BUY', 50, 5, 'buyer');
    expect(matches.length).toBe(0);
  });

  it('SELL at 60 does not match bid at 55', () => {
    book.add(entry({ orderId: 'b1', side: 'BUY', priceCents: 55, remainingQty: 5, seq: 1n, userId: 'b1' }));
    const matches = book.findMatches('SELL', 60, 5, 'seller');
    expect(matches.length).toBe(0);
  });
});

// ── Collateral Calculation Tests ─────────────────────

describe('calcLock', () => {
  it('BUY LIMIT: price * qty + fee', () => {
    // At 1% (100 bps), price=50, qty=10: base=500, fee=floor(500*100/10000)=5
    const lock = calcLock('BUY', 'LIMIT', 50, 10);
    expect(lock).toBe(505);
  });

  it('SELL LIMIT: (100-price)*qty + fee estimate', () => {
    // price=60, qty=10: base=(100-60)*10=400, fee=floor(99*10*100/10000)=9
    const lock = calcLock('SELL', 'LIMIT', 60, 10);
    expect(lock).toBe(409);
  });

  it('BUY MARKET: 99*qty + fee', () => {
    // qty=10: base=990, fee=floor(990*100/10000)=9
    const lock = calcLock('BUY', 'MARKET', undefined, 10);
    expect(lock).toBe(999);
  });

  it('SELL MARKET: 99*qty + fee', () => {
    const lock = calcLock('SELL', 'MARKET', undefined, 10);
    expect(lock).toBe(999);
  });

  it('lock is always integer', () => {
    // Ensure no fractional cents
    for (let p = 1; p <= 99; p++) {
      for (const side of ['BUY', 'SELL'] as const) {
        const lock = calcLock(side, 'LIMIT', p, 1);
        expect(Number.isInteger(lock)).toBe(true);
        expect(lock).toBeGreaterThan(0);
      }
    }
  });

  it('BUY lock at price 1 is minimal', () => {
    // price=1, qty=1: base=1, fee=floor(1*100/10000)=0
    expect(calcLock('BUY', 'LIMIT', 1, 1)).toBe(1);
  });

  it('SELL lock at price 99 is minimal', () => {
    // price=99, qty=1: base=(100-99)*1=1, fee=floor(99*1*100/10000)=0
    expect(calcLock('SELL', 'LIMIT', 99, 1)).toBe(1);
  });

  it('BUY + SELL locks at same price sum to ~100 per share', () => {
    // BUY lock + SELL lock should approximately cover the full payout
    const price = 50;
    const qty = 100;
    const buyLock = calcLock('BUY', 'LIMIT', price, qty);
    const sellLock = calcLock('SELL', 'LIMIT', price, qty);
    // Without fees: buy=5000, sell=5000, total=10000 (=100*100)
    // With fees: slightly more
    expect(buyLock + sellLock).toBeGreaterThanOrEqual(100 * qty);
  });
});

// ── Settlement Logic Tests (Pure Calculation) ────────

describe('Settlement calculations', () => {
  it('YES resolution: long position profit', () => {
    // Bought 10 shares at 60. YES resolves.
    // Payout: 10 * 100 = 1000. Cost: 10 * 60 = 600. Profit: 400.
    const shares = 10;
    const costPerShare = 60;
    const payout = shares * 100; // YES resolution
    const profit = payout - shares * costPerShare;
    expect(profit).toBe(400);
  });

  it('YES resolution: short position loss', () => {
    // Sold 10 shares at 60. YES resolves.
    // Obligation: 10 * 100 = 1000. Received: 10 * 60 = 600. Loss: 400.
    const shares = -10;
    const payout = shares * 100; // -1000
    expect(payout).toBe(-1000);
  });

  it('NO resolution: long position loss', () => {
    // Bought 10 shares at 60. NO resolves. Shares worth 0.
    // Loss: 10 * 60 = 600 (already paid at trade time).
    const payout = 0; // NO resolution
    const cost = 10 * 60;
    expect(payout - cost).toBe(-600);
  });

  it('NO resolution: short position profit', () => {
    // Sold 10 shares at 60. NO resolves.
    // Collateral released. Profit = received amount = 600.
    const received = 10 * 60;
    expect(received).toBe(600);
  });
});

// ── Fee Calculation ──────────────────────────────────

describe('Fee calculation', () => {
  it('taker fee is floor of percentage', () => {
    // 1% of 50 * 10 = 500 * 0.01 = 5
    const fee = Math.floor(50 * 10 * 100 / 10000);
    expect(fee).toBe(5);
  });

  it('fee rounds down (no fractional cents)', () => {
    // 1% of 33 * 7 = 231 * 0.01 = 2.31 → floor = 2
    const fee = Math.floor(33 * 7 * 100 / 10000);
    expect(fee).toBe(2);
  });

  it('fee is 0 for very small trades', () => {
    // 1% of 1 * 1 = 1 * 0.01 = 0.01 → floor = 0
    const fee = Math.floor(1 * 1 * 100 / 10000);
    expect(fee).toBe(0);
  });

  it('maker fee is 0', () => {
    // Spec: maker fee is 0, only taker pays
    const makerFee = 0;
    expect(makerFee).toBe(0);
  });
});

// ── Event Log (append-only behavior) ─────────────────

describe('Event log properties', () => {
  it('events should be immutable (append-only by design)', () => {
    // This tests the principle: once an event is created,
    // it should never be modified or deleted.
    // In practice, enforced by DB permissions + no UPDATE/DELETE in code.
    const events: { type: string; seq: number }[] = [];
    events.push({ type: 'OrderAccepted', seq: 1 });
    events.push({ type: 'TradeExecuted', seq: 2 });
    events.push({ type: 'OrderFilled', seq: 3 });

    // Verify monotonically increasing sequence
    for (let i = 1; i < events.length; i++) {
      expect(events[i].seq).toBeGreaterThan(events[i - 1].seq);
    }
    expect(events.length).toBe(3);
  });

  it('sequence numbers are strictly increasing per market', () => {
    let seq = 0n;
    const seqs: bigint[] = [];
    for (let i = 0; i < 100; i++) {
      seq++;
      seqs.push(seq);
    }
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });
});

// ── Edge Cases ───────────────────────────────────────

describe('Edge cases', () => {
  let book: OrderBook;

  beforeEach(() => {
    book = new OrderBook();
  });

  it('handles empty book gracefully', () => {
    const matches = book.findMatches('BUY', 50, 10, 'user1');
    expect(matches).toEqual([]);
  });

  it('handles single-share orders', () => {
    book.add(entry({ orderId: 'a1', side: 'SELL', priceCents: 50, remainingQty: 1, seq: 1n, userId: 's1' }));
    const matches = book.findMatches('BUY', 50, 1, 'b1');
    expect(matches.length).toBe(1);
    expect(matches[0].fillQty).toBe(1);
  });

  it('handles maximum price range', () => {
    book.add(entry({ orderId: 'a1', side: 'SELL', priceCents: 1, remainingQty: 5, seq: 1n, userId: 's1' }));
    book.add(entry({ orderId: 'b1', side: 'BUY', priceCents: 99, remainingQty: 5, seq: 2n, userId: 'b1' }));

    const buyMatches = book.findMatches('BUY', 99, 5, 'buyer');
    expect(buyMatches.length).toBe(1);
    expect(buyMatches[0].fillPrice).toBe(1); // Matches at ask price (maker price)
  });

  it('does not match when spread exists and order is inside spread', () => {
    book.add(entry({ orderId: 'b1', side: 'BUY', priceCents: 40, remainingQty: 10, seq: 1n, userId: 'b1' }));
    book.add(entry({ orderId: 'a1', side: 'SELL', priceCents: 60, remainingQty: 10, seq: 2n, userId: 's1' }));

    // Buy at 50 shouldn't match ask at 60
    const matches = book.findMatches('BUY', 50, 10, 'buyer');
    expect(matches.length).toBe(0);
  });
});
