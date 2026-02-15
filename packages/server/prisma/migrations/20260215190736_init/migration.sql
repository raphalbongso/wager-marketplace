-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "MarketStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "Resolution" AS ENUM ('YES', 'NO');

-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('LIMIT', 'MARKET');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('OPEN', 'PARTIAL', 'FILLED', 'CANCELED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AnchorBetStatus" AS ENUM ('OPEN', 'PROMOTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "SideBetDirection" AS ENUM ('YES', 'NO');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "balance_cents" INTEGER NOT NULL DEFAULT 0,
    "locked_cents" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "markets" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "MarketStatus" NOT NULL DEFAULT 'OPEN',
    "resolves_to" "Resolution",
    "tick_size_cents" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "markets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "market_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "side" "OrderSide" NOT NULL,
    "type" "OrderType" NOT NULL,
    "price_cents" INTEGER,
    "qty" INTEGER NOT NULL,
    "remaining_qty" INTEGER NOT NULL,
    "locked_cents" INTEGER NOT NULL DEFAULT 0,
    "status" "OrderStatus" NOT NULL DEFAULT 'OPEN',
    "seq" BIGINT NOT NULL DEFAULT 0,
    "client_order_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" TEXT NOT NULL,
    "market_id" TEXT NOT NULL,
    "taker_order_id" TEXT NOT NULL,
    "maker_order_id" TEXT NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,
    "taker_user_id" TEXT NOT NULL,
    "maker_user_id" TEXT NOT NULL,
    "taker_fee_cents" INTEGER NOT NULL DEFAULT 0,
    "seq" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" TEXT NOT NULL,
    "market_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "yes_shares" INTEGER NOT NULL DEFAULT 0,
    "avg_cost_cents" INTEGER NOT NULL DEFAULT 0,
    "realized_pnl_cents" INTEGER NOT NULL DEFAULT 0,
    "locked_cents" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_log" (
    "id" TEXT NOT NULL,
    "market_id" TEXT,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "seq" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_fee_wallet" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "balance_cents" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "platform_fee_wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "anchor_bets" (
    "id" TEXT NOT NULL,
    "creator_user_id" TEXT NOT NULL,
    "opponent_user_id" TEXT,
    "title" TEXT NOT NULL,
    "rules_text" TEXT NOT NULL,
    "status" "AnchorBetStatus" NOT NULL DEFAULT 'OPEN',
    "arbitrator_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "anchor_bets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "side_bets" (
    "id" TEXT NOT NULL,
    "anchor_bet_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "direction" "SideBetDirection" NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "side_bets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotions" (
    "id" TEXT NOT NULL,
    "anchor_bet_id" TEXT NOT NULL,
    "market_id" TEXT NOT NULL,
    "threshold_cents" INTEGER NOT NULL,
    "promoted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_user_id_key" ON "wallets"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "markets_slug_key" ON "markets"("slug");

-- CreateIndex
CREATE INDEX "orders_market_id_status_idx" ON "orders"("market_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "orders_user_id_client_order_id_key" ON "orders"("user_id", "client_order_id");

-- CreateIndex
CREATE INDEX "trades_market_id_created_at_idx" ON "trades"("market_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "positions_market_id_user_id_key" ON "positions"("market_id", "user_id");

-- CreateIndex
CREATE INDEX "event_log_market_id_seq_idx" ON "event_log"("market_id", "seq");

-- CreateIndex
CREATE INDEX "event_log_type_idx" ON "event_log"("type");

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_taker_order_id_fkey" FOREIGN KEY ("taker_order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_maker_order_id_fkey" FOREIGN KEY ("maker_order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_log" ADD CONSTRAINT "event_log_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "markets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anchor_bets" ADD CONSTRAINT "anchor_bets_creator_user_id_fkey" FOREIGN KEY ("creator_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anchor_bets" ADD CONSTRAINT "anchor_bets_opponent_user_id_fkey" FOREIGN KEY ("opponent_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "side_bets" ADD CONSTRAINT "side_bets_anchor_bet_id_fkey" FOREIGN KEY ("anchor_bet_id") REFERENCES "anchor_bets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "side_bets" ADD CONSTRAINT "side_bets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_anchor_bet_id_fkey" FOREIGN KEY ("anchor_bet_id") REFERENCES "anchor_bets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
