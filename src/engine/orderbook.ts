/**
 * In-memory Limit Order Book (LOB) for a single market.
 *
 * Bids sorted descending by price, asks sorted ascending by price.
 * Within each price level: FIFO queue by sequence number.
 *
 * All prices are in integer cents (1-99).
 */

export interface OrderEntry {
  orderId: string;
  userId: string;
  side: 'BUY' | 'SELL';
  priceCents: number;
  remainingQty: number;
  lockedCents: number;
  seq: bigint;
}

export class OrderBook {
  /** Price -> FIFO queue. Bid prices sorted descending. */
  private bids = new Map<number, OrderEntry[]>();
  private bidPrices: number[] = []; // sorted descending

  /** Price -> FIFO queue. Ask prices sorted ascending. */
  private asks = new Map<number, OrderEntry[]>();
  private askPrices: number[] = []; // sorted ascending

  /** Fast lookup by orderId */
  private orderIndex = new Map<string, OrderEntry>();

  // ── Queries ──────────────────────────────────────

  bestBid(): number | null {
    return this.bidPrices.length > 0 ? this.bidPrices[0] : null;
  }

  bestAsk(): number | null {
    return this.askPrices.length > 0 ? this.askPrices[0] : null;
  }

  getOrder(orderId: string): OrderEntry | undefined {
    return this.orderIndex.get(orderId);
  }

  /**
   * Returns top `depth` price levels for bids and asks.
   * Each level: [priceCents, totalQty]
   */
  getBook(depth = 20): { bids: [number, number][]; asks: [number, number][] } {
    const bidLevels: [number, number][] = [];
    for (let i = 0; i < Math.min(depth, this.bidPrices.length); i++) {
      const p = this.bidPrices[i];
      const q = this.bids.get(p)!;
      bidLevels.push([p, q.reduce((sum, o) => sum + o.remainingQty, 0)]);
    }

    const askLevels: [number, number][] = [];
    for (let i = 0; i < Math.min(depth, this.askPrices.length); i++) {
      const p = this.askPrices[i];
      const q = this.asks.get(p)!;
      askLevels.push([p, q.reduce((sum, o) => sum + o.remainingQty, 0)]);
    }

    return { bids: bidLevels, asks: askLevels };
  }

  // ── Mutations ────────────────────────────────────

  /** Place a resting order into the book. */
  add(entry: OrderEntry): void {
    if (this.orderIndex.has(entry.orderId)) {
      throw new Error(`Duplicate order ID: ${entry.orderId}`);
    }
    this.orderIndex.set(entry.orderId, entry);

    if (entry.side === 'BUY') {
      this.addToSide(this.bids, this.bidPrices, entry, 'desc');
    } else {
      this.addToSide(this.asks, this.askPrices, entry, 'asc');
    }
  }

  /** Remove an order from the book. Returns the entry or null. */
  remove(orderId: string): OrderEntry | null {
    const entry = this.orderIndex.get(orderId);
    if (!entry) return null;
    this.orderIndex.delete(orderId);

    if (entry.side === 'BUY') {
      this.removeFromSide(this.bids, this.bidPrices, entry);
    } else {
      this.removeFromSide(this.asks, this.askPrices, entry);
    }
    return entry;
  }

  /**
   * Walk the opposite side of the book to find matches for an incoming order.
   * Returns matched entries with fill quantities. Does NOT mutate the book —
   * caller is responsible for applying fills via `applyFill` / `remove`.
   */
  findMatches(
    side: 'BUY' | 'SELL',
    priceCents: number | null, // null = MARKET order
    maxQty: number,
    excludeUserId: string, // self-trade prevention
  ): { entry: OrderEntry; fillQty: number; fillPrice: number }[] {
    const matches: { entry: OrderEntry; fillQty: number; fillPrice: number }[] = [];
    let remaining = maxQty;

    if (side === 'BUY') {
      // Match against asks (ascending price)
      for (const askPrice of [...this.askPrices]) {
        if (remaining <= 0) break;
        if (priceCents !== null && askPrice > priceCents) break; // too expensive

        const queue = this.asks.get(askPrice);
        if (!queue) continue;

        for (const entry of [...queue]) {
          if (remaining <= 0) break;
          if (entry.userId === excludeUserId) continue; // self-trade prevention

          const fillQty = Math.min(remaining, entry.remainingQty);
          matches.push({ entry, fillQty, fillPrice: askPrice });
          remaining -= fillQty;
        }
      }
    } else {
      // Match against bids (descending price)
      for (const bidPrice of [...this.bidPrices]) {
        if (remaining <= 0) break;
        if (priceCents !== null && bidPrice < priceCents) break; // too low

        const queue = this.bids.get(bidPrice);
        if (!queue) continue;

        for (const entry of [...queue]) {
          if (remaining <= 0) break;
          if (entry.userId === excludeUserId) continue; // self-trade prevention

          const fillQty = Math.min(remaining, entry.remainingQty);
          matches.push({ entry, fillQty, fillPrice: bidPrice });
          remaining -= fillQty;
        }
      }
    }

    return matches;
  }

  /**
   * Apply a partial or full fill to a resting order.
   * Returns the remaining quantity on the order after fill.
   * If fully filled, removes the order from the book.
   */
  applyFill(orderId: string, fillQty: number): number {
    const entry = this.orderIndex.get(orderId);
    if (!entry) throw new Error(`Order not found: ${orderId}`);
    if (fillQty > entry.remainingQty) throw new Error(`Fill qty ${fillQty} > remaining ${entry.remainingQty}`);

    entry.remainingQty -= fillQty;

    // Release proportional locked amount
    if (entry.remainingQty === 0) {
      // Fully filled — remove from book
      this.remove(orderId);
    }

    return entry.remainingQty;
  }

  /** Total number of resting orders */
  get size(): number {
    return this.orderIndex.size;
  }

  // ── Internals ────────────────────────────────────

  private addToSide(
    map: Map<number, OrderEntry[]>,
    prices: number[],
    entry: OrderEntry,
    sort: 'asc' | 'desc',
  ) {
    let queue = map.get(entry.priceCents);
    if (!queue) {
      queue = [];
      map.set(entry.priceCents, queue);
      // Insert price level in sorted order
      this.insertPrice(prices, entry.priceCents, sort);
    }
    queue.push(entry);
  }

  private removeFromSide(
    map: Map<number, OrderEntry[]>,
    prices: number[],
    entry: OrderEntry,
  ) {
    const queue = map.get(entry.priceCents);
    if (!queue) return;

    const idx = queue.findIndex((o) => o.orderId === entry.orderId);
    if (idx !== -1) queue.splice(idx, 1);

    // Remove empty price level
    if (queue.length === 0) {
      map.delete(entry.priceCents);
      const priceIdx = prices.indexOf(entry.priceCents);
      if (priceIdx !== -1) prices.splice(priceIdx, 1);
    }
  }

  private insertPrice(prices: number[], price: number, sort: 'asc' | 'desc') {
    // Binary search for insertion point
    let lo = 0;
    let hi = prices.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const cmp = sort === 'asc' ? prices[mid] - price : price - prices[mid];
      if (cmp < 0) lo = mid + 1;
      else hi = mid;
    }
    prices.splice(lo, 0, price);
  }
}
