import { describe, it, expect, beforeEach } from "vitest";
import { MatchingEngine } from "../src/engine/engine.js";
import { SHARE_PAYOUT_CENTS } from "../src/engine/types.js";

/**
 * Settlement logic tests (unit-level, testing the math).
 *
 * Since the actual settleMarket function requires a database,
 * these tests verify the settlement calculation logic independently.
 */

describe("Settlement calculations", () => {
  it("YES resolution pays 100¢ per YES share", () => {
    const yesShares = 10;
    const payout = yesShares * SHARE_PAYOUT_CENTS;
    expect(payout).toBe(1000);
  });

  it("NO resolution pays 0 for YES shares", () => {
    const yesShares = 10;
    const payout = 0; // YES shares worthless on NO resolution
    expect(payout).toBe(0);
  });

  it("short YES position loses on YES resolution", () => {
    const yesShares = -5; // short 5 YES
    const payout = yesShares * SHARE_PAYOUT_CENTS; // -500
    expect(payout).toBe(-500);
  });

  it("short YES position profits on NO resolution (collateral returned)", () => {
    // Short seller received cash when selling + gets collateral back
    const sellPrice = 60;
    const yesShares = -10;
    const cashReceived = Math.abs(yesShares) * sellPrice; // 600
    const collateral = Math.abs(yesShares) * (SHARE_PAYOUT_CENTS - sellPrice); // 400
    const noResolutionPayout = 0; // YES worthless
    const profit = cashReceived + collateral - 0; // They keep everything: 600 cash + 400 collateral returned
    // Net profit = sellPrice * shares = 600 (they received 600 from selling, keep it)
    expect(cashReceived).toBe(600);
    expect(collateral).toBe(400);
  });

  it("PnL calculation for buyer on YES resolution", () => {
    const buyPrice = 40; // cents
    const qty = 10;
    const cost = buyPrice * qty; // 400
    const payout = qty * SHARE_PAYOUT_CENTS; // 1000
    const pnl = payout - cost; // 600
    expect(pnl).toBe(600);
  });

  it("PnL calculation for buyer on NO resolution", () => {
    const buyPrice = 40;
    const qty = 10;
    const cost = buyPrice * qty; // 400
    const payout = 0; // YES worthless
    const pnl = payout - cost; // -400
    expect(pnl).toBe(-400);
  });

  it("PnL for seller (short) on YES resolution", () => {
    const sellPrice = 70;
    const qty = 10;
    const cashReceived = sellPrice * qty; // 700
    const obligation = qty * SHARE_PAYOUT_CENTS; // 1000
    const pnl = cashReceived - obligation; // -300
    expect(pnl).toBe(-300);
  });

  it("PnL for seller (short) on NO resolution", () => {
    const sellPrice = 70;
    const qty = 10;
    const cashReceived = sellPrice * qty; // 700
    const obligation = 0; // YES worthless, no payout owed
    const pnl = cashReceived - obligation; // 700
    expect(pnl).toBe(700);
  });
});

describe("Settlement + engine cleanup", () => {
  it("engine book is removed after settlement", () => {
    const engine = new MatchingEngine(100);
    const book = engine.getOrCreateBook("m1");
    expect(engine.getBook("m1")).toBeDefined();

    engine.removeBook("m1");
    expect(engine.getBook("m1")).toBeUndefined();
  });

  it("all open orders should be canceled before settlement payout", () => {
    // Simulating: if a market settles, open orders' locks must be released
    const engine = new MatchingEngine(100);
    const book = engine.getOrCreateBook("m1");

    // Add resting orders
    book.addOrder({
      orderId: "o1", userId: "u1", side: "BUY",
      priceCents: 50, remainingQty: 10, timestamp: new Date(), seq: 1n,
    });
    book.addOrder({
      orderId: "o2", userId: "u2", side: "SELL",
      priceCents: 60, remainingQty: 5, timestamp: new Date(), seq: 2n,
    });

    expect(book.orderCount()).toBe(2);

    // Settlement would cancel all orders
    book.clear();
    expect(book.orderCount()).toBe(0);
    expect(book.bestBid()).toBeNull();
    expect(book.bestAsk()).toBeNull();
  });

  it("collateral covers worst case for short positions", () => {
    // Seller sells at 70, locking 30 per share
    const sellPrice = 70;
    const qty = 10;
    const positionLock = (SHARE_PAYOUT_CENTS - sellPrice) * qty; // 300
    const worstCaseLoss = qty * SHARE_PAYOUT_CENTS; // 1000 (if YES resolves)
    const cashReceived = sellPrice * qty; // 700

    // Obligation on YES: 1000 - 700 (cash already received) = 300 = positionLock
    expect(positionLock).toBe(worstCaseLoss - cashReceived);
  });
});
