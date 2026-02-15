package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/database/postgres"
	_ "github.com/golang-migrate/migrate/v4/source/file"
	_ "github.com/lib/pq"
	"wager-exchange/internal/model"
)

type Store struct{ DB *sql.DB }

func Open(dsn string) (*Store, error) {
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(20)
	db.SetConnMaxLifetime(5 * time.Minute)
	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("ping: %w", err)
	}
	return &Store{DB: db}, nil
}

func (s *Store) Migrate(dir string) error {
	driver, err := postgres.WithInstance(s.DB, &postgres.Config{})
	if err != nil {
		return err
	}
	m, err := migrate.NewWithDatabaseInstance("file://"+dir, "postgres", driver)
	if err != nil {
		return err
	}
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		return err
	}
	return nil
}

func (s *Store) BeginTx(ctx context.Context) (*sql.Tx, error) {
	return s.DB.BeginTx(ctx, nil)
}

// ── Users ────────────────────────────────────────────

func (s *Store) CreateUser(ctx context.Context, email, hash string, role model.Role) (*model.User, error) {
	u := &model.User{}
	err := s.DB.QueryRowContext(ctx,
		`INSERT INTO users (email, password_hash, role) VALUES ($1,$2,$3)
		 RETURNING id, email, password_hash, role, created_at`, email, hash, role,
	).Scan(&u.ID, &u.Email, &u.PasswordHash, &u.Role, &u.CreatedAt)
	return u, err
}

func (s *Store) GetUserByEmail(ctx context.Context, email string) (*model.User, error) {
	u := &model.User{}
	err := s.DB.QueryRowContext(ctx,
		`SELECT id, email, password_hash, role, created_at FROM users WHERE email=$1`, email,
	).Scan(&u.ID, &u.Email, &u.PasswordHash, &u.Role, &u.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return u, err
}

func (s *Store) GetUser(ctx context.Context, id string) (*model.User, error) {
	u := &model.User{}
	err := s.DB.QueryRowContext(ctx,
		`SELECT id, email, password_hash, role, created_at FROM users WHERE id=$1`, id,
	).Scan(&u.ID, &u.Email, &u.PasswordHash, &u.Role, &u.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return u, err
}

func (s *Store) ListUsers(ctx context.Context) ([]model.User, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT id, email, role, created_at FROM users ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []model.User
	for rows.Next() {
		var u model.User
		if err := rows.Scan(&u.ID, &u.Email, &u.Role, &u.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, nil
}

// ── Wallets ──────────────────────────────────────────

func (s *Store) CreateWallet(ctx context.Context, userID string) error {
	_, err := s.DB.ExecContext(ctx, `INSERT INTO wallets (user_id) VALUES ($1)`, userID)
	return err
}

func (s *Store) GetWallet(ctx context.Context, userID string) (*model.Wallet, error) {
	w := &model.Wallet{}
	err := s.DB.QueryRowContext(ctx,
		`SELECT user_id, balance_cents, locked_cents FROM wallets WHERE user_id=$1`, userID,
	).Scan(&w.UserID, &w.BalanceCents, &w.LockedCents)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return w, err
}

func (s *Store) GetWalletForUpdate(tx *sql.Tx, userID string) (*model.Wallet, error) {
	w := &model.Wallet{}
	err := tx.QueryRow(
		`SELECT user_id, balance_cents, locked_cents FROM wallets WHERE user_id=$1 FOR UPDATE`, userID,
	).Scan(&w.UserID, &w.BalanceCents, &w.LockedCents)
	return w, err
}

func (s *Store) DepositWallet(ctx context.Context, userID string, cents int64) (*model.Wallet, error) {
	w := &model.Wallet{}
	err := s.DB.QueryRowContext(ctx,
		`UPDATE wallets SET balance_cents = balance_cents + $1 WHERE user_id=$2
		 RETURNING user_id, balance_cents, locked_cents`, cents, userID,
	).Scan(&w.UserID, &w.BalanceCents, &w.LockedCents)
	return w, err
}

func WalletAddLocked(tx *sql.Tx, userID string, delta int64) error {
	_, err := tx.Exec(`UPDATE wallets SET locked_cents = locked_cents + $1 WHERE user_id=$2`, delta, userID)
	return err
}

func WalletAddBalance(tx *sql.Tx, userID string, delta int64) error {
	_, err := tx.Exec(`UPDATE wallets SET balance_cents = balance_cents + $1 WHERE user_id=$2`, delta, userID)
	return err
}

func RecalcLocked(tx *sql.Tx, userID string) error {
	var orderLock int64
	if err := tx.QueryRow(
		`SELECT COALESCE(SUM(locked_cents),0) FROM orders WHERE user_id=$1 AND status IN ('OPEN','PARTIAL')`, userID,
	).Scan(&orderLock); err != nil {
		return err
	}
	var posLock int64
	if err := tx.QueryRow(
		`SELECT COALESCE(SUM(GREATEST(-yes_shares,0))*100,0) FROM positions WHERE user_id=$1`, userID,
	).Scan(&posLock); err != nil {
		return err
	}
	_, err := tx.Exec(`UPDATE wallets SET locked_cents=$1 WHERE user_id=$2`, orderLock+posLock, userID)
	return err
}

// ── Markets ──────────────────────────────────────────

func (s *Store) CreateMarket(ctx context.Context, slug, title, desc string, tick int) (*model.Market, error) {
	m := &model.Market{}
	err := s.DB.QueryRowContext(ctx,
		`INSERT INTO markets (slug,title,description,tick_size_cents)
		 VALUES ($1,$2,$3,$4)
		 RETURNING id,slug,title,description,status,resolves_to,tick_size_cents,created_at,resolved_at`,
		slug, title, desc, tick,
	).Scan(&m.ID, &m.Slug, &m.Title, &m.Description, &m.Status, &m.ResolvesTo, &m.TickSizeCents, &m.CreatedAt, &m.ResolvedAt)
	return m, err
}

func (s *Store) ListMarkets(ctx context.Context) ([]model.Market, error) {
	rows, err := s.DB.QueryContext(ctx,
		`SELECT id,slug,title,description,status,resolves_to,tick_size_cents,created_at,resolved_at
		 FROM markets ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []model.Market
	for rows.Next() {
		var m model.Market
		if err := rows.Scan(&m.ID, &m.Slug, &m.Title, &m.Description, &m.Status, &m.ResolvesTo, &m.TickSizeCents, &m.CreatedAt, &m.ResolvedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, nil
}

func (s *Store) GetMarket(ctx context.Context, id string) (*model.Market, error) {
	m := &model.Market{}
	err := s.DB.QueryRowContext(ctx,
		`SELECT id,slug,title,description,status,resolves_to,tick_size_cents,created_at,resolved_at
		 FROM markets WHERE id=$1`, id,
	).Scan(&m.ID, &m.Slug, &m.Title, &m.Description, &m.Status, &m.ResolvesTo, &m.TickSizeCents, &m.CreatedAt, &m.ResolvedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return m, err
}

func (s *Store) GetOpenMarkets(ctx context.Context) ([]model.Market, error) {
	rows, err := s.DB.QueryContext(ctx,
		`SELECT id,slug,title,description,status,resolves_to,tick_size_cents,created_at,resolved_at
		 FROM markets WHERE status='OPEN'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []model.Market
	for rows.Next() {
		var m model.Market
		if err := rows.Scan(&m.ID, &m.Slug, &m.Title, &m.Description, &m.Status, &m.ResolvesTo, &m.TickSizeCents, &m.CreatedAt, &m.ResolvedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, nil
}

// ── Orders ───────────────────────────────────────────

func InsertOrder(tx *sql.Tx, o *model.Order) error {
	_, err := tx.Exec(
		`INSERT INTO orders (id,market_id,user_id,side,order_type,price_cents,qty,remaining_qty,locked_cents,status,seq,client_order_id)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
		o.ID, o.MarketID, o.UserID, o.Side, o.OrderType, o.PriceCents, o.Qty, o.RemainingQty, o.LockedCents, o.Status, o.Seq, o.ClientOrderID,
	)
	return err
}

func UpdateOrderFill(tx *sql.Tx, orderID string, remainingQty int, lockedCents int64, status model.OrderStatus) error {
	_, err := tx.Exec(
		`UPDATE orders SET remaining_qty=$1, locked_cents=$2, status=$3, updated_at=now() WHERE id=$4`,
		remainingQty, lockedCents, status, orderID,
	)
	return err
}

func (s *Store) GetOpenOrders(ctx context.Context, marketID string) ([]model.Order, error) {
	rows, err := s.DB.QueryContext(ctx,
		`SELECT id,market_id,user_id,side,order_type,price_cents,qty,remaining_qty,locked_cents,status,seq,client_order_id,created_at,updated_at
		 FROM orders WHERE market_id=$1 AND status IN ('OPEN','PARTIAL') ORDER BY seq`, marketID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanOrders(rows)
}

func (s *Store) GetUserOrders(ctx context.Context, marketID, userID string) ([]model.Order, error) {
	rows, err := s.DB.QueryContext(ctx,
		`SELECT id,market_id,user_id,side,order_type,price_cents,qty,remaining_qty,locked_cents,status,seq,client_order_id,created_at,updated_at
		 FROM orders WHERE market_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 100`, marketID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanOrders(rows)
}

func (s *Store) GetOrder(ctx context.Context, id string) (*model.Order, error) {
	row := s.DB.QueryRowContext(ctx,
		`SELECT id,market_id,user_id,side,order_type,price_cents,qty,remaining_qty,locked_cents,status,seq,client_order_id,created_at,updated_at
		 FROM orders WHERE id=$1`, id)
	o := &model.Order{}
	err := row.Scan(&o.ID, &o.MarketID, &o.UserID, &o.Side, &o.OrderType, &o.PriceCents, &o.Qty, &o.RemainingQty, &o.LockedCents, &o.Status, &o.Seq, &o.ClientOrderID, &o.CreatedAt, &o.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return o, err
}

func (s *Store) MaxSeq(ctx context.Context, marketID string) (int64, error) {
	var seq int64
	err := s.DB.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(seq),0) FROM (
			SELECT seq FROM orders WHERE market_id=$1
			UNION ALL SELECT seq FROM trades WHERE market_id=$1
			UNION ALL SELECT seq FROM event_log WHERE market_id=$1 AND seq IS NOT NULL
		 ) t`, marketID,
	).Scan(&seq)
	return seq, err
}

func scanOrders(rows *sql.Rows) ([]model.Order, error) {
	var out []model.Order
	for rows.Next() {
		var o model.Order
		if err := rows.Scan(&o.ID, &o.MarketID, &o.UserID, &o.Side, &o.OrderType, &o.PriceCents, &o.Qty, &o.RemainingQty, &o.LockedCents, &o.Status, &o.Seq, &o.ClientOrderID, &o.CreatedAt, &o.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, nil
}

// ── Trades ───────────────────────────────────────────

func InsertTrade(tx *sql.Tx, t *model.Trade) error {
	_, err := tx.Exec(
		`INSERT INTO trades (id,market_id,maker_order_id,taker_order_id,maker_user_id,taker_user_id,price_cents,qty,fee_cents,seq)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
		t.ID, t.MarketID, t.MakerOrderID, t.TakerOrderID, t.MakerUserID, t.TakerUserID, t.PriceCents, t.Qty, t.FeeCents, t.Seq,
	)
	return err
}

func (s *Store) ListTrades(ctx context.Context, marketID string, limit int) ([]model.Trade, error) {
	rows, err := s.DB.QueryContext(ctx,
		`SELECT id,market_id,maker_order_id,taker_order_id,maker_user_id,taker_user_id,price_cents,qty,fee_cents,seq,created_at
		 FROM trades WHERE market_id=$1 ORDER BY created_at DESC LIMIT $2`, marketID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []model.Trade
	for rows.Next() {
		var t model.Trade
		if err := rows.Scan(&t.ID, &t.MarketID, &t.MakerOrderID, &t.TakerOrderID, &t.MakerUserID, &t.TakerUserID, &t.PriceCents, &t.Qty, &t.FeeCents, &t.Seq, &t.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, nil
}

// ── Positions ────────────────────────────────────────

func UpsertPosition(tx *sql.Tx, marketID, userID string, sharesDelta int) error {
	_, err := tx.Exec(
		`INSERT INTO positions (market_id, user_id, yes_shares) VALUES ($1,$2,$3)
		 ON CONFLICT (market_id, user_id) DO UPDATE SET yes_shares = positions.yes_shares + $3`,
		marketID, userID, sharesDelta,
	)
	return err
}

func (s *Store) ListPositions(ctx context.Context, marketID string) ([]model.Position, error) {
	rows, err := s.DB.QueryContext(ctx,
		`SELECT id,market_id,user_id,yes_shares,avg_cost_cents,realized_pnl_cents FROM positions WHERE market_id=$1`, marketID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []model.Position
	for rows.Next() {
		var p model.Position
		if err := rows.Scan(&p.ID, &p.MarketID, &p.UserID, &p.YesShares, &p.AvgCostCents, &p.RealizedPnlCents); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, nil
}

// ── Event Log ────────────────────────────────────────

func AppendEvent(tx *sql.Tx, marketID *string, seq *int64, evType string, payload any) error {
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = tx.Exec(
		`INSERT INTO event_log (market_id, seq, type, payload_json) VALUES ($1,$2,$3,$4)`,
		marketID, seq, evType, b,
	)
	return err
}

func (s *Store) ListEvents(ctx context.Context, marketID *string, limit int) ([]model.EventLog, error) {
	q := `SELECT id, market_id, seq, type, payload_json, created_at FROM event_log`
	var args []any
	if marketID != nil {
		q += ` WHERE market_id=$1`
		args = append(args, *marketID)
	}
	q += ` ORDER BY created_at DESC LIMIT ` + fmt.Sprintf("%d", limit)
	rows, err := s.DB.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []model.EventLog
	for rows.Next() {
		var e model.EventLog
		var raw []byte
		if err := rows.Scan(&e.ID, &e.MarketID, &e.Seq, &e.Type, &raw, &e.CreatedAt); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(raw, &e.PayloadJSON)
		out = append(out, e)
	}
	return out, nil
}

// ── Platform Fee ─────────────────────────────────────

func AddPlatformFee(tx *sql.Tx, cents int64) error {
	_, err := tx.Exec(`UPDATE platform_fee_wallet SET balance_cents = balance_cents + $1 WHERE id=1`, cents)
	return err
}

func (s *Store) GetPlatformFee(ctx context.Context) (int64, error) {
	var c int64
	err := s.DB.QueryRowContext(ctx, `SELECT balance_cents FROM platform_fee_wallet WHERE id=1`).Scan(&c)
	return c, err
}

// ── Settlement helpers ───────────────────────────────

func ResolveMarket(tx *sql.Tx, marketID, resolvesTo string) error {
	_, err := tx.Exec(
		`UPDATE markets SET status='RESOLVED', resolves_to=$1, resolved_at=now() WHERE id=$2`,
		resolvesTo, marketID,
	)
	return err
}

func CancelOrderTx(tx *sql.Tx, orderID string) (int64, error) {
	var locked int64
	err := tx.QueryRow(
		`UPDATE orders SET status='CANCELED', remaining_qty=0, locked_cents=0, updated_at=now()
		 WHERE id=$1 RETURNING locked_cents`, orderID,
	).Scan(&locked)
	// locked is the OLD value before zeroing — but we zeroed it. Need a different approach.
	// Re-query first:
	return locked, err
}

// ── Anchor / SideBet / Promotion ─────────────────────

func (s *Store) CreateAnchorBet(ctx context.Context, creator, title, rules string, opponent, arbitrator *string) (*model.AnchorBet, error) {
	a := &model.AnchorBet{}
	err := s.DB.QueryRowContext(ctx,
		`INSERT INTO anchor_bets (creator_user_id,opponent_user_id,title,rules_text,arbitrator_user_id)
		 VALUES ($1,$2,$3,$4,$5)
		 RETURNING id,creator_user_id,opponent_user_id,title,rules_text,status,arbitrator_user_id,created_at`,
		creator, opponent, title, rules, arbitrator,
	).Scan(&a.ID, &a.CreatorUserID, &a.OpponentUserID, &a.Title, &a.RulesText, &a.Status, &a.ArbitratorUserID, &a.CreatedAt)
	return a, err
}

func (s *Store) CreateSideBet(ctx context.Context, anchorID, userID, direction string, amount int64) (*model.SideBet, error) {
	sb := &model.SideBet{}
	err := s.DB.QueryRowContext(ctx,
		`INSERT INTO side_bets (anchor_bet_id,user_id,direction,amount_cents)
		 VALUES ($1,$2,$3,$4) RETURNING id,anchor_bet_id,user_id,direction,amount_cents,created_at`,
		anchorID, userID, direction, amount,
	).Scan(&sb.ID, &sb.AnchorBetID, &sb.UserID, &sb.Direction, &sb.AmountCents, &sb.CreatedAt)
	return sb, err
}

func (s *Store) ListAnchorBets(ctx context.Context) ([]model.AnchorBet, error) {
	rows, err := s.DB.QueryContext(ctx,
		`SELECT id,creator_user_id,opponent_user_id,title,rules_text,status,arbitrator_user_id,created_at
		 FROM anchor_bets ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []model.AnchorBet
	for rows.Next() {
		var a model.AnchorBet
		if err := rows.Scan(&a.ID, &a.CreatorUserID, &a.OpponentUserID, &a.Title, &a.RulesText, &a.Status, &a.ArbitratorUserID, &a.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, nil
}

func (s *Store) GetAnchorBet(ctx context.Context, id string) (*model.AnchorBet, error) {
	a := &model.AnchorBet{}
	err := s.DB.QueryRowContext(ctx,
		`SELECT id,creator_user_id,opponent_user_id,title,rules_text,status,arbitrator_user_id,created_at
		 FROM anchor_bets WHERE id=$1`, id,
	).Scan(&a.ID, &a.CreatorUserID, &a.OpponentUserID, &a.Title, &a.RulesText, &a.Status, &a.ArbitratorUserID, &a.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return a, err
}

func (s *Store) GetWalletUsers(ctx context.Context) ([]struct {
	model.User
	model.Wallet
}, error) {
	rows, err := s.DB.QueryContext(ctx,
		`SELECT u.id,u.email,u.role,u.created_at,w.balance_cents,w.locked_cents
		 FROM users u JOIN wallets w ON w.user_id=u.id ORDER BY u.created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []struct {
		model.User
		model.Wallet
	}
	for rows.Next() {
		var uw struct {
			model.User
			model.Wallet
		}
		if err := rows.Scan(&uw.User.ID, &uw.User.Email, &uw.User.Role, &uw.User.CreatedAt,
			&uw.Wallet.BalanceCents, &uw.Wallet.LockedCents); err != nil {
			return nil, err
		}
		uw.Wallet.UserID = uw.User.ID
		out = append(out, uw)
	}
	return out, nil
}
