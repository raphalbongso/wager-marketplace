/** All money values are integer cents. Prices are 1–99 (representing $0.01–$0.99). */

export interface OrderRef {
  orderId: string;
  userId: string;
  side: "BUY" | "SELL";
  priceCents: number;
  remainingQty: number;
  timestamp: Date;
  seq: bigint;
}

export interface IncomingOrder {
  orderId: string;
  userId: string;
  marketId: string;
  side: "BUY" | "SELL";
  type: "LIMIT" | "MARKET";
  priceCents: number | null; // null for MARKET orders
  qty: number;
}

export interface Fill {
  makerOrderId: string;
  takerOrderId: string;
  makerUserId: string;
  takerUserId: string;
  priceCents: number; // execution price = maker's resting price
  qty: number;
  takerFeeCents: number;
}

export interface MatchResult {
  fills: Fill[];
  restingOrder: OrderRef | null;
  status: "OPEN" | "PARTIAL" | "FILLED" | "CANCELED" | "REJECTED";
  remainingQty: number;
  /** Maker orders fully consumed during matching (remove from book after persist). */
  exhaustedMakerOrderIds: string[];
  /** Maker orders partially filled: orderId -> new remainingQty. */
  updatedMakers: Map<string, number>;
}

export interface CancelResult {
  success: boolean;
  order: OrderRef | null;
}

export interface BookLevel {
  priceCents: number;
  totalQty: number;
  orderCount: number;
}

export const SHARE_PAYOUT_CENTS = 100; // 1 YES share pays $1.00 on YES resolution
export const MIN_PRICE_CENTS = 1;
export const MAX_PRICE_CENTS = 99;
