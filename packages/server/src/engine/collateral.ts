import { SHARE_PAYOUT_CENTS, MAX_PRICE_CENTS } from "./types.js";

/**
 * Collateral calculations for fully-collateralized prediction-market orders.
 *
 * YES contract pays SHARE_PAYOUT_CENTS (100) if YES resolves, else 0.
 *
 * BUY locks  price * qty  (cash you commit to buy shares).
 * SELL locks (100 - price) * qty  (worst-case obligation if YES resolves).
 *
 * For MARKET orders the worst-case price is used (99¢).
 */

export function lockRequired(
  side: "BUY" | "SELL",
  type: "LIMIT" | "MARKET",
  priceCents: number | null,
  qty: number,
  takerFeeBps: number,
): number {
  const price = type === "MARKET" ? MAX_PRICE_CENTS : priceCents!;
  const base = side === "BUY" ? price * qty : (SHARE_PAYOUT_CENTS - price) * qty;

  // For taker orders (MARKET, or aggressive LIMIT that will cross),
  // include worst-case fee in the lock so the user can always pay.
  // Fee estimate = ceil(MAX_PRICE * qty * bps / 10_000).
  // For LIMIT resting orders the user may or may not be taker, so
  // include the fee estimate defensively.
  const feeEstimate = Math.ceil(price * qty * takerFeeBps / 10_000);

  return base + feeEstimate;
}

/** Amount to lock per-share for a given order. Does NOT include fee. */
export function lockPerShare(
  side: "BUY" | "SELL",
  type: "LIMIT" | "MARKET",
  priceCents: number | null,
): number {
  const price = type === "MARKET" ? MAX_PRICE_CENTS : priceCents!;
  return side === "BUY" ? price : SHARE_PAYOUT_CENTS - price;
}

/** Taker fee for a single fill. */
export function computeTakerFee(
  execPriceCents: number,
  fillQty: number,
  takerFeeBps: number,
): number {
  return Math.floor(execPriceCents * fillQty * takerFeeBps / 10_000);
}

/**
 * After a sell fills, the seller needs position collateral for any
 * resulting short exposure. Returns per-share position lock.
 */
export function positionLockPerShare(execPriceCents: number): number {
  return SHARE_PAYOUT_CENTS - execPriceCents;
}
