import { z } from "zod";

// ── Auth ──────────────────────────────────────────────────────

export const RegisterSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
});

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

// ── Markets ───────────────────────────────────────────────────

export const CreateMarketSchema = z.object({
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
  title: z.string().min(1).max(500),
  description: z.string().max(5000).default(""),
  tickSizeCents: z.number().int().min(1).max(10).default(1),
});

export const ResolveMarketSchema = z.object({
  resolvesTo: z.enum(["YES", "NO"]),
});

// ── Orders ────────────────────────────────────────────────────

export const PlaceOrderSchema = z
  .object({
    side: z.enum(["BUY", "SELL"]),
    type: z.enum(["LIMIT", "MARKET"]),
    priceCents: z.number().int().min(1).max(99).optional(),
    qty: z.number().int().min(1).max(100_000),
    clientOrderId: z.string().max(64).optional(),
  })
  .refine(
    (d) => d.type === "MARKET" || (d.priceCents !== undefined && d.priceCents !== null),
    { message: "priceCents is required for LIMIT orders", path: ["priceCents"] },
  );

// ── Wallet ────────────────────────────────────────────────────

export const DepositSchema = z.object({
  userId: z.string().uuid(),
  amountCents: z.number().int().min(1).max(100_000_00), // max $100k deposit
});

// ── Anchor Bets ───────────────────────────────────────────────

export const CreateAnchorBetSchema = z.object({
  opponentUserId: z.string().uuid().optional(),
  title: z.string().min(1).max(500),
  rulesText: z.string().min(1).max(5000),
  arbitratorUserId: z.string().uuid().optional(),
});

export const CreateSideBetSchema = z.object({
  direction: z.enum(["YES", "NO"]),
  amountCents: z.number().int().min(1),
});

export const PromoteAnchorBetSchema = z.object({
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
  thresholdCents: z.number().int().min(0),
});
