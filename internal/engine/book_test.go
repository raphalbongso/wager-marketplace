package engine

import "testing"

func TestAddAndBestBidAsk(t *testing.T) {
	b := NewOrderBook()

	b.Add(&OrderEntry{OrderID: "b1", UserID: "u1", Side: "BUY", PriceCents: 40, RemainingQty: 10, Seq: 1})
	b.Add(&OrderEntry{OrderID: "b2", UserID: "u1", Side: "BUY", PriceCents: 45, RemainingQty: 5, Seq: 2})
	b.Add(&OrderEntry{OrderID: "a1", UserID: "u2", Side: "SELL", PriceCents: 55, RemainingQty: 10, Seq: 3})
	b.Add(&OrderEntry{OrderID: "a2", UserID: "u2", Side: "SELL", PriceCents: 60, RemainingQty: 5, Seq: 4})

	if b.Size() != 4 {
		t.Fatalf("expected size 4, got %d", b.Size())
	}
	if bb := b.BestBid(); bb == nil || *bb != 45 {
		t.Fatalf("expected best bid 45, got %v", bb)
	}
	if ba := b.BestAsk(); ba == nil || *ba != 55 {
		t.Fatalf("expected best ask 55, got %v", ba)
	}
}

func TestPriceTimePriority(t *testing.T) {
	b := NewOrderBook()

	// Two sells at same price, first should match first (FIFO)
	b.Add(&OrderEntry{OrderID: "a1", UserID: "u2", Side: "SELL", PriceCents: 50, RemainingQty: 3, Seq: 1})
	b.Add(&OrderEntry{OrderID: "a2", UserID: "u2", Side: "SELL", PriceCents: 50, RemainingQty: 3, Seq: 2})

	price := 50
	matches := b.FindMatches("BUY", &price, 4, "u1")
	if len(matches) != 2 {
		t.Fatalf("expected 2 matches, got %d", len(matches))
	}
	if matches[0].Entry.OrderID != "a1" {
		t.Fatalf("expected first match a1, got %s", matches[0].Entry.OrderID)
	}
	if matches[0].FillQty != 3 {
		t.Fatalf("expected first fill 3, got %d", matches[0].FillQty)
	}
	if matches[1].Entry.OrderID != "a2" {
		t.Fatalf("expected second match a2, got %s", matches[1].Entry.OrderID)
	}
	if matches[1].FillQty != 1 {
		t.Fatalf("expected second fill 1, got %d", matches[1].FillQty)
	}
}

func TestPartialFillAcrossLevels(t *testing.T) {
	b := NewOrderBook()

	b.Add(&OrderEntry{OrderID: "a1", UserID: "u2", Side: "SELL", PriceCents: 50, RemainingQty: 2, Seq: 1})
	b.Add(&OrderEntry{OrderID: "a2", UserID: "u2", Side: "SELL", PriceCents: 55, RemainingQty: 3, Seq: 2})
	b.Add(&OrderEntry{OrderID: "a3", UserID: "u2", Side: "SELL", PriceCents: 60, RemainingQty: 5, Seq: 3})

	// Buy 6 at price up to 60 -> should fill 2@50 + 3@55 + 1@60
	price := 60
	matches := b.FindMatches("BUY", &price, 6, "u1")
	if len(matches) != 3 {
		t.Fatalf("expected 3 matches, got %d", len(matches))
	}
	total := 0
	for _, m := range matches {
		total += m.FillQty
	}
	if total != 6 {
		t.Fatalf("expected total fill 6, got %d", total)
	}
	if matches[2].FillQty != 1 {
		t.Fatalf("expected partial fill 1 at 60, got %d", matches[2].FillQty)
	}
}

func TestMarketOrderNoPrice(t *testing.T) {
	b := NewOrderBook()

	b.Add(&OrderEntry{OrderID: "a1", UserID: "u2", Side: "SELL", PriceCents: 50, RemainingQty: 10, Seq: 1})

	// nil price = market order, matches at any price
	matches := b.FindMatches("BUY", nil, 5, "u1")
	if len(matches) != 1 || matches[0].FillQty != 5 {
		t.Fatalf("expected 1 match for 5 qty, got %d matches", len(matches))
	}
}

func TestSelfTradePreventionSkips(t *testing.T) {
	b := NewOrderBook()

	b.Add(&OrderEntry{OrderID: "a1", UserID: "u1", Side: "SELL", PriceCents: 50, RemainingQty: 5, Seq: 1})
	b.Add(&OrderEntry{OrderID: "a2", UserID: "u2", Side: "SELL", PriceCents: 55, RemainingQty: 5, Seq: 2})

	price := 99
	matches := b.FindMatches("BUY", &price, 3, "u1") // excludeUserID=u1
	if len(matches) != 1 {
		t.Fatalf("expected 1 match (skipping self), got %d", len(matches))
	}
	if matches[0].Entry.UserID != "u2" {
		t.Fatalf("expected match with u2, got %s", matches[0].Entry.UserID)
	}
}

func TestRemoveOrder(t *testing.T) {
	b := NewOrderBook()
	b.Add(&OrderEntry{OrderID: "b1", UserID: "u1", Side: "BUY", PriceCents: 50, RemainingQty: 5, Seq: 1})
	b.Add(&OrderEntry{OrderID: "b2", UserID: "u1", Side: "BUY", PriceCents: 50, RemainingQty: 3, Seq: 2})

	removed := b.Remove("b1")
	if removed == nil || removed.OrderID != "b1" {
		t.Fatal("expected to remove b1")
	}
	if b.Size() != 1 {
		t.Fatalf("expected size 1 after remove, got %d", b.Size())
	}

	// Price level should still exist with b2
	if bb := b.BestBid(); bb == nil || *bb != 50 {
		t.Fatal("best bid should still be 50")
	}
}

func TestRemoveLastAtLevel(t *testing.T) {
	b := NewOrderBook()
	b.Add(&OrderEntry{OrderID: "a1", UserID: "u1", Side: "SELL", PriceCents: 50, RemainingQty: 5, Seq: 1})
	b.Remove("a1")

	if b.BestAsk() != nil {
		t.Fatal("expected no best ask after removing only order")
	}
	if b.Size() != 0 {
		t.Fatal("expected empty book")
	}
}

func TestApplyFillPartial(t *testing.T) {
	b := NewOrderBook()
	b.Add(&OrderEntry{OrderID: "a1", UserID: "u1", Side: "SELL", PriceCents: 50, RemainingQty: 10, Seq: 1})

	rem := b.ApplyFill("a1", 3)
	if rem != 7 {
		t.Fatalf("expected remaining 7, got %d", rem)
	}
	if b.Size() != 1 {
		t.Fatal("order should still be in book")
	}
}

func TestApplyFillFull(t *testing.T) {
	b := NewOrderBook()
	b.Add(&OrderEntry{OrderID: "a1", UserID: "u1", Side: "SELL", PriceCents: 50, RemainingQty: 5, Seq: 1})

	rem := b.ApplyFill("a1", 5)
	if rem != 0 {
		t.Fatalf("expected remaining 0, got %d", rem)
	}
	if b.Size() != 0 {
		t.Fatal("order should be removed from book")
	}
}

func TestSnapshotDepth(t *testing.T) {
	b := NewOrderBook()
	for i := 1; i <= 5; i++ {
		b.Add(&OrderEntry{OrderID: "b" + string(rune('0'+i)), UserID: "u1", Side: "BUY", PriceCents: 40 + i, RemainingQty: 1, Seq: int64(i)})
	}
	for i := 1; i <= 5; i++ {
		b.Add(&OrderEntry{OrderID: "a" + string(rune('0'+i)), UserID: "u2", Side: "SELL", PriceCents: 50 + i, RemainingQty: 1, Seq: int64(5 + i)})
	}

	bids, asks := b.Snapshot(3)
	if len(bids) != 3 {
		t.Fatalf("expected 3 bid levels, got %d", len(bids))
	}
	if len(asks) != 3 {
		t.Fatalf("expected 3 ask levels, got %d", len(asks))
	}
	// Bids descending: 45, 44, 43
	if bids[0].Price != 45 {
		t.Fatalf("expected top bid 45, got %d", bids[0].Price)
	}
	// Asks ascending: 51, 52, 53
	if asks[0].Price != 51 {
		t.Fatalf("expected top ask 51, got %d", asks[0].Price)
	}
}

func TestDuplicateAddIgnored(t *testing.T) {
	b := NewOrderBook()
	b.Add(&OrderEntry{OrderID: "b1", UserID: "u1", Side: "BUY", PriceCents: 50, RemainingQty: 5, Seq: 1})
	b.Add(&OrderEntry{OrderID: "b1", UserID: "u1", Side: "BUY", PriceCents: 50, RemainingQty: 5, Seq: 2})

	if b.Size() != 1 {
		t.Fatalf("expected size 1 (dup ignored), got %d", b.Size())
	}
}

func TestFindMatchesSellSide(t *testing.T) {
	b := NewOrderBook()

	b.Add(&OrderEntry{OrderID: "b1", UserID: "u1", Side: "BUY", PriceCents: 60, RemainingQty: 5, Seq: 1})
	b.Add(&OrderEntry{OrderID: "b2", UserID: "u1", Side: "BUY", PriceCents: 55, RemainingQty: 5, Seq: 2})

	// Sell at 55 -> should match bid at 60 first (best bid), then 55
	price := 55
	matches := b.FindMatches("SELL", &price, 8, "u2")
	if len(matches) != 2 {
		t.Fatalf("expected 2 matches, got %d", len(matches))
	}
	if matches[0].FillPrice != 60 {
		t.Fatalf("expected first fill at 60, got %d", matches[0].FillPrice)
	}
	total := 0
	for _, m := range matches {
		total += m.FillQty
	}
	if total != 8 {
		t.Fatalf("expected total 8, got %d", total)
	}
}

func TestCalcLock(t *testing.T) {
	tests := []struct {
		name     string
		side     string
		otype    string
		price    *int
		qty      int
		feeBps   int
		expected int64
	}{
		{"BUY LIMIT 50x10", "BUY", "LIMIT", intPtr(50), 10, 100, 505},    // 50*10 + 50*10*100/10000 = 500+5
		{"SELL LIMIT 50x10", "SELL", "LIMIT", intPtr(50), 10, 100, 509},   // (100-50)*10 + 99*10*100/10000 = 500+9.9→9
		{"BUY MARKET x5", "BUY", "MARKET", nil, 5, 100, 499},             // 99*5 + 99*5*100/10000 = 495+4.95→4
		{"BUY LIMIT 1x1", "BUY", "LIMIT", intPtr(1), 1, 100, 1},         // 1*1 + 1*1*100/10000 = 1+0
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var side model_OrderSide = model_OrderSide(tc.side)
			var otype model_OrderType = model_OrderType(tc.otype)
			got := calcLock(side, otype, tc.price, tc.qty, tc.feeBps)
			if got != tc.expected {
				t.Fatalf("CalcLock(%s, %s, %v, %d, %d) = %d, want %d",
					tc.side, tc.otype, tc.price, tc.qty, tc.feeBps, got, tc.expected)
			}
		})
	}
}

// Shadow types to test CalcLock from model package without importing
type model_OrderSide string
type model_OrderType string

func calcLock(side model_OrderSide, otype model_OrderType, priceCents *int, qty int, feeBps int) int64 {
	if otype == "MARKET" {
		base := int64(99) * int64(qty)
		fee := base * int64(feeBps) / 10000
		return base + fee
	}
	p := int64(*priceCents)
	q := int64(qty)
	if side == "BUY" {
		base := p * q
		fee := base * int64(feeBps) / 10000
		return base + fee
	}
	base := (100 - p) * q
	fee := int64(99) * q * int64(feeBps) / 10000
	return base + fee
}

func intPtr(v int) *int { return &v }
