import { OrderBook } from "./book.js";
import { computeTakerFee } from "./collateral.js";
import type { IncomingOrder, MatchResult, Fill, OrderRef, CancelResult, BookLevel } from "./types.js";

/**
 * Deterministic, single-threaded matching engine.
 *
 * For each market it maintains an in-memory LOB.
 * Processing is sequential: one order at a time per market.
 *
 * Matching rules:
 * - BUY crosses against lowest ask <= buy price (or any for MARKET).
 * - SELL crosses against highest bid >= sell price (or any for MARKET).
 * - Price-time priority (FIFO within each price level).
 * - Execution price = resting (maker) order price.
 * - MARKET order remainder is canceled (does not rest).
 *
 * The engine is "pure" for matching: it returns a MatchResult describing
 * mutations. The caller applies them to both in-memory book and database.
 */
export class MatchingEngine {
  private books = new Map<string, OrderBook>();
  private seqCounters = new Map<string, bigint>();
  private takerFeeBps: number;

  constructor(takerFeeBps = 100) {
    this.takerFeeBps = takerFeeBps;
  }

  // ── Book access ──────────────────────────────────────────────

  getOrCreateBook(marketId: string): OrderBook {
    let book = this.books.get(marketId);
    if (!book) {
      book = new OrderBook();
      this.books.set(marketId, book);
      this.seqCounters.set(marketId, 0n);
    }
    return book;
  }

  getBook(marketId: string): OrderBook | undefined {
    return this.books.get(marketId);
  }

  removeBook(marketId: string): void {
    this.books.delete(marketId);
    this.seqCounters.delete(marketId);
  }

  nextSeq(marketId: string): bigint {
    const cur = this.seqCounters.get(marketId) ?? 0n;
    const next = cur + 1n;
    this.seqCounters.set(marketId, next);
    return next;
  }

  setSeqCounter(marketId: string, seq: bigint): void {
    this.seqCounters.set(marketId, seq);
  }

  getBookSnapshot(marketId: string, depth = 20): { bids: BookLevel[]; asks: BookLevel[] } {
    const book = this.books.get(marketId);
    if (!book) return { bids: [], asks: [] };
    return { bids: book.getTopBids(depth), asks: book.getTopAsks(depth) };
  }

  // ── Order processing ────────────────────────────────────────

  /**
   * Match an incoming order against the book.
   * Does NOT mutate the in-memory book — call applyResult() after
   * the DB transaction succeeds.
   */
  processOrder(order: IncomingOrder): MatchResult {
    const book = this.getOrCreateBook(order.marketId);
    const fills: Fill[] = [];
    let remaining = order.qty;

    // Track virtual state during matching so we don't re-match exhausted makers.
    const exhaustedMakerOrderIds: string[] = [];
    const updatedMakers = new Map<string, number>();

    const virtualRemaining = (maker: OrderRef): number => {
      if (exhaustedMakerOrderIds.includes(maker.orderId)) return 0;
      return updatedMakers.get(maker.orderId) ?? maker.remainingQty;
    };

    if (order.side === "BUY") {
      // Walk ask levels (lowest first)
      const askLevels = book.getTopAsks(999);
      for (const level of askLevels) {
        if (remaining === 0) break;
        if (order.type === "LIMIT" && level.priceCents > order.priceCents!) break;

        const queue = this.getAskQueue(book, level.priceCents);
        if (!queue) continue;

        for (const maker of queue) {
          if (remaining === 0) break;
          const avail = virtualRemaining(maker);
          if (avail === 0) continue;

          const fillQty = Math.min(remaining, avail);
          const execPrice = maker.priceCents;
          const fee = computeTakerFee(execPrice, fillQty, this.takerFeeBps);

          fills.push({
            makerOrderId: maker.orderId,
            takerOrderId: order.orderId,
            makerUserId: maker.userId,
            takerUserId: order.userId,
            priceCents: execPrice,
            qty: fillQty,
            takerFeeCents: fee,
          });

          remaining -= fillQty;
          const newAvail = avail - fillQty;
          if (newAvail === 0) {
            exhaustedMakerOrderIds.push(maker.orderId);
          } else {
            updatedMakers.set(maker.orderId, newAvail);
          }
        }
      }
    } else {
      // SELL: walk bid levels (highest first)
      const bidLevels = book.getTopBids(999);
      for (const level of bidLevels) {
        if (remaining === 0) break;
        if (order.type === "LIMIT" && level.priceCents < order.priceCents!) break;

        const queue = this.getBidQueue(book, level.priceCents);
        if (!queue) continue;

        for (const maker of queue) {
          if (remaining === 0) break;
          const avail = virtualRemaining(maker);
          if (avail === 0) continue;

          const fillQty = Math.min(remaining, avail);
          const execPrice = maker.priceCents;
          const fee = computeTakerFee(execPrice, fillQty, this.takerFeeBps);

          fills.push({
            makerOrderId: maker.orderId,
            takerOrderId: order.orderId,
            makerUserId: maker.userId,
            takerUserId: order.userId,
            priceCents: execPrice,
            qty: fillQty,
            takerFeeCents: fee,
          });

          remaining -= fillQty;
          const newAvail = avail - fillQty;
          if (newAvail === 0) {
            exhaustedMakerOrderIds.push(maker.orderId);
          } else {
            updatedMakers.set(maker.orderId, newAvail);
          }
        }
      }
    }

    // Determine order status
    let status: MatchResult["status"];
    let restingOrder: OrderRef | null = null;

    if (remaining === 0) {
      status = "FILLED";
    } else if (order.type === "MARKET") {
      status = fills.length > 0 ? "CANCELED" : "REJECTED";
    } else {
      // LIMIT: rest remainder on book
      const seq = this.nextSeq(order.marketId);
      restingOrder = {
        orderId: order.orderId,
        userId: order.userId,
        side: order.side,
        priceCents: order.priceCents!,
        remainingQty: remaining,
        timestamp: new Date(),
        seq,
      };
      status = fills.length > 0 ? "PARTIAL" : "OPEN";
    }

    return {
      fills,
      restingOrder,
      status,
      remainingQty: remaining,
      exhaustedMakerOrderIds,
      updatedMakers,
    };
  }

  /**
   * Apply match result to the in-memory book.
   * Call AFTER the DB transaction commits successfully.
   */
  applyResult(marketId: string, result: MatchResult): void {
    const book = this.getOrCreateBook(marketId);

    for (const orderId of result.exhaustedMakerOrderIds) {
      book.removeOrder(orderId);
    }

    for (const [orderId, newRemaining] of result.updatedMakers) {
      book.updateRemaining(orderId, newRemaining);
    }

    if (result.restingOrder) {
      book.addOrder(result.restingOrder);
    }
  }

  /** Cancel a resting order. Returns the removed order or null. */
  cancelOrder(marketId: string, orderId: string): CancelResult {
    const book = this.books.get(marketId);
    if (!book) return { success: false, order: null };
    const order = book.removeOrder(orderId);
    return { success: order !== null, order };
  }

  // ── Rebuild ──────────────────────────────────────────────────

  /**
   * Rebuild book from persisted open/partial orders.
   * Orders must be provided sorted by seq ascending.
   */
  rebuildBook(marketId: string, orders: OrderRef[]): void {
    const book = this.getOrCreateBook(marketId);
    book.clear();

    let maxSeq = 0n;
    for (const o of orders) {
      book.addOrder(o);
      if (o.seq > maxSeq) maxSeq = o.seq;
    }

    this.seqCounters.set(marketId, maxSeq);
  }

  // ── Private helpers ──────────────────────────────────────────

  /** Get ask queue at a specific price level (internal reference). */
  private getAskQueue(book: OrderBook, price: number): OrderRef[] | null {
    // Walk levels to find the queue. We use the public API indirectly.
    // Since OrderBook only exposes peek for *best*, we access via getTopAsks
    // and match price. For large books this is O(n); acceptable for v1.
    // In practice we already have the level info from getTopAsks above.
    //
    // Better approach: expose an iterator on OrderBook.
    // For now, use a simple internal accessor.
    return (book as any).asks.get(price) ?? null;
  }

  private getBidQueue(book: OrderBook, price: number): OrderRef[] | null {
    return (book as any).bids.get(price) ?? null;
  }
}
