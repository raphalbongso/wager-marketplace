package engine

import (
	"context"
	"fmt"
	"log"
	"sync"

	"github.com/google/uuid"
	"wager-exchange/internal/db"
	"wager-exchange/internal/model"
)

// PublishFunc broadcasts a WS message for a market.
type PublishFunc func(marketID, msgType string, data any)

// ── Manager ──────────────────────────────────────────

type Manager struct {
	engines map[string]*MarketEngine
	mu      sync.RWMutex
	store   *db.Store
	publish PublishFunc
	feeBps  int
}

func NewManager(store *db.Store, pub PublishFunc, feeBps int) *Manager {
	return &Manager{
		engines: make(map[string]*MarketEngine),
		store:   store,
		publish: pub,
		feeBps:  feeBps,
	}
}

func (m *Manager) Boot(ctx context.Context) error {
	markets, err := m.store.GetOpenMarkets(ctx)
	if err != nil {
		return err
	}
	for _, mkt := range markets {
		if err := m.StartEngine(ctx, mkt.ID); err != nil {
			return fmt.Errorf("boot %s: %w", mkt.ID, err)
		}
	}
	log.Printf("[engine] booted %d market engines", len(markets))
	return nil
}

func (m *Manager) StartEngine(ctx context.Context, marketID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.engines[marketID]; ok {
		return nil
	}
	eng, err := newMarketEngine(ctx, marketID, m.store, m.publish, m.feeBps)
	if err != nil {
		return err
	}
	m.engines[marketID] = eng
	// Use background context so the engine outlives the HTTP request that created it
	go eng.run(context.Background())
	return nil
}

func (m *Manager) GetEngine(marketID string) *MarketEngine {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.engines[marketID]
}

func (m *Manager) GetBook(marketID string) (bids, asks []BookLevel) {
	eng := m.GetEngine(marketID)
	if eng == nil {
		return []BookLevel{}, []BookLevel{}
	}
	return eng.book.Snapshot(20)
}

// ── MarketEngine ─────────────────────────────────────

type MarketEngine struct {
	marketID string
	book     *OrderBook
	seq      int64
	cmdCh    chan command
	store    *db.Store
	publish  PublishFunc
	feeBps   int
}

func newMarketEngine(ctx context.Context, marketID string, store *db.Store, pub PublishFunc, feeBps int) (*MarketEngine, error) {
	book := NewOrderBook()
	// Load open orders
	orders, err := store.GetOpenOrders(ctx, marketID)
	if err != nil {
		return nil, err
	}
	for i := range orders {
		o := &orders[i]
		if o.PriceCents == nil {
			continue
		}
		book.Add(&OrderEntry{
			OrderID:      o.ID,
			UserID:       o.UserID,
			Side:         string(o.Side),
			PriceCents:   *o.PriceCents,
			RemainingQty: o.RemainingQty,
			LockedCents:  o.LockedCents,
			Seq:          o.Seq,
		})
	}
	// Load max seq
	seq, err := store.MaxSeq(ctx, marketID)
	if err != nil {
		return nil, err
	}
	log.Printf("[engine] market %s: loaded %d orders, seq=%d", marketID, len(orders), seq)
	return &MarketEngine{
		marketID: marketID,
		book:     book,
		seq:      seq,
		cmdCh:    make(chan command, 64),
		store:    store,
		publish:  pub,
		feeBps:   feeBps,
	}, nil
}

func (e *MarketEngine) run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case cmd := <-e.cmdCh:
			cmd.exec(e)
		}
	}
}

func (e *MarketEngine) nextSeq() int64 {
	e.seq++
	return e.seq
}

// ── Commands ─────────────────────────────────────────

type command interface{ exec(e *MarketEngine) }

type placeCmd struct {
	req    model.PlaceOrderReq
	userID string
	ch     chan<- model.PlaceOrderResult
}

type cancelCmd struct {
	orderID string
	userID  string
	ch      chan<- error
}

type resolveCmd struct {
	resolvesTo string
	adminID    string
	ch         chan<- error
}

func (c placeCmd) exec(e *MarketEngine)   { c.ch <- e.processOrder(c.userID, c.req) }
func (c cancelCmd) exec(e *MarketEngine)  { c.ch <- e.cancelOrder(c.orderID, c.userID) }
func (c resolveCmd) exec(e *MarketEngine) { c.ch <- e.resolveMarket(c.resolvesTo, c.adminID) }

// PlaceOrder sends a place-order command to the market goroutine and waits.
func (e *MarketEngine) PlaceOrder(userID string, req model.PlaceOrderReq) model.PlaceOrderResult {
	ch := make(chan model.PlaceOrderResult, 1)
	e.cmdCh <- placeCmd{req: req, userID: userID, ch: ch}
	return <-ch
}

func (e *MarketEngine) CancelOrder(orderID, userID string) error {
	ch := make(chan error, 1)
	e.cmdCh <- cancelCmd{orderID: orderID, userID: userID, ch: ch}
	return <-ch
}

func (e *MarketEngine) ResolveMarket(resolvesTo, adminID string) error {
	ch := make(chan error, 1)
	e.cmdCh <- resolveCmd{resolvesTo: resolvesTo, adminID: adminID, ch: ch}
	return <-ch
}

// ── Process Order ────────────────────────────────────

func (e *MarketEngine) processOrder(userID string, req model.PlaceOrderReq) model.PlaceOrderResult {
	reject := func(reason string) model.PlaceOrderResult {
		return model.PlaceOrderResult{Status: model.StatusRejected, Reason: reason}
	}

	// Validate
	if req.Type == model.TypeLimit {
		if req.PriceCents == nil || *req.PriceCents < 1 || *req.PriceCents > 99 {
			return reject("price must be 1-99")
		}
	}
	if req.Qty < 1 {
		return reject("qty must be >= 1")
	}

	// Required lock
	lockNeeded := model.CalcLock(req.Side, req.Type, req.PriceCents, req.Qty, e.feeBps)

	// Find matches in memory (non-mutating peek)
	matches := e.book.FindMatches(string(req.Side), req.PriceCents, req.Qty, userID)

	// For MARKET orders, if no matches -> cancel
	if req.Type == model.TypeMarket && len(matches) == 0 {
		return model.PlaceOrderResult{Status: model.StatusCanceled, Reason: "no liquidity"}
	}

	// For MARKET: tighten lock to actual fills
	if req.Type == model.TypeMarket {
		var actual int64
		for _, m := range matches {
			if req.Side == model.SideBuy {
				actual += int64(m.FillPrice)*int64(m.FillQty) + model.CalcTakerFee(m.FillPrice, m.FillQty, e.feeBps)
			} else {
				actual += (100-int64(m.FillPrice))*int64(m.FillQty) + model.CalcTakerFee(m.FillPrice, m.FillQty, e.feeBps)
			}
		}
		lockNeeded = actual
	}

	orderID := uuid.New().String()
	seq := e.nextSeq()

	fillQty := 0
	for _, m := range matches {
		fillQty += m.FillQty
	}
	remainingQty := req.Qty - fillQty

	// Determine status
	var status model.OrderStatus
	switch {
	case fillQty == req.Qty:
		status = model.StatusFilled
	case fillQty > 0 && req.Type == model.TypeLimit:
		status = model.StatusPartial
	case fillQty > 0 && req.Type == model.TypeMarket:
		status = model.StatusFilled // remainder canceled
		remainingQty = 0
	case req.Type == model.TypeLimit:
		status = model.StatusOpen
	default:
		status = model.StatusCanceled
	}

	// Resting lock (for LIMIT orders that rest on book)
	restingLock := int64(0)
	if (status == model.StatusOpen || status == model.StatusPartial) && remainingQty > 0 {
		restingLock = model.CalcLock(req.Side, model.TypeLimit, req.PriceCents, remainingQty, e.feeBps)
	}

	// ── DB Transaction ───────────────────────────────
	ctx := context.Background()
	tx, err := e.store.BeginTx(ctx)
	if err != nil {
		return reject("internal error")
	}
	defer tx.Rollback()

	// Lock wallet
	wallet, err := e.store.GetWalletForUpdate(tx, userID)
	if err != nil {
		return reject("wallet not found")
	}
	if wallet.Available() < lockNeeded {
		return reject(fmt.Sprintf("insufficient balance: need %d, have %d", lockNeeded, wallet.Available()))
	}

	// Lock funds
	if err := db.WalletAddLocked(tx, userID, lockNeeded); err != nil {
		return reject("lock failed")
	}

	// Insert order
	order := &model.Order{
		ID: orderID, MarketID: e.marketID, UserID: userID,
		Side: req.Side, OrderType: req.Type, PriceCents: req.PriceCents,
		Qty: req.Qty, RemainingQty: remainingQty,
		LockedCents: restingLock, Status: status, Seq: seq,
		ClientOrderID: req.ClientOrderID,
	}
	if err := db.InsertOrder(tx, order); err != nil {
		return reject("order insert failed: " + err.Error())
	}

	// Event: OrderAccepted
	db.AppendEvent(tx, &e.marketID, &seq, "OrderAccepted", map[string]any{
		"order_id": orderID, "side": req.Side, "type": req.Type,
		"price": req.PriceCents, "qty": req.Qty, "user_id": userID,
	})

	// Process fills
	var trades []model.Trade
	affectedUsers := map[string]bool{userID: true}

	for _, m := range matches {
		tradeSeq := e.nextSeq()
		tradeID := uuid.New().String()
		ep := m.FillPrice
		fq := m.FillQty
		fee := model.CalcTakerFee(ep, fq, e.feeBps)

		// Maker order update
		makerEntry := m.Entry
		e.book.ApplyFill(makerEntry.OrderID, fq)
		makerNewRem := makerEntry.RemainingQty
		makerStatus := model.StatusPartial
		if makerNewRem == 0 {
			makerStatus = model.StatusFilled
		}
		// Proportional lock release for maker
		makerLockRelease := makerEntry.LockedCents
		if makerNewRem > 0 {
			makerLockRelease = makerEntry.LockedCents * int64(fq) / int64(makerNewRem+fq)
		}
		makerEntry.LockedCents -= makerLockRelease

		if err := db.UpdateOrderFill(tx, makerEntry.OrderID, makerNewRem, makerEntry.LockedCents, makerStatus); err != nil {
			return reject("maker update failed")
		}

		// Maker wallet: release lock + cash delta
		if err := db.WalletAddLocked(tx, makerEntry.UserID, -makerLockRelease); err != nil {
			return reject("maker wallet failed")
		}
		makerCash := int64(ep) * int64(fq)
		if makerEntry.Side == "BUY" {
			makerCash = -makerCash // buyer pays
		}
		if err := db.WalletAddBalance(tx, makerEntry.UserID, makerCash); err != nil {
			return reject("maker balance failed")
		}

		// Maker position
		makerSharesDelta := fq
		if makerEntry.Side == "SELL" {
			makerSharesDelta = -fq
		}
		if err := db.UpsertPosition(tx, e.marketID, makerEntry.UserID, makerSharesDelta); err != nil {
			return reject("maker position failed")
		}

		// Taker wallet: cash delta
		takerCash := int64(0)
		if req.Side == model.SideBuy {
			takerCash = -(int64(ep)*int64(fq) + fee)
		} else {
			takerCash = int64(ep)*int64(fq) - fee
		}
		if err := db.WalletAddBalance(tx, userID, takerCash); err != nil {
			return reject("taker balance failed")
		}

		// Taker position
		takerSharesDelta := fq
		if req.Side == model.SideSell {
			takerSharesDelta = -fq
		}
		if err := db.UpsertPosition(tx, e.marketID, userID, takerSharesDelta); err != nil {
			return reject("taker position failed")
		}

		// Platform fee
		if fee > 0 {
			if err := db.AddPlatformFee(tx, fee); err != nil {
				return reject("fee failed")
			}
		}

		// Trade row
		trade := &model.Trade{
			ID: tradeID, MarketID: e.marketID,
			MakerOrderID: makerEntry.OrderID, TakerOrderID: orderID,
			MakerUserID: makerEntry.UserID, TakerUserID: userID,
			PriceCents: ep, Qty: fq, FeeCents: fee, Seq: tradeSeq,
		}
		if err := db.InsertTrade(tx, trade); err != nil {
			return reject("trade insert failed")
		}
		trades = append(trades, *trade)

		db.AppendEvent(tx, &e.marketID, &tradeSeq, "TradeExecuted", map[string]any{
			"trade_id": tradeID, "price": ep, "qty": fq, "fee": fee,
			"taker_side": req.Side, "maker_order": makerEntry.OrderID,
		})

		affectedUsers[makerEntry.UserID] = true
	}

	// Release taker's excess lock: locked lockNeeded, keeping restingLock
	takerRelease := lockNeeded - restingLock
	if err := db.WalletAddLocked(tx, userID, -takerRelease); err != nil {
		return reject("taker unlock failed")
	}

	// Recalc locked for all affected users (handles position locks)
	for uid := range affectedUsers {
		if err := db.RecalcLocked(tx, uid); err != nil {
			return reject("recalc failed: " + err.Error())
		}
	}

	if err := tx.Commit(); err != nil {
		return reject("commit failed: " + err.Error())
	}

	// Add resting order to in-memory book (after commit)
	if (status == model.StatusOpen || status == model.StatusPartial) && remainingQty > 0 {
		e.book.Add(&OrderEntry{
			OrderID:      orderID,
			UserID:       userID,
			Side:         string(req.Side),
			PriceCents:   *req.PriceCents,
			RemainingQty: remainingQty,
			LockedCents:  restingLock,
			Seq:          seq,
		})
	}

	// Publish WS
	if e.publish != nil {
		bids, asks := e.book.Snapshot(20)
		e.publish(e.marketID, "book_snapshot", map[string]any{"bids": bids, "asks": asks})
		for _, t := range trades {
			e.publish(e.marketID, "trade", t)
		}
	}

	return model.PlaceOrderResult{OrderID: orderID, Status: status, Trades: trades}
}

// ── Cancel ───────────────────────────────────────────

func (e *MarketEngine) cancelOrder(orderID, userID string) error {
	ctx := context.Background()
	o, err := e.store.GetOrder(ctx, orderID)
	if err != nil || o == nil {
		return fmt.Errorf("order not found")
	}
	if o.UserID != userID {
		return fmt.Errorf("not your order")
	}
	if o.Status != model.StatusOpen && o.Status != model.StatusPartial {
		return fmt.Errorf("order not cancelable")
	}

	e.book.Remove(orderID)

	tx, err := e.store.BeginTx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	_, err = tx.Exec(`UPDATE orders SET status='CANCELED', remaining_qty=0, locked_cents=0, updated_at=now() WHERE id=$1`, orderID)
	if err != nil {
		return err
	}
	if err := db.WalletAddLocked(tx, userID, -o.LockedCents); err != nil {
		return err
	}
	seq := e.nextSeq()
	db.AppendEvent(tx, &e.marketID, &seq, "OrderCanceled", map[string]any{
		"order_id": orderID, "user_id": userID,
	})
	if err := tx.Commit(); err != nil {
		return err
	}

	if e.publish != nil {
		bids, asks := e.book.Snapshot(20)
		e.publish(e.marketID, "book_snapshot", map[string]any{"bids": bids, "asks": asks})
	}
	return nil
}

// ── Settlement ───────────────────────────────────────

func (e *MarketEngine) resolveMarket(resolvesTo, adminID string) error {
	ctx := context.Background()

	// Cancel all open orders first
	openOrders, err := e.store.GetOpenOrders(ctx, e.marketID)
	if err != nil {
		return err
	}
	for _, o := range openOrders {
		// Use internal cancel (already in engine goroutine)
		e.cancelOrderInternal(o.ID, o.UserID)
	}

	// Get all positions
	positions, err := e.store.ListPositions(ctx, e.marketID)
	if err != nil {
		return err
	}

	tx, err := e.store.BeginTx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	totalPayout := int64(0)
	settled := 0

	for _, pos := range positions {
		if pos.YesShares == 0 {
			continue
		}
		var payout int64
		var lockRelease int64

		if resolvesTo == "YES" {
			payout = int64(pos.YesShares) * 100
			if pos.YesShares < 0 {
				lockRelease = int64(-pos.YesShares) * 100
			}
		} else {
			// NO: YES shares worthless
			if pos.YesShares < 0 {
				lockRelease = int64(-pos.YesShares) * 100
			}
		}

		if payout != 0 {
			if err := db.WalletAddBalance(tx, pos.UserID, payout); err != nil {
				return err
			}
		}
		if lockRelease > 0 {
			if err := db.WalletAddLocked(tx, pos.UserID, -lockRelease); err != nil {
				return err
			}
		}
		if payout > 0 {
			totalPayout += payout
		}
		settled++
	}

	if err := db.ResolveMarket(tx, e.marketID, resolvesTo); err != nil {
		return err
	}

	db.AppendEvent(tx, &e.marketID, nil, "MarketResolved", map[string]any{
		"resolves_to": resolvesTo, "admin_id": adminID,
		"settled_positions": settled, "total_payout": totalPayout,
	})

	if err := tx.Commit(); err != nil {
		return err
	}

	log.Printf("[engine] market %s resolved %s: %d positions, %d payout", e.marketID, resolvesTo, settled, totalPayout)
	return nil
}

func (e *MarketEngine) cancelOrderInternal(orderID, userID string) {
	e.book.Remove(orderID)
	ctx := context.Background()
	tx, _ := e.store.BeginTx(ctx)
	if tx == nil {
		return
	}
	tx.Exec(`UPDATE orders SET status='CANCELED', remaining_qty=0, locked_cents=0, updated_at=now() WHERE id=$1`, orderID)
	// Get the locked amount from DB
	var locked int64
	tx.QueryRow(`SELECT locked_cents FROM orders WHERE id=$1`, orderID).Scan(&locked)
	db.WalletAddLocked(tx, userID, -locked)
	tx.Commit()
}
