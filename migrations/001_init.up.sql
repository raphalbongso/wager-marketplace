CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'USER' CHECK (role IN ('USER','ADMIN')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Wallets
CREATE TABLE wallets (
    user_id UUID PRIMARY KEY REFERENCES users(id),
    balance_cents BIGINT NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
    locked_cents  BIGINT NOT NULL DEFAULT 0 CHECK (locked_cents >= 0),
    CONSTRAINT wallet_solvency CHECK (balance_cents >= locked_cents)
);

-- Markets
CREATE TABLE markets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
    resolves_to TEXT CHECK (resolves_to IN ('YES','NO')),
    tick_size_cents INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ
);

-- Orders
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    market_id UUID NOT NULL REFERENCES markets(id),
    user_id UUID NOT NULL REFERENCES users(id),
    side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
    order_type TEXT NOT NULL CHECK (order_type IN ('LIMIT','MARKET')),
    price_cents INT,
    qty INT NOT NULL CHECK (qty > 0),
    remaining_qty INT NOT NULL CHECK (remaining_qty >= 0),
    locked_cents BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PARTIAL','FILLED','CANCELED','REJECTED')),
    seq BIGINT NOT NULL,
    client_order_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, client_order_id)
);
CREATE INDEX idx_orders_market_status ON orders(market_id, status);

-- Trades
CREATE TABLE trades (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    market_id UUID NOT NULL REFERENCES markets(id),
    maker_order_id UUID NOT NULL REFERENCES orders(id),
    taker_order_id UUID NOT NULL REFERENCES orders(id),
    maker_user_id UUID NOT NULL,
    taker_user_id UUID NOT NULL,
    price_cents INT NOT NULL,
    qty INT NOT NULL,
    fee_cents BIGINT NOT NULL DEFAULT 0,
    seq BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_trades_market ON trades(market_id);

-- Positions
CREATE TABLE positions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    market_id UUID NOT NULL REFERENCES markets(id),
    user_id UUID NOT NULL REFERENCES users(id),
    yes_shares INT NOT NULL DEFAULT 0,
    avg_cost_cents BIGINT NOT NULL DEFAULT 0,
    realized_pnl_cents BIGINT NOT NULL DEFAULT 0,
    UNIQUE (market_id, user_id)
);

-- Event log (append-only audit trail)
CREATE TABLE event_log (
    id BIGSERIAL PRIMARY KEY,
    market_id UUID,
    seq BIGINT,
    type TEXT NOT NULL,
    payload_json JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_event_log_market ON event_log(market_id, seq);

-- Platform fee wallet (singleton)
CREATE TABLE platform_fee_wallet (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    balance_cents BIGINT NOT NULL DEFAULT 0
);
INSERT INTO platform_fee_wallet (id, balance_cents) VALUES (1, 0) ON CONFLICT DO NOTHING;

-- Anchor bets
CREATE TABLE anchor_bets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    creator_user_id UUID NOT NULL REFERENCES users(id),
    opponent_user_id UUID REFERENCES users(id),
    title TEXT NOT NULL,
    rules_text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PROMOTED','CLOSED')),
    arbitrator_user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Side bets
CREATE TABLE side_bets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    anchor_bet_id UUID NOT NULL REFERENCES anchor_bets(id),
    user_id UUID NOT NULL REFERENCES users(id),
    direction TEXT NOT NULL CHECK (direction IN ('YES','NO')),
    amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Promotions
CREATE TABLE promotions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    anchor_bet_id UUID NOT NULL REFERENCES anchor_bets(id),
    market_id UUID NOT NULL REFERENCES markets(id),
    threshold_cents BIGINT NOT NULL DEFAULT 0,
    promoted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
