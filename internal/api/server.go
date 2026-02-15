package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"

	"wager-exchange/internal/db"
	"wager-exchange/internal/engine"
	"wager-exchange/internal/model"
	"wager-exchange/internal/ws"
)

type Server struct {
	store   *db.Store
	manager *engine.Manager
	hub     *ws.Hub
	secret  []byte
	feeBps  int
}

func NewServer(store *db.Store, mgr *engine.Manager, hub *ws.Hub, secret string, feeBps int) *Server {
	return &Server{store: store, manager: mgr, hub: hub, secret: []byte(secret), feeBps: feeBps}
}

func (s *Server) Router() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(30 * time.Second))
	r.Use(corsMiddleware)

	// Health
	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		json200(w, map[string]string{"status": "ok"})
	})

	// Auth (public)
	r.Post("/api/register", s.register)
	r.Post("/api/login", s.login)

	// WebSocket
	r.Get("/ws", s.hub.HandleWS)

	// Protected routes
	r.Group(func(r chi.Router) {
		r.Use(s.authMiddleware)

		// Wallet
		r.Get("/api/wallet", s.getWallet)

		// Markets
		r.Get("/api/markets", s.listMarkets)
		r.Get("/api/markets/{id}", s.getMarket)
		r.Get("/api/markets/{id}/book", s.getBook)
		r.Get("/api/markets/{id}/trades", s.getTrades)

		// Orders
		r.Post("/api/markets/{id}/orders", s.placeOrder)
		r.Delete("/api/orders/{id}", s.cancelOrder)
		r.Get("/api/markets/{id}/orders", s.listOrders)

		// Positions
		r.Get("/api/markets/{id}/positions", s.listPositions)

		// Anchor bets
		r.Post("/api/anchor-bets", s.createAnchorBet)
		r.Get("/api/anchor-bets", s.listAnchorBets)
		r.Get("/api/anchor-bets/{id}", s.getAnchorBet)
		r.Post("/api/anchor-bets/{id}/side-bets", s.createSideBet)

		// Admin
		r.Group(func(r chi.Router) {
			r.Use(s.adminOnly)
			r.Post("/api/admin/markets", s.createMarket)
			r.Post("/api/admin/markets/{id}/resolve", s.resolveMarket)
			r.Post("/api/admin/deposit", s.adminDeposit)
			r.Get("/api/admin/users", s.listUsers)
			r.Get("/api/admin/events", s.listEvents)
			r.Get("/api/admin/metrics", s.metrics)
		})
	})

	// Static files - serve index.html directly at root
	r.Get("/", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "web/index.html")
	})
	r.Get("/app.js", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "web/app.js")
	})
	r.Handle("/web/*", http.StripPrefix("/web/", http.FileServer(http.Dir("web"))))

	return r
}

// ── Auth ─────────────────────────────────────────────

func (s *Server) register(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, 400, "invalid json")
		return
	}
	if req.Email == "" || len(req.Password) < 6 {
		jsonErr(w, 400, "email and password (min 6 chars) required")
		return
	}

	existing, _ := s.store.GetUserByEmail(r.Context(), req.Email)
	if existing != nil {
		jsonErr(w, 409, "email already registered")
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		jsonErr(w, 500, "hash failed")
		return
	}

	user, err := s.store.CreateUser(r.Context(), req.Email, string(hash), model.RoleUser)
	if err != nil {
		jsonErr(w, 500, "create user failed: "+err.Error())
		return
	}
	if err := s.store.CreateWallet(r.Context(), user.ID); err != nil {
		jsonErr(w, 500, "create wallet failed")
		return
	}

	token := s.makeToken(user.ID, user.Role)
	json200(w, map[string]any{"user": user, "token": token})
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, 400, "invalid json")
		return
	}

	user, err := s.store.GetUserByEmail(r.Context(), req.Email)
	if err != nil || user == nil {
		jsonErr(w, 401, "invalid credentials")
		return
	}
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.Password)); err != nil {
		jsonErr(w, 401, "invalid credentials")
		return
	}

	token := s.makeToken(user.ID, user.Role)
	json200(w, map[string]any{"user": user, "token": token})
}

func (s *Server) makeToken(userID string, role model.Role) string {
	claims := jwt.MapClaims{
		"sub":  userID,
		"role": string(role),
		"exp":  time.Now().Add(72 * time.Hour).Unix(),
	}
	t, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.secret)
	return t
}

// ── Middleware ────────────────────────────────────────

type ctxKey string

const (
	ctxUserID ctxKey = "userID"
	ctxRole   ctxKey = "role"
)

func (s *Server) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "Bearer ") {
			jsonErr(w, 401, "missing token")
			return
		}
		tokenStr := strings.TrimPrefix(auth, "Bearer ")
		token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (any, error) {
			if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, fmt.Errorf("unexpected signing method")
			}
			return s.secret, nil
		})
		if err != nil || !token.Valid {
			jsonErr(w, 401, "invalid token")
			return
		}
		claims, ok := token.Claims.(jwt.MapClaims)
		if !ok {
			jsonErr(w, 401, "invalid claims")
			return
		}
		userID, _ := claims["sub"].(string)
		role, _ := claims["role"].(string)
		ctx := context.WithValue(r.Context(), ctxUserID, userID)
		ctx = context.WithValue(ctx, ctxRole, role)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (s *Server) adminOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		role, _ := r.Context().Value(ctxRole).(string)
		if role != string(model.RoleAdmin) {
			jsonErr(w, 403, "admin only")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type,Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(204)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ── Wallet ───────────────────────────────────────────

func (s *Server) getWallet(w http.ResponseWriter, r *http.Request) {
	uid := r.Context().Value(ctxUserID).(string)
	wallet, err := s.store.GetWallet(r.Context(), uid)
	if err != nil || wallet == nil {
		jsonErr(w, 404, "wallet not found")
		return
	}
	json200(w, wallet)
}

// ── Markets ──────────────────────────────────────────

func (s *Server) listMarkets(w http.ResponseWriter, r *http.Request) {
	markets, err := s.store.ListMarkets(r.Context())
	if err != nil {
		jsonErr(w, 500, err.Error())
		return
	}
	if markets == nil {
		markets = []model.Market{}
	}
	json200(w, markets)
}

func (s *Server) getMarket(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	mkt, err := s.store.GetMarket(r.Context(), id)
	if err != nil || mkt == nil {
		jsonErr(w, 404, "market not found")
		return
	}
	json200(w, mkt)
}

func (s *Server) getBook(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	bids, asks := s.manager.GetBook(id)
	json200(w, model.BookSnapshot{Bids: toModelLevels(bids), Asks: toModelLevels(asks)})
}

func (s *Server) getTrades(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	limitStr := r.URL.Query().Get("limit")
	limit := 50
	if n, err := strconv.Atoi(limitStr); err == nil && n > 0 && n <= 200 {
		limit = n
	}
	trades, err := s.store.ListTrades(r.Context(), id, limit)
	if err != nil {
		jsonErr(w, 500, err.Error())
		return
	}
	if trades == nil {
		trades = []model.Trade{}
	}
	json200(w, trades)
}

// ── Orders ───────────────────────────────────────────

func (s *Server) placeOrder(w http.ResponseWriter, r *http.Request) {
	marketID := chi.URLParam(r, "id")
	uid := r.Context().Value(ctxUserID).(string)

	var req model.PlaceOrderReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, 400, "invalid json")
		return
	}

	// Validate basic fields
	if req.Side != model.SideBuy && req.Side != model.SideSell {
		jsonErr(w, 400, "side must be BUY or SELL")
		return
	}
	if req.Type != model.TypeLimit && req.Type != model.TypeMarket {
		jsonErr(w, 400, "type must be LIMIT or MARKET")
		return
	}
	if req.Type == model.TypeLimit && (req.PriceCents == nil || *req.PriceCents < 1 || *req.PriceCents > 99) {
		jsonErr(w, 400, "limit price must be 1-99")
		return
	}
	if req.Qty < 1 {
		jsonErr(w, 400, "qty must be >= 1")
		return
	}

	// Check market exists & is open
	mkt, err := s.store.GetMarket(r.Context(), marketID)
	if err != nil || mkt == nil {
		jsonErr(w, 404, "market not found")
		return
	}
	if mkt.Status != model.MarketOpen {
		jsonErr(w, 400, "market not open")
		return
	}

	eng := s.manager.GetEngine(marketID)
	if eng == nil {
		jsonErr(w, 500, "engine not running")
		return
	}

	result := eng.PlaceOrder(uid, req)
	if result.Status == model.StatusRejected {
		jsonErr(w, 400, result.Reason)
		return
	}
	json200(w, result)
}

func (s *Server) cancelOrder(w http.ResponseWriter, r *http.Request) {
	orderID := chi.URLParam(r, "id")
	uid := r.Context().Value(ctxUserID).(string)

	// Get order to find market
	order, err := s.store.GetOrder(r.Context(), orderID)
	if err != nil || order == nil {
		jsonErr(w, 404, "order not found")
		return
	}
	if order.UserID != uid {
		jsonErr(w, 403, "not your order")
		return
	}

	eng := s.manager.GetEngine(order.MarketID)
	if eng == nil {
		jsonErr(w, 500, "engine not running")
		return
	}

	if err := eng.CancelOrder(orderID, uid); err != nil {
		jsonErr(w, 400, err.Error())
		return
	}
	json200(w, map[string]string{"status": "canceled"})
}

func (s *Server) listOrders(w http.ResponseWriter, r *http.Request) {
	marketID := chi.URLParam(r, "id")
	uid := r.Context().Value(ctxUserID).(string)
	orders, err := s.store.GetUserOrders(r.Context(), marketID, uid)
	if err != nil {
		jsonErr(w, 500, err.Error())
		return
	}
	if orders == nil {
		orders = []model.Order{}
	}
	json200(w, orders)
}

// ── Positions ────────────────────────────────────────

func (s *Server) listPositions(w http.ResponseWriter, r *http.Request) {
	marketID := chi.URLParam(r, "id")
	positions, err := s.store.ListPositions(r.Context(), marketID)
	if err != nil {
		jsonErr(w, 500, err.Error())
		return
	}
	if positions == nil {
		positions = []model.Position{}
	}
	json200(w, positions)
}

// ── Anchor Bets ──────────────────────────────────────

func (s *Server) createAnchorBet(w http.ResponseWriter, r *http.Request) {
	uid := r.Context().Value(ctxUserID).(string)
	var req struct {
		Title      string  `json:"title"`
		RulesText  string  `json:"rules_text"`
		OpponentID *string `json:"opponent_user_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, 400, "invalid json")
		return
	}
	if req.Title == "" || req.RulesText == "" {
		jsonErr(w, 400, "title and rules_text required")
		return
	}
	ab, err := s.store.CreateAnchorBet(r.Context(), uid, req.Title, req.RulesText, req.OpponentID, nil)
	if err != nil {
		jsonErr(w, 500, err.Error())
		return
	}
	w.WriteHeader(201)
	json.NewEncoder(w).Encode(ab)
}

func (s *Server) listAnchorBets(w http.ResponseWriter, r *http.Request) {
	bets, err := s.store.ListAnchorBets(r.Context())
	if err != nil {
		jsonErr(w, 500, err.Error())
		return
	}
	if bets == nil {
		bets = []model.AnchorBet{}
	}
	json200(w, bets)
}

func (s *Server) getAnchorBet(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	ab, err := s.store.GetAnchorBet(r.Context(), id)
	if err != nil || ab == nil {
		jsonErr(w, 404, "anchor bet not found")
		return
	}
	json200(w, ab)
}

func (s *Server) createSideBet(w http.ResponseWriter, r *http.Request) {
	uid := r.Context().Value(ctxUserID).(string)
	anchorID := chi.URLParam(r, "id")
	var req struct {
		Direction   string `json:"direction"`
		AmountCents int64  `json:"amount_cents"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, 400, "invalid json")
		return
	}
	if req.Direction != "FOR" && req.Direction != "AGAINST" {
		jsonErr(w, 400, "direction must be FOR or AGAINST")
		return
	}
	if req.AmountCents <= 0 {
		jsonErr(w, 400, "amount_cents must be > 0")
		return
	}
	sb, err := s.store.CreateSideBet(r.Context(), anchorID, uid, req.Direction, req.AmountCents)
	if err != nil {
		jsonErr(w, 500, err.Error())
		return
	}
	w.WriteHeader(201)
	json.NewEncoder(w).Encode(sb)
}

// ── Admin ────────────────────────────────────────────

func (s *Server) createMarket(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Slug        string `json:"slug"`
		Title       string `json:"title"`
		Description string `json:"description"`
		TickSize    int    `json:"tick_size_cents"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, 400, "invalid json")
		return
	}
	if req.Slug == "" || req.Title == "" {
		jsonErr(w, 400, "slug and title required")
		return
	}
	if req.TickSize <= 0 {
		req.TickSize = 1
	}

	mkt, err := s.store.CreateMarket(r.Context(), req.Slug, req.Title, req.Description, req.TickSize)
	if err != nil {
		jsonErr(w, 500, err.Error())
		return
	}

	// Start engine for this market
	if err := s.manager.StartEngine(r.Context(), mkt.ID); err != nil {
		log.Printf("[api] failed to start engine for %s: %v", mkt.ID, err)
	}

	w.WriteHeader(201)
	json.NewEncoder(w).Encode(mkt)
}

func (s *Server) resolveMarket(w http.ResponseWriter, r *http.Request) {
	marketID := chi.URLParam(r, "id")
	adminID := r.Context().Value(ctxUserID).(string)

	var req struct {
		ResolvesTo string `json:"resolves_to"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, 400, "invalid json")
		return
	}
	if req.ResolvesTo != "YES" && req.ResolvesTo != "NO" {
		jsonErr(w, 400, "resolves_to must be YES or NO")
		return
	}

	eng := s.manager.GetEngine(marketID)
	if eng == nil {
		jsonErr(w, 404, "engine not running for this market")
		return
	}

	if err := eng.ResolveMarket(req.ResolvesTo, adminID); err != nil {
		jsonErr(w, 500, err.Error())
		return
	}
	json200(w, map[string]string{"status": "resolved", "resolves_to": req.ResolvesTo})
}

func (s *Server) adminDeposit(w http.ResponseWriter, r *http.Request) {
	var req struct {
		UserID string `json:"user_id"`
		Cents  int64  `json:"cents"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, 400, "invalid json")
		return
	}
	if req.UserID == "" || req.Cents <= 0 {
		jsonErr(w, 400, "user_id and cents > 0 required")
		return
	}
	wallet, err := s.store.DepositWallet(r.Context(), req.UserID, req.Cents)
	if err != nil {
		jsonErr(w, 500, err.Error())
		return
	}
	json200(w, wallet)
}

func (s *Server) listUsers(w http.ResponseWriter, r *http.Request) {
	users, err := s.store.GetWalletUsers(r.Context())
	if err != nil {
		jsonErr(w, 500, err.Error())
		return
	}
	type userRow struct {
		ID           string    `json:"id"`
		Email        string    `json:"email"`
		Role         string    `json:"role"`
		CreatedAt    time.Time `json:"created_at"`
		BalanceCents int64     `json:"balance_cents"`
		LockedCents  int64     `json:"locked_cents"`
	}
	out := make([]userRow, len(users))
	for i, u := range users {
		out[i] = userRow{
			ID: u.User.ID, Email: u.User.Email, Role: string(u.User.Role),
			CreatedAt: u.User.CreatedAt, BalanceCents: u.Wallet.BalanceCents, LockedCents: u.Wallet.LockedCents,
		}
	}
	json200(w, out)
}

func (s *Server) listEvents(w http.ResponseWriter, r *http.Request) {
	limitStr := r.URL.Query().Get("limit")
	limit := 100
	if n, err := strconv.Atoi(limitStr); err == nil && n > 0 && n <= 500 {
		limit = n
	}
	marketID := r.URL.Query().Get("market_id")
	var mp *string
	if marketID != "" {
		mp = &marketID
	}
	events, err := s.store.ListEvents(r.Context(), mp, limit)
	if err != nil {
		jsonErr(w, 500, err.Error())
		return
	}
	if events == nil {
		events = []model.EventLog{}
	}
	json200(w, events)
}

func (s *Server) metrics(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	markets, _ := s.store.ListMarkets(ctx)
	users, _ := s.store.ListUsers(ctx)
	fee, _ := s.store.GetPlatformFee(ctx)

	openMarkets := 0
	for _, m := range markets {
		if m.Status == model.MarketOpen {
			openMarkets++
		}
	}

	json200(w, map[string]any{
		"total_markets":      len(markets),
		"open_markets":       openMarkets,
		"total_users":        len(users),
		"platform_fee_cents": fee,
	})
}

// ── Helpers ──────────────────────────────────────────

func json200(w http.ResponseWriter, data any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}

func jsonErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func toModelLevels(levels []engine.BookLevel) []model.BookLevel {
	out := make([]model.BookLevel, len(levels))
	for i, l := range levels {
		out[i] = model.BookLevel{Price: l.Price, Qty: l.Qty}
	}
	return out
}
