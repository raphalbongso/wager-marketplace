package model

import "time"

// ── Enums ────────────────────────────────────────────

type Role string

const (
	RoleUser  Role = "USER"
	RoleAdmin Role = "ADMIN"
)

type MarketStatus string

const (
	MarketOpen     MarketStatus = "OPEN"
	MarketResolved MarketStatus = "RESOLVED"
)

type OrderSide string

const (
	SideBuy  OrderSide = "BUY"
	SideSell OrderSide = "SELL"
)

type OrderType string

const (
	TypeLimit  OrderType = "LIMIT"
	TypeMarket OrderType = "MARKET"
)

type OrderStatus string

const (
	StatusOpen     OrderStatus = "OPEN"
	StatusPartial  OrderStatus = "PARTIAL"
	StatusFilled   OrderStatus = "FILLED"
	StatusCanceled OrderStatus = "CANCELED"
	StatusRejected OrderStatus = "REJECTED"
)

// ── Domain Objects ───────────────────────────────────

type User struct {
	ID           string    `json:"id"`
	Email        string    `json:"email"`
	PasswordHash string    `json:"-"`
	Role         Role      `json:"role"`
	CreatedAt    time.Time `json:"created_at"`
}

type Wallet struct {
	UserID       string `json:"user_id"`
	BalanceCents int64  `json:"balance_cents"`
	LockedCents  int64  `json:"locked_cents"`
}

func (w Wallet) Available() int64 { return w.BalanceCents - w.LockedCents }

type Market struct {
	ID            string       `json:"id"`
	Slug          string       `json:"slug"`
	Title         string       `json:"title"`
	Description   string       `json:"description"`
	Status        MarketStatus `json:"status"`
	ResolvesTo    *string      `json:"resolves_to"`
	TickSizeCents int          `json:"tick_size_cents"`
	CreatedAt     time.Time    `json:"created_at"`
	ResolvedAt    *time.Time   `json:"resolved_at,omitempty"`
}

type Order struct {
	ID            string      `json:"id"`
	MarketID      string      `json:"market_id"`
	UserID        string      `json:"user_id"`
	Side          OrderSide   `json:"side"`
	OrderType     OrderType   `json:"order_type"`
	PriceCents    *int        `json:"price_cents"`
	Qty           int         `json:"qty"`
	RemainingQty  int         `json:"remaining_qty"`
	LockedCents   int64       `json:"locked_cents"`
	Status        OrderStatus `json:"status"`
	Seq           int64       `json:"seq"`
	ClientOrderID *string     `json:"client_order_id,omitempty"`
	CreatedAt     time.Time   `json:"created_at"`
	UpdatedAt     time.Time   `json:"updated_at"`
}

type Trade struct {
	ID           string    `json:"id"`
	MarketID     string    `json:"market_id"`
	MakerOrderID string    `json:"maker_order_id"`
	TakerOrderID string    `json:"taker_order_id"`
	MakerUserID  string    `json:"maker_user_id"`
	TakerUserID  string    `json:"taker_user_id"`
	PriceCents   int       `json:"price_cents"`
	Qty          int       `json:"qty"`
	FeeCents     int64     `json:"fee_cents"`
	Seq          int64     `json:"seq"`
	CreatedAt    time.Time `json:"created_at"`
}

type Position struct {
	ID               string `json:"id"`
	MarketID         string `json:"market_id"`
	UserID           string `json:"user_id"`
	YesShares        int    `json:"yes_shares"`
	AvgCostCents     int64  `json:"avg_cost_cents"`
	RealizedPnlCents int64  `json:"realized_pnl_cents"`
}

type EventLog struct {
	ID          int64     `json:"id"`
	MarketID    *string   `json:"market_id,omitempty"`
	Seq         *int64    `json:"seq,omitempty"`
	Type        string    `json:"type"`
	PayloadJSON any       `json:"payload"`
	CreatedAt   time.Time `json:"created_at"`
}

type AnchorBet struct {
	ID               string    `json:"id"`
	CreatorUserID    string    `json:"creator_user_id"`
	OpponentUserID   *string   `json:"opponent_user_id,omitempty"`
	Title            string    `json:"title"`
	RulesText        string    `json:"rules_text"`
	Status           string    `json:"status"`
	ArbitratorUserID *string   `json:"arbitrator_user_id,omitempty"`
	CreatedAt        time.Time `json:"created_at"`
}

type SideBet struct {
	ID          string    `json:"id"`
	AnchorBetID string    `json:"anchor_bet_id"`
	UserID      string    `json:"user_id"`
	Direction   string    `json:"direction"`
	AmountCents int64     `json:"amount_cents"`
	CreatedAt   time.Time `json:"created_at"`
}

type Promotion struct {
	ID             string    `json:"id"`
	AnchorBetID    string    `json:"anchor_bet_id"`
	MarketID       string    `json:"market_id"`
	ThresholdCents int64     `json:"threshold_cents"`
	PromotedAt     time.Time `json:"promoted_at"`
}

// ── API Types ────────────────────────────────────────

type PlaceOrderReq struct {
	Side          OrderSide `json:"side"`
	Type          OrderType `json:"type"`
	PriceCents    *int      `json:"price_cents"`
	Qty           int       `json:"qty"`
	ClientOrderID *string   `json:"client_order_id"`
}

type PlaceOrderResult struct {
	OrderID string      `json:"order_id"`
	Status  OrderStatus `json:"status"`
	Trades  []Trade     `json:"trades"`
	Reason  string      `json:"reason,omitempty"`
}

type BookLevel struct {
	Price int `json:"price"`
	Qty   int `json:"qty"`
}

type BookSnapshot struct {
	Bids []BookLevel `json:"bids"`
	Asks []BookLevel `json:"asks"`
}

// ── Collateral ───────────────────────────────────────

func CalcLock(side OrderSide, otype OrderType, priceCents *int, qty int, feeBps int) int64 {
	if otype == TypeMarket {
		base := int64(99) * int64(qty)
		fee := base * int64(feeBps) / 10000
		return base + fee
	}
	p := int64(*priceCents)
	q := int64(qty)
	if side == SideBuy {
		base := p * q
		fee := base * int64(feeBps) / 10000
		return base + fee
	}
	// SELL
	base := (100 - p) * q
	fee := int64(99) * q * int64(feeBps) / 10000
	return base + fee
}

func CalcTakerFee(priceCents int, qty int, feeBps int) int64 {
	return int64(priceCents) * int64(qty) * int64(feeBps) / 10000
}
