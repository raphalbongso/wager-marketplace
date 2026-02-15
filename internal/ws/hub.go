package ws

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// Msg is a message sent to clients.
type Msg struct {
	Type     string `json:"type"`
	MarketID string `json:"market_id"`
	Data     any    `json:"data"`
}

// Hub manages per-market WebSocket subscriptions.
type Hub struct {
	mu      sync.RWMutex
	rooms   map[string]map[*conn]bool // marketID -> set of conns
	allConn map[*conn]bool
}

type conn struct {
	ws     *websocket.Conn
	send   chan []byte
	hub    *Hub
	market string
}

func NewHub() *Hub {
	return &Hub{
		rooms:   make(map[string]map[*conn]bool),
		allConn: make(map[*conn]bool),
	}
}

// Publish sends a message to all subscribers of a market.
func (h *Hub) Publish(marketID, msgType string, data any) {
	msg := Msg{Type: msgType, MarketID: marketID, Data: data}
	b, err := json.Marshal(msg)
	if err != nil {
		return
	}
	h.mu.RLock()
	room := h.rooms[marketID]
	h.mu.RUnlock()
	for c := range room {
		select {
		case c.send <- b:
		default:
			// slow client, drop
		}
	}
}

// HandleWS is the HTTP handler for WebSocket connections.
func (h *Hub) HandleWS(w http.ResponseWriter, r *http.Request) {
	wsConn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[ws] upgrade error: %v", err)
		return
	}
	c := &conn{
		ws:   wsConn,
		send: make(chan []byte, 64),
		hub:  h,
	}
	h.mu.Lock()
	h.allConn[c] = true
	h.mu.Unlock()

	go c.writePump()
	go c.readPump()
}

func (c *conn) readPump() {
	defer func() {
		c.hub.removeConn(c)
		c.ws.Close()
	}()
	for {
		_, msg, err := c.ws.ReadMessage()
		if err != nil {
			break
		}
		// Parse subscription message: {"action":"subscribe","market_id":"..."}
		var sub struct {
			Action   string `json:"action"`
			MarketID string `json:"market_id"`
		}
		if err := json.Unmarshal(msg, &sub); err != nil {
			continue
		}
		switch sub.Action {
		case "subscribe":
			c.hub.subscribe(c, sub.MarketID)
		case "unsubscribe":
			c.hub.unsubscribe(c, sub.MarketID)
		}
	}
}

func (c *conn) writePump() {
	defer c.ws.Close()
	for msg := range c.send {
		if err := c.ws.WriteMessage(websocket.TextMessage, msg); err != nil {
			break
		}
	}
}

func (h *Hub) subscribe(c *conn, marketID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	// Unsubscribe from previous market if any
	if c.market != "" {
		if room, ok := h.rooms[c.market]; ok {
			delete(room, c)
			if len(room) == 0 {
				delete(h.rooms, c.market)
			}
		}
	}
	c.market = marketID
	room, ok := h.rooms[marketID]
	if !ok {
		room = make(map[*conn]bool)
		h.rooms[marketID] = room
	}
	room[c] = true
}

func (h *Hub) unsubscribe(c *conn, marketID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if room, ok := h.rooms[marketID]; ok {
		delete(room, c)
		if len(room) == 0 {
			delete(h.rooms, marketID)
		}
	}
	if c.market == marketID {
		c.market = ""
	}
}

func (h *Hub) removeConn(c *conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.allConn, c)
	if c.market != "" {
		if room, ok := h.rooms[c.market]; ok {
			delete(room, c)
			if len(room) == 0 {
				delete(h.rooms, c.market)
			}
		}
	}
	close(c.send)
}
