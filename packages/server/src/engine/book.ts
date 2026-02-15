import type { OrderRef, BookLevel } from "./types.js";

/**
 * In-memory limit order book for a single market (YES contract).
 *
 * - bids: sorted descending by price (highest first)
 * - asks: sorted ascending by price (lowest first)
 * - Within each price level: FIFO queue ordered by seq.
 */
export class OrderBook {
  private bids = new Map<number, OrderRef[]>();
  private asks = new Map<number, OrderRef[]>();
  private bidPrices: number[] = []; // sorted descending
  private askPrices: number[] = []; // sorted ascending
  private orderIndex = new Map<string, { side: "BUY" | "SELL"; priceCents: number }>();

  // ── Queries ──────────────────────────────────────────────────

  bestBid(): number | null {
    return this.bidPrices.length > 0 ? this.bidPrices[0]! : null;
  }

  bestAsk(): number | null {
    return this.askPrices.length > 0 ? this.askPrices[0]! : null;
  }

  getTopBids(n: number): BookLevel[] {
    return this.bidPrices.slice(0, n).map((p) => this.levelSummary(this.bids, p));
  }

  getTopAsks(n: number): BookLevel[] {
    return this.askPrices.slice(0, n).map((p) => this.levelSummary(this.asks, p));
  }

  /** Returns the FIFO queue at the best ask. DO NOT mutate directly. */
  peekBestAskLevel(): OrderRef[] | null {
    if (this.askPrices.length === 0) return null;
    return this.asks.get(this.askPrices[0]!) ?? null;
  }

  /** Returns the FIFO queue at the best bid. DO NOT mutate directly. */
  peekBestBidLevel(): OrderRef[] | null {
    if (this.bidPrices.length === 0) return null;
    return this.bids.get(this.bidPrices[0]!) ?? null;
  }

  hasOrder(orderId: string): boolean {
    return this.orderIndex.has(orderId);
  }

  orderCount(): number {
    return this.orderIndex.size;
  }

  // ── Mutations ────────────────────────────────────────────────

  addOrder(order: OrderRef): void {
    if (order.side === "BUY") {
      this.addToSide(this.bids, this.bidPrices, order, "desc");
    } else {
      this.addToSide(this.asks, this.askPrices, order, "asc");
    }
    this.orderIndex.set(order.orderId, { side: order.side, priceCents: order.priceCents });
  }

  removeOrder(orderId: string): OrderRef | null {
    const info = this.orderIndex.get(orderId);
    if (!info) return null;

    const levels = info.side === "BUY" ? this.bids : this.asks;
    const prices = info.side === "BUY" ? this.bidPrices : this.askPrices;
    const level = levels.get(info.priceCents);
    if (!level) return null;

    const idx = level.findIndex((o) => o.orderId === orderId);
    if (idx === -1) return null;

    const [removed] = level.splice(idx, 1);
    this.orderIndex.delete(orderId);

    if (level.length === 0) {
      levels.delete(info.priceCents);
      const priceIdx = prices.indexOf(info.priceCents);
      if (priceIdx >= 0) prices.splice(priceIdx, 1);
    }

    return removed!;
  }

  /** Update remaining qty of an existing resting order. */
  updateRemaining(orderId: string, newRemaining: number): boolean {
    const info = this.orderIndex.get(orderId);
    if (!info) return false;
    const levels = info.side === "BUY" ? this.bids : this.asks;
    const level = levels.get(info.priceCents);
    if (!level) return false;
    const order = level.find((o) => o.orderId === orderId);
    if (!order) return false;
    order.remainingQty = newRemaining;
    return true;
  }

  clear(): void {
    this.bids.clear();
    this.asks.clear();
    this.bidPrices = [];
    this.askPrices = [];
    this.orderIndex.clear();
  }

  // ── Internal ─────────────────────────────────────────────────

  private addToSide(
    levels: Map<number, OrderRef[]>,
    prices: number[],
    order: OrderRef,
    dir: "asc" | "desc",
  ): void {
    if (!levels.has(order.priceCents)) {
      levels.set(order.priceCents, []);
      this.insertSorted(prices, order.priceCents, dir);
    }
    levels.get(order.priceCents)!.push(order);
  }

  /** Binary search insert into a sorted array. */
  private insertSorted(arr: number[], val: number, dir: "asc" | "desc"): void {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const cmp = dir === "asc" ? arr[mid]! < val : arr[mid]! > val;
      if (cmp) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    arr.splice(lo, 0, val);
  }

  private levelSummary(levels: Map<number, OrderRef[]>, price: number): BookLevel {
    const queue = levels.get(price) ?? [];
    return {
      priceCents: price,
      totalQty: queue.reduce((s, o) => s + o.remainingQty, 0),
      orderCount: queue.length,
    };
  }
}
