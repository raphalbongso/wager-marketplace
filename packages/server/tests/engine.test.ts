import { describe, it, expect, beforeEach } from "vitest";
import { OrderBook } from "../src/engine/book.js";
import { MatchingEngine } from "../src/engine/engine.js";
import { lockRequired, computeTakerFee, positionLockPerShare } from "../src/engine/collateral.js";
import type { IncomingOrder, OrderRef } from "../src/engine/types.js";

// ── OrderBook unit tests ────────────────────────────────────

describe("OrderBook", () => {
  let book: OrderBook;

  beforeEach(() => {
    book = new OrderBook();
  });

  it("tracks best bid and ask", () => {
    book.addOrder(makeRef("b1", "BUY", 50, 10, 1n));
    book.addOrder(makeRef("b2", "BUY", 55, 5, 2n));
    book.addOrder(makeRef("a1", "SELL", 60, 10, 3n));
    book.addOrder(makeRef("a2", "SELL", 58, 5, 4n));

    expect(book.bestBid()).toBe(55);
    expect(book.bestAsk()).toBe(58);
  });

  it("returns null for empty sides", () => {
    expect(book.bestBid()).toBeNull();
    expect(book.bestAsk()).toBeNull();
  });

  it("removes orders and cleans up empty levels", () => {
    book.addOrder(makeRef("b1", "BUY", 50, 10, 1n));
    const removed = book.removeOrder("b1");
    expect(removed).not.toBeNull();
    expect(removed!.orderId).toBe("b1");
    expect(book.bestBid()).toBeNull();
    expect(book.orderCount()).toBe(0);
  });

  it("maintains FIFO within a price level", () => {
    book.addOrder(makeRef("a1", "SELL", 60, 10, 1n));
    book.addOrder(makeRef("a2", "SELL", 60, 5, 2n));

    const levels = book.getTopAsks(10);
    expect(levels).toHaveLength(1);
    expect(levels[0]!.totalQty).toBe(15);
    expect(levels[0]!.orderCount).toBe(2);
  });

  it("sorts bids descending and asks ascending", () => {
    book.addOrder(makeRef("b1", "BUY", 40, 1, 1n));
    book.addOrder(makeRef("b2", "BUY", 60, 1, 2n));
    book.addOrder(makeRef("b3", "BUY", 50, 1, 3n));

    const bids = book.getTopBids(10);
    expect(bids.map((l) => l.priceCents)).toEqual([60, 50, 40]);

    book.addOrder(makeRef("a1", "SELL", 70, 1, 4n));
    book.addOrder(makeRef("a2", "SELL", 65, 1, 5n));
    book.addOrder(makeRef("a3", "SELL", 80, 1, 6n));

    const asks = book.getTopAsks(10);
    expect(asks.map((l) => l.priceCents)).toEqual([65, 70, 80]);
  });

  it("updateRemaining modifies in-place", () => {
    book.addOrder(makeRef("a1", "SELL", 60, 10, 1n));
    book.updateRemaining("a1", 3);
    const levels = book.getTopAsks(10);
    expect(levels[0]!.totalQty).toBe(3);
  });
});

// ── MatchingEngine tests ────────────────────────────────────

describe("MatchingEngine", () => {
  let engine: MatchingEngine;
  const MKT = "market-1";
  const FEE_BPS = 100; // 1%

  beforeEach(() => {
    engine = new MatchingEngine(FEE_BPS);
  });

  function seedBook() {
    const book = engine.getOrCreateBook(MKT);
    // Asks: 55(10), 58(5), 60(20)
    book.addOrder(makeRef("ask-55", "SELL", 55, 10, 1n));
    book.addOrder(makeRef("ask-58", "SELL", 58, 5, 2n));
    book.addOrder(makeRef("ask-60", "SELL", 60, 20, 3n));
    // Bids: 50(10), 48(5), 45(20)
    book.addOrder(makeRef("bid-50", "BUY", 50, 10, 4n));
    book.addOrder(makeRef("bid-48", "BUY", 48, 5, 5n));
    book.addOrder(makeRef("bid-45", "BUY", 45, 20, 6n));
    engine.setSeqCounter(MKT, 6n);
  }

  // ── Price-time priority ────────────────────────────────────

  it("BUY matches lowest ask first (price priority)", () => {
    seedBook();
    const result = engine.processOrder(buyLimit("o1", MKT, 60, 5));
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]!.priceCents).toBe(55); // best ask
    expect(result.fills[0]!.qty).toBe(5);
    expect(result.status).toBe("FILLED");
  });

  it("SELL matches highest bid first (price priority)", () => {
    seedBook();
    const result = engine.processOrder(sellLimit("o1", MKT, 45, 5));
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]!.priceCents).toBe(50); // best bid
    expect(result.fills[0]!.qty).toBe(5);
    expect(result.status).toBe("FILLED");
  });

  it("FIFO within same price level", () => {
    const book = engine.getOrCreateBook(MKT);
    book.addOrder(makeRef("a1", "SELL", 55, 5, 1n));
    book.addOrder(makeRef("a2", "SELL", 55, 5, 2n));
    engine.setSeqCounter(MKT, 2n);

    const result = engine.processOrder(buyLimit("o1", MKT, 55, 7));
    expect(result.fills).toHaveLength(2);
    expect(result.fills[0]!.makerOrderId).toBe("a1"); // first in = first matched
    expect(result.fills[0]!.qty).toBe(5);
    expect(result.fills[1]!.makerOrderId).toBe("a2");
    expect(result.fills[1]!.qty).toBe(2);
    expect(result.status).toBe("FILLED");
  });

  // ── Partial fill across multiple levels ────────────────────

  it("fills across multiple ask levels", () => {
    seedBook();
    const result = engine.processOrder(buyLimit("o1", MKT, 60, 18));

    expect(result.fills).toHaveLength(3);
    expect(result.fills[0]!.priceCents).toBe(55);
    expect(result.fills[0]!.qty).toBe(10);
    expect(result.fills[1]!.priceCents).toBe(58);
    expect(result.fills[1]!.qty).toBe(5);
    expect(result.fills[2]!.priceCents).toBe(60);
    expect(result.fills[2]!.qty).toBe(3);
    expect(result.status).toBe("FILLED");
    expect(result.remainingQty).toBe(0);
  });

  it("partial fill rests remainder on book for LIMIT", () => {
    seedBook();
    // Buy 50 at 60: only 35 available (10+5+20), remainder rests
    const result = engine.processOrder(buyLimit("o1", MKT, 60, 50));
    expect(result.fills).toHaveLength(3);
    const totalFilled = result.fills.reduce((s, f) => s + f.qty, 0);
    expect(totalFilled).toBe(35);
    expect(result.remainingQty).toBe(15);
    expect(result.status).toBe("PARTIAL");
    expect(result.restingOrder).not.toBeNull();
    expect(result.restingOrder!.remainingQty).toBe(15);
  });

  // ── Market order remainder cancels ─────────────────────────

  it("MARKET order cancels unfilled remainder", () => {
    seedBook();
    const result = engine.processOrder({
      orderId: "mkt-1", userId: "u1", marketId: MKT,
      side: "BUY", type: "MARKET", priceCents: null, qty: 50,
    });
    const totalFilled = result.fills.reduce((s, f) => s + f.qty, 0);
    expect(totalFilled).toBe(35);
    expect(result.status).toBe("CANCELED"); // partial fill + cancel
    expect(result.restingOrder).toBeNull();
  });

  it("MARKET order that fully fills is FILLED", () => {
    seedBook();
    const result = engine.processOrder({
      orderId: "mkt-1", userId: "u1", marketId: MKT,
      side: "BUY", type: "MARKET", priceCents: null, qty: 5,
    });
    expect(result.status).toBe("FILLED");
  });

  it("MARKET order with no liquidity is REJECTED", () => {
    engine.getOrCreateBook(MKT); // empty book
    const result = engine.processOrder({
      orderId: "mkt-1", userId: "u1", marketId: MKT,
      side: "BUY", type: "MARKET", priceCents: null, qty: 5,
    });
    expect(result.status).toBe("REJECTED");
    expect(result.fills).toHaveLength(0);
  });

  // ── Cancel ─────────────────────────────────────────────────

  it("cancel removes order from book", () => {
    seedBook();
    // Apply a resting order
    const result = engine.processOrder(buyLimit("rest-1", MKT, 40, 10));
    engine.applyResult(MKT, result);
    expect(result.status).toBe("OPEN");

    const cancelResult = engine.cancelOrder(MKT, "rest-1");
    expect(cancelResult.success).toBe(true);
    expect(engine.getBook(MKT)!.hasOrder("rest-1")).toBe(false);
  });

  it("cancel non-existent order returns false", () => {
    engine.getOrCreateBook(MKT);
    const result = engine.cancelOrder(MKT, "nonexistent");
    expect(result.success).toBe(false);
  });

  // ── BUY does not cross higher asks ─────────────────────────

  it("BUY LIMIT does not match ask above limit price", () => {
    seedBook();
    const result = engine.processOrder(buyLimit("o1", MKT, 54, 10));
    expect(result.fills).toHaveLength(0);
    expect(result.status).toBe("OPEN");
  });

  // ── Apply result updates book state ────────────────────────

  it("applyResult removes exhausted makers and adds resting", () => {
    seedBook();
    const result = engine.processOrder(buyLimit("o1", MKT, 55, 10)); // fill all of ask-55
    engine.applyResult(MKT, result);

    expect(engine.getBook(MKT)!.hasOrder("ask-55")).toBe(false);
    expect(engine.getBook(MKT)!.bestAsk()).toBe(58);
  });

  // ── Rebuild book from persisted orders ─────────────────────

  it("rebuildBook restores book state", () => {
    const orders: OrderRef[] = [
      makeRef("b1", "BUY", 50, 10, 1n),
      makeRef("a1", "SELL", 60, 5, 2n),
    ];
    engine.rebuildBook(MKT, orders);
    expect(engine.getBook(MKT)!.bestBid()).toBe(50);
    expect(engine.getBook(MKT)!.bestAsk()).toBe(60);
  });
});

// ── Collateral tests ────────────────────────────────────────

describe("Collateral", () => {
  it("BUY LIMIT lock = price * qty + fee", () => {
    const lock = lockRequired("BUY", "LIMIT", 50, 10, 100);
    // base: 50*10=500, fee: ceil(50*10*100/10000)=ceil(5)=5
    expect(lock).toBe(505);
  });

  it("SELL LIMIT lock = (100-price) * qty + fee", () => {
    const lock = lockRequired("SELL", "LIMIT", 60, 10, 100);
    // base: (100-60)*10=400, fee: ceil(60*10*100/10000)=ceil(6)=6
    expect(lock).toBe(406);
  });

  it("MARKET order locks at worst-case price 99", () => {
    const buyLock = lockRequired("BUY", "MARKET", null, 10, 100);
    // base: 99*10=990, fee: ceil(99*10*100/10000)=ceil(9.9)=10
    expect(buyLock).toBe(1000);

    const sellLock = lockRequired("SELL", "MARKET", null, 10, 100);
    // base: (100-99)*10=10, fee: ceil(99*10*100/10000)=10
    expect(sellLock).toBe(20);
  });

  it("taker fee is floor of notional * bps / 10000", () => {
    expect(computeTakerFee(55, 10, 100)).toBe(5); // floor(55*10*100/10000)=floor(5.5)=5
    expect(computeTakerFee(50, 10, 100)).toBe(5); // floor(50*10*100/10000)=5
    expect(computeTakerFee(99, 1, 100)).toBe(0);  // floor(0.99)=0
  });

  it("position lock for short = (100 - execPrice) per share", () => {
    expect(positionLockPerShare(60)).toBe(40);
    expect(positionLockPerShare(99)).toBe(1);
    expect(positionLockPerShare(1)).toBe(99);
  });
});

// ── Taker fee applied correctly ─────────────────────────────

describe("Taker fee in engine", () => {
  it("fills include correct taker fee", () => {
    const engine = new MatchingEngine(100); // 1%
    const book = engine.getOrCreateBook("m1");
    book.addOrder(makeRef("ask", "SELL", 50, 10, 1n));
    engine.setSeqCounter("m1", 1n);

    const result = engine.processOrder(buyLimit("buy", "m1", 50, 10));
    expect(result.fills).toHaveLength(1);
    // Fee = floor(50 * 10 * 100 / 10000) = floor(5) = 5
    expect(result.fills[0]!.takerFeeCents).toBe(5);
  });
});

// ── Event log append-only behavior ──────────────────────────

describe("Event sourcing properties", () => {
  it("each accepted order gets sequential seq number", () => {
    const engine = new MatchingEngine(100);
    engine.getOrCreateBook("m1");

    const r1 = engine.processOrder(buyLimit("o1", "m1", 40, 5));
    const r2 = engine.processOrder(buyLimit("o2", "m1", 45, 5));

    expect(r1.restingOrder!.seq).toBe(1n);
    expect(r2.restingOrder!.seq).toBe(2n);
  });

  it("seq counter restored by rebuildBook", () => {
    const engine = new MatchingEngine(100);
    engine.rebuildBook("m1", [
      makeRef("o1", "BUY", 50, 10, 5n),
      makeRef("o2", "SELL", 60, 10, 10n),
    ]);

    const result = engine.processOrder(buyLimit("o3", "m1", 40, 5));
    expect(result.restingOrder!.seq).toBe(11n);
  });
});

// ── Helpers ─────────────────────────────────────────────────

function makeRef(id: string, side: "BUY" | "SELL", price: number, qty: number, seq: bigint): OrderRef {
  return { orderId: id, userId: "u-maker", side, priceCents: price, remainingQty: qty, timestamp: new Date(), seq };
}

function buyLimit(id: string, market: string, price: number, qty: number): IncomingOrder {
  return { orderId: id, userId: "u1", marketId: market, side: "BUY", type: "LIMIT", priceCents: price, qty };
}

function sellLimit(id: string, market: string, price: number, qty: number): IncomingOrder {
  return { orderId: id, userId: "u1", marketId: market, side: "SELL", type: "LIMIT", priceCents: price, qty };
}
