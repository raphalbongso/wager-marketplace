# Wager Market Exchange

A production-grade prediction market exchange MVP with an in-memory limit order book, deterministic matching engine, fully-collateralized positions, event-sourced persistence, and REST + WebSocket APIs.

**This is NOT a sportsbook.** Users trade binary YES/NO contracts on event outcomes.

## Tech Stack

- **Runtime:** Node.js 20+ / TypeScript (strict)
- **Framework:** Fastify 5
- **Database:** PostgreSQL 16 (Prisma ORM)
- **WebSockets:** @fastify/websocket
- **Validation:** Zod
- **Auth:** JWT + bcrypt
- **Testing:** Vitest
- **Monorepo:** pnpm workspaces

## Quick Start

### With Docker Compose

```bash
# Start Postgres + app
docker compose up --build

# App runs on http://localhost:4000
```

### Local Development

```bash
# Prerequisites: Node.js 20+, pnpm, PostgreSQL

# Install dependencies
pnpm install

# Set up environment
cp .env.example packages/server/.env

# Start Postgres (via Docker or local)
docker compose up postgres -d

# Generate Prisma client + run migrations
pnpm db:generate
pnpm --filter @wager/server db:migrate:dev --name init

# Seed demo data
pnpm db:seed

# Start dev server
pnpm dev
```

Open http://localhost:4000 for the web UI.

### Demo Credentials

| Role  | Email                  | Password     |
|-------|------------------------|--------------|
| Admin | admin@wager.exchange   | admin123!    |
| User  | alice@example.com      | password123  |
| User  | bob@example.com        | password123  |

## Running Tests

```bash
pnpm test
```

## Architecture

### Matching Engine

- **Single-threaded per market** — deterministic, sequential order processing.
- **Price-time priority** (FIFO within price level).
- **Execution price = maker (resting) order price.**
- In-memory order book with sorted price levels + FIFO queues.
- MARKET order remainder is canceled (does not rest on book).
- Engine is "pure": returns mutations without modifying book state until DB transaction commits.

### Collateral Model

All money in **integer cents** (no floating point).

| Order | Lock Amount |
|-------|-------------|
| BUY LIMIT at P | `P × qty + fee_estimate` |
| SELL LIMIT at P | `(100 − P) × qty + fee_estimate` |
| BUY MARKET | `99 × qty + fee_estimate` |
| SELL MARKET | `99 × qty + fee_estimate` (worst case) |

- **Fully collateralized:** balances can never go negative.
- Sell positions maintain collateral locked until settlement.
- On fill, excess lock from price improvement is refunded.

### Settlement

1. Cancel all open orders → release locks.
2. For each position:
   - **YES resolution:** credit `yes_shares × 100¢` (negative for shorts).
   - **NO resolution:** YES shares worth 0; short position collateral returned.
3. Market marked `RESOLVED`.

### Event Sourcing

Every state change emits an immutable `EventLog` row:
- `OrderAccepted`, `TradeExecuted`, `OrderCanceled`, `OrderFilled`
- `MarketCreated`, `MarketResolved`, `MarketPromoted`
- `PositionSettled`, `WalletDeposit`

### Order Book Rebuild on Startup

For each OPEN market, load all `OPEN`/`PARTIAL` orders from DB sorted by `seq` and reconstruct the in-memory book.

## API Reference

### Auth
- `POST /auth/register` — `{ email, password }`
- `POST /auth/login` — `{ email, password }` → `{ token, user }`

### Wallet
- `GET /me` — Current user info
- `GET /wallet` — Balance, locked, available

### Markets
- `POST /markets` — (admin) Create market `{ slug, title, description }`
- `GET /markets` — List all markets
- `GET /markets/:id` — Market detail + book snapshot
- `GET /markets/:id/book` — Order book (top levels)
- `GET /markets/:id/trades` — Recent trades
- `GET /markets/:id/orders` — My orders
- `GET /markets/:id/position` — My position
- `POST /markets/:id/resolve` — (admin) `{ resolvesTo: "YES"|"NO" }`

### Orders
- `POST /markets/:id/orders` — `{ side, type, priceCents?, qty }`
- `POST /markets/:id/orders/:orderId/cancel`

### Anchor Bets
- `POST /anchor-bets` — Create anchor bet
- `GET /anchor-bets` — List with side bets
- `POST /anchor-bets/:id/side-bets` — Add side bet
- `POST /anchor-bets/:id/promote` — (admin) Promote to market

### Admin
- `POST /wallet/deposit` — (admin) `{ userId, amountCents }`
- `GET /admin/metrics` — Platform metrics
- `GET /admin/users` — All users + balances
- `GET /admin/events` — Event log

### WebSocket
- `GET /ws?market_id=...&token=...`
- Server emits: `book_snapshot`, `trade`, `order_update`, `market_resolved`

## Operational Notes

### How to rebuild order book on restart

Automatic. On server start, all OPEN markets' books are rebuilt from persisted `OPEN`/`PARTIAL` orders sorted by sequence number. Wallet balances and locked amounts are read from DB (source of truth).

### Known Limitations (v1)

- **Single server instance only** — matching engine is in-process; no sharding.
- **Market order estimation** — locks worst-case (99¢); refunds after fill but capital-inefficient.
- **Short position collateral** — over-collateralized (locks based on order price, not best available).
- **No auto-promotion** — anchor bet → market promotion is manual (admin endpoint).
- **No arbitrator resolution** — fields stored but arbitration logic not implemented.
- **Self-trade prevention** — not implemented; wash trades possible.

### Next Steps (v2+)

- Per-market sharding with message bus (Redis/NATS).
- Risk engine for portfolio margining.
- Better market order fill estimation (walk the book).
- Oracle integration for automated resolution.
- Order amendment (modify price/qty without cancel+replace).
- Self-trade prevention (STP) modes.
- WebSocket authentication improvements.
- Rate limiting per-endpoint.
- Prometheus metrics export.
