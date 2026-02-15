package engine

import "sort"

// OrderEntry is a resting order in the book.
type OrderEntry struct {
	OrderID      string
	UserID       string
	Side         string // "BUY" or "SELL"
	PriceCents   int
	RemainingQty int
	LockedCents  int64
	Seq          int64
}

// Level is a price level with a FIFO queue of orders.
type Level struct {
	Price  int
	Orders []*OrderEntry
}

func (l *Level) TotalQty() int {
	t := 0
	for _, o := range l.Orders {
		t += o.RemainingQty
	}
	return t
}

// Match represents a potential fill against a resting order.
type Match struct {
	Entry     *OrderEntry
	FillQty   int
	FillPrice int
}

// OrderBook is an in-memory limit order book for a single market.
type OrderBook struct {
	bids      map[int]*Level // price -> Level
	asks      map[int]*Level
	bidPrices []int // sorted descending
	askPrices []int // sorted ascending
	index     map[string]*OrderEntry
}

func NewOrderBook() *OrderBook {
	return &OrderBook{
		bids:  make(map[int]*Level),
		asks:  make(map[int]*Level),
		index: make(map[string]*OrderEntry),
	}
}

// ── Queries ──────────────────────────────────────────

func (b *OrderBook) BestBid() *int {
	if len(b.bidPrices) == 0 {
		return nil
	}
	p := b.bidPrices[0]
	return &p
}

func (b *OrderBook) BestAsk() *int {
	if len(b.askPrices) == 0 {
		return nil
	}
	p := b.askPrices[0]
	return &p
}

func (b *OrderBook) Size() int { return len(b.index) }

type BookLevel struct {
	Price int `json:"price"`
	Qty   int `json:"qty"`
}

func (b *OrderBook) Snapshot(depth int) (bids, asks []BookLevel) {
	for i := 0; i < len(b.bidPrices) && i < depth; i++ {
		p := b.bidPrices[i]
		bids = append(bids, BookLevel{Price: p, Qty: b.bids[p].TotalQty()})
	}
	for i := 0; i < len(b.askPrices) && i < depth; i++ {
		p := b.askPrices[i]
		asks = append(asks, BookLevel{Price: p, Qty: b.asks[p].TotalQty()})
	}
	if bids == nil {
		bids = []BookLevel{}
	}
	if asks == nil {
		asks = []BookLevel{}
	}
	return
}

// ── Add / Remove ─────────────────────────────────────

func (b *OrderBook) Add(e *OrderEntry) {
	if _, exists := b.index[e.OrderID]; exists {
		return
	}
	b.index[e.OrderID] = e
	if e.Side == "BUY" {
		b.addToSide(b.bids, &b.bidPrices, e, false) // desc
	} else {
		b.addToSide(b.asks, &b.askPrices, e, true) // asc
	}
}

func (b *OrderBook) Remove(orderID string) *OrderEntry {
	e, ok := b.index[orderID]
	if !ok {
		return nil
	}
	delete(b.index, orderID)
	if e.Side == "BUY" {
		b.removeFromSide(b.bids, &b.bidPrices, e)
	} else {
		b.removeFromSide(b.asks, &b.askPrices, e)
	}
	return e
}

// ── Matching ─────────────────────────────────────────

// FindMatches returns potential matches without mutating the book.
func (b *OrderBook) FindMatches(side string, priceCents *int, maxQty int, excludeUserID string) []Match {
	var matches []Match
	rem := maxQty

	if side == "BUY" {
		for _, askPrice := range b.askPrices {
			if rem <= 0 {
				break
			}
			if priceCents != nil && askPrice > *priceCents {
				break
			}
			level := b.asks[askPrice]
			for _, entry := range level.Orders {
				if rem <= 0 {
					break
				}
				if entry.UserID == excludeUserID {
					continue
				}
				fq := min(rem, entry.RemainingQty)
				matches = append(matches, Match{Entry: entry, FillQty: fq, FillPrice: askPrice})
				rem -= fq
			}
		}
	} else {
		for _, bidPrice := range b.bidPrices {
			if rem <= 0 {
				break
			}
			if priceCents != nil && bidPrice < *priceCents {
				break
			}
			level := b.bids[bidPrice]
			for _, entry := range level.Orders {
				if rem <= 0 {
					break
				}
				if entry.UserID == excludeUserID {
					continue
				}
				fq := min(rem, entry.RemainingQty)
				matches = append(matches, Match{Entry: entry, FillQty: fq, FillPrice: bidPrice})
				rem -= fq
			}
		}
	}
	return matches
}

// ApplyFill reduces the remaining qty of a resting order.
// Returns remaining qty after fill. Removes from book if fully filled.
func (b *OrderBook) ApplyFill(orderID string, fillQty int) int {
	e := b.index[orderID]
	if e == nil {
		return 0
	}
	e.RemainingQty -= fillQty
	if e.RemainingQty <= 0 {
		b.Remove(orderID)
		return 0
	}
	return e.RemainingQty
}

// ── Internals ────────────────────────────────────────

func (b *OrderBook) addToSide(m map[int]*Level, prices *[]int, e *OrderEntry, asc bool) {
	level, ok := m[e.PriceCents]
	if !ok {
		level = &Level{Price: e.PriceCents}
		m[e.PriceCents] = level
		*prices = append(*prices, e.PriceCents)
		if asc {
			sort.Ints(*prices)
		} else {
			sort.Sort(sort.Reverse(sort.IntSlice(*prices)))
		}
	}
	level.Orders = append(level.Orders, e)
}

func (b *OrderBook) removeFromSide(m map[int]*Level, prices *[]int, e *OrderEntry) {
	level, ok := m[e.PriceCents]
	if !ok {
		return
	}
	for i, o := range level.Orders {
		if o.OrderID == e.OrderID {
			level.Orders = append(level.Orders[:i], level.Orders[i+1:]...)
			break
		}
	}
	if len(level.Orders) == 0 {
		delete(m, e.PriceCents)
		for i, p := range *prices {
			if p == e.PriceCents {
				*prices = append((*prices)[:i], (*prices)[i+1:]...)
				break
			}
		}
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
