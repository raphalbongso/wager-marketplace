# Wager Market Exchange

A production-grade binary outcome prediction market exchange with an in-memory limit order book, deterministic matching engine, fully-collateralized positions, event-sourced persistence, and REST + WebSocket APIs.

**This is NOT a sportsbook.** Users trade YES/NO contracts on event outcomes. A YES share pays $1.00 if the outcome is YES, $0.00 otherwise.

## Tech Stack

- **Runtime**: Node.js 20+ / TypeScript (strict)
- **Server**: Fastify 5
- **Database**: PostgreSQL 16 + Prisma ORM
- **WebSocket**: @fastify/websocket
- **Auth**: JWT (email + password, bcrypt)
- **Validation**: Zod
- **Testing**: Vitest (45 tests)
- **UI**: Static HTML/JS admin panel served from Fastify

## Quick Start

```bash
# 1. Start PostgreSQL
docker compose up -d postgres

# 2. Install dependencies
npm install

# 3. Set up environment
cp .env.example .env
# Edit .env if needed (defaults work for local dev)

# 4. Run migrations
npx prisma migrate dev

# 5. Seed demo data
npm run db:seed

# 6. Start server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### With Docker (full stack)

```bash
docker compose up --build
```

## Demo Accounts

| Email | Password | Role | Balance |
|-------|----------|------|---------|
| admin@wagermarket.com | admin123 | ADMIN | $10,000 |
| alice@example.com | user123 | USER | $5,000 |
| bob@example.com | user123 | USER | $5,000 |
| charlie@example.com | user123 | USER | $2,500 |

## Architecture

### Matching Engine

- **Order Book**: In-memory per market, price-time priority (FIFO within price level)
- **Deterministic**: Single-threaded per market via async lock, sequential order processing
- **Collateral**: Fully collateralized at order time; no negative balances possible
- **Self-trade prevention**: Orders skip matching against the same user
- **All money in integer cents**: No floating point for financial calculations

### Collateral Model

| Action | Lock Amount |
|--------|-------------|
| BUY LIMIT at P | P × qty + taker fee buffer |
| SELL LIMIT at P | (100-P) × qty + taker fee buffer |
| BUY MARKET | 99 × qty + fee buffer |
| SELL MARKET | 99 × qty + fee buffer |
| Short position | \|shares\| × 100 (max settlement exposure) |

On fill: order lock released proportionally, cash transferred, position lock adjusted.
On cancel: remaining order lock released.
On settlement: positions pay out, all locks released.

### Event Sourcing

Every state change emits an immutable `EventLog` row:
- `OrderAccepted`, `OrderFilled`, `OrderCanceled`, `OrderRejected`
- `TradeExecuted`
- `MarketCreated`, `MarketResolved`, `MarketPromoted`
- `Deposit`, `AnchorBetCreated`

### Fees

- Taker fee: 1% (100 bps, configurable via `TAKER_FEE_BPS`)
- Maker fee: 0%
- Fee = floor(executionPrice × qty × feeBps / 10000)
- Fees collected in platform fee wallet

## API Reference

### Auth
- `POST /auth/register` — Register new user
- `POST /auth/login` — Login, returns JWT

### Wallet
- `GET /me` — Current user profile + wallet
- `GET /wallet` — Wallet balance details
- `POST /wallet/deposit` — Admin deposits to user (testing)

### Markets
- `POST /markets` — Create market (admin)
- `GET /markets` — List all markets with best bid/ask
- `GET /markets/:id` — Market detail with book + recent trades
- `POST /markets/:id/resolve` — Resolve market YES/NO (admin)
- `GET /markets/:id/book` — Order book (top 20 levels)
- `GET /markets/:id/trades` — Recent trades

### Orders
- `POST /markets/:id/orders` — Place order
- `POST /markets/:id/orders/:orderId/cancel` — Cancel order
- `GET /markets/:id/orders` — My orders for market

### Anchor Bets
- `POST /anchor-bets` — Create anchor bet
- `POST /anchor-bets/:id/side-bets` — Add side bet
- `POST /anchor-bets/:id/promote` — Promote to market (admin)
- `GET /anchor-bets` — List anchor bets

### Admin
- `GET /admin/metrics` — Platform metrics
- `GET /admin/events` — Event log query
- `GET /admin/users` — User list with balances

### WebSocket
- `GET /ws?market_id=<id>&token=<jwt>` — Real-time market data
  - Emits: `book_snapshot`, `trade`, `order_update`

## Testing

```bash
npm test          # Run all tests
npm run test:watch # Watch mode
```

Tests cover:
- Price-time priority matching
- Partial fills across multiple price levels
- Market order remainder cancellation
- Cancel removes from book
- Collateral locking prevents over-spend
- Taker fee calculation (including rounding)
- Settlement payout calculations
- Event log append-only sequence behavior
- Self-trade prevention
- Edge cases (empty book, single share, max price range)

## Operational Notes

### Order Book Rebuild on Restart

On startup, the server automatically:
1. Loads all OPEN markets from the database
2. For each market, loads all OPEN/PARTIAL orders and rebuilds the in-memory book in sequence order
3. Restores sequence counters from the last EventLog entry

This means the server can be safely restarted without data loss.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | (required) | PostgreSQL connection string |
| `JWT_SECRET` | (required) | JWT signing secret (min 16 chars) |
| `PORT` | 3000 | Server port |
| `HOST` | 0.0.0.0 | Server bind address |
| `TAKER_FEE_BPS` | 100 | Taker fee in basis points (100 = 1%) |
| `TICK_SIZE_CENTS` | 1 | Default tick size for new markets |

### Known Limitations & Next Steps

**v1 Limitations:**
- Single-process: matching engine is in-memory, not distributed
- No market order price estimation (uses worst-case 99c lock)
- No withdrawals (admin deposit only)
- No KYC/AML
- No automated oracle for market resolution
- Anchor bet arbitration logic not implemented (fields stored only)
- Position lock uses worst-case (100c per short share) — capital inefficient

**Next Steps (v2):**
- Per-market sharding with message bus (Redis Streams / NATS)
- Risk engine for real-time margin monitoring
- Better market order estimation using book depth
- Oracle integration for automated resolution
- Proper withdrawal flow with KYC
- Order amendment (modify price/qty without cancel+replace)
- Historical OHLCV candle data
- Rate limiting per endpoint granularity
- WebSocket authentication refresh

## Project Structure

```
wager-marketplace/
├── prisma/
│   ├── schema.prisma        # Database schema (13 models)
│   ├── migrations/           # Auto-generated migrations
│   └── seed.ts              # Demo data seed script
├── public/
│   ├── index.html           # Admin/trading UI
│   └── app.js               # UI logic
├── src/
│   ├── index.ts             # Entry point (startup + book rebuild)
│   ├── server.ts            # Fastify setup + route registration
│   ├── config.ts            # Environment config with Zod validation
│   ├── auth/
│   │   ├── jwt.ts           # JWT sign/verify
│   │   └── middleware.ts    # Auth + RBAC + rate limit middleware
│   ├── engine/
│   │   ├── orderbook.ts     # In-memory LOB (price-time priority)
│   │   ├── matching.ts      # Matching engine + collateral logic
│   │   └── settlement.ts   # Market resolution + payout
│   ├── routes/
│   │   ├── auth.ts          # Register / login
│   │   ├── wallet.ts        # Balance + deposit
│   │   ├── markets.ts       # CRUD + resolve
│   │   ├── orders.ts        # Place / cancel / list
│   │   ├── anchor-bets.ts  # Anchor bets + side bets + promote
│   │   └── admin.ts         # Metrics + events + users
│   ├── ws/
│   │   └── handler.ts      # WebSocket broadcast
│   ├── lib/
│   │   ├── prisma.ts        # Prisma client
│   │   ├── logger.ts        # Structured JSON logger
│   │   └── rate-limiter.ts  # Token bucket rate limiter
│   └── __tests__/
│       └── engine.test.ts   # 45 unit tests
├── docker-compose.yml        # Postgres + app
├── Dockerfile               # Multi-stage build
└── package.json
```

## License

MIT
