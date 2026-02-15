/* global fetch, WebSocket, localStorage, document, window, location */
const API = location.origin;
let token = localStorage.getItem("token");
let currentUser = JSON.parse(localStorage.getItem("user") || "null");
let currentMarketId = null;
let currentSide = "BUY";
let currentOrderFilter = "ALL";
let currentMarketFilter = "ALL";
let allMarkets = [];
let allOrders = [];
let ws = null;
let wsReconnectTimer = null;

// ── DOM Helpers ──────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function el(tag, attrs, ...children) {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "html") e.innerHTML = v; // only for trusted static markup
      else e.setAttribute(k, v);
    }
  }
  for (const c of children) {
    if (typeof c === "string") e.appendChild(document.createTextNode(c));
    else if (c) e.appendChild(c);
  }
  return e;
}

function clearChildren(node) { while (node.firstChild) node.removeChild(node.firstChild); }

// ── API ──────────────────────────────────────────────────────

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, { ...opts, headers });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data;
}

// ── Toast ────────────────────────────────────────────────────

function showToast(msg, type = "success") {
  const t = $("toast");
  const inner = $("toast-inner");
  inner.textContent = msg;
  const borderColor = type === "error" ? "border-red-500" : "border-yes";
  inner.className = `px-5 py-3 rounded-xl bg-surface border shadow-lg text-sm font-medium ${borderColor}`;
  t.classList.remove("hidden");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), 3000);
}

// ── Utilities ────────────────────────────────────────────────

function centsToPrice(c) { return (c / 100).toFixed(2); }

function timeAgo(d) {
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

function statusBadge(status) {
  const map = {
    OPEN: "bg-yes/20 text-yes",
    PARTIAL: "bg-yellow-500/20 text-yellow-400",
    FILLED: "bg-accent/20 text-accent",
    CANCELED: "bg-gray-500/20 text-gray-400",
    CANCELLED: "bg-gray-500/20 text-gray-400",
    REJECTED: "bg-red-500/20 text-red-400",
    RESOLVED: "bg-muted/20 text-muted",
    PROMOTED: "bg-accent/20 text-accent",
  };
  return el("span", { class: `inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold ${map[status] || "bg-surface text-muted"}` }, status);
}

function computeProbability(book) {
  const bestBid = book.bids && book.bids.length > 0 ? book.bids[0].priceCents : null;
  const bestAsk = book.asks && book.asks.length > 0 ? book.asks[0].priceCents : null;
  if (bestBid !== null && bestAsk !== null) return Math.round((bestBid + bestAsk) / 2);
  if (bestBid !== null) return bestBid;
  if (bestAsk !== null) return bestAsk;
  return null;
}

// ── Auth ─────────────────────────────────────────────────────

let authMode = "login";

function setAuthTab(mode) {
  authMode = mode;
  $("auth-tab-login").className = `flex-1 pb-3 text-sm font-semibold ${mode === "login" ? "tab-active" : "tab-inactive"}`;
  $("auth-tab-register").className = `flex-1 pb-3 text-sm font-semibold ${mode === "register" ? "tab-active" : "tab-inactive"}`;
  $("auth-submit-btn").textContent = mode === "login" ? "Log In" : "Create Account";
}

async function doAuth() {
  const endpoint = authMode === "login" ? "/auth/login" : "/auth/register";
  try {
    const data = await api(endpoint, {
      method: "POST",
      body: JSON.stringify({ email: $("auth-email").value, password: $("auth-pass").value }),
    });
    token = data.token;
    currentUser = data.user;
    localStorage.setItem("token", token);
    localStorage.setItem("user", JSON.stringify(currentUser));
    updateAuthUI();
    showToast(authMode === "login" ? "Logged in" : "Account created");
  } catch (e) { showToast(e.message, "error"); }
}

function logout() {
  token = null;
  currentUser = null;
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  if (ws) { ws.close(); ws = null; }
  clearTimeout(wsReconnectTimer);
  updateAuthUI();
}

function updateAuthUI() {
  const pages = ["page-auth", "page-markets", "page-market-detail", "page-portfolio", "page-anchor-bets", "page-admin"];
  pages.forEach(p => $(p).classList.add("hidden"));

  if (token && currentUser) {
    $("page-auth").classList.add("hidden");
    $("nav-links").classList.remove("hidden");
    $("nav-links").classList.add("sm:flex");
    $("user-email").textContent = currentUser.email;
    $("user-email").classList.remove("hidden");
    $("logout-btn").classList.remove("hidden");
    $("wallet-badge").classList.remove("hidden");
    if (currentUser.role === "ADMIN") $("nav-admin").classList.remove("hidden");
    else $("nav-admin").classList.add("hidden");
    showPage("markets");
  } else {
    $("page-auth").classList.remove("hidden");
    $("nav-links").classList.add("hidden");
    $("user-email").classList.add("hidden");
    $("logout-btn").classList.add("hidden");
    $("wallet-badge").classList.add("hidden");
  }
}

// ── Navigation ───────────────────────────────────────────────

function showPage(page) {
  const pages = ["page-markets", "page-market-detail", "page-portfolio", "page-anchor-bets", "page-admin"];
  pages.forEach(p => $(p).classList.add("hidden"));

  const navIds = ["nav-markets", "nav-portfolio", "nav-anchor-bets", "nav-admin"];
  navIds.forEach(n => {
    const el = $(n);
    el.classList.remove("bg-surface", "text-white");
    el.classList.add("text-gray-400");
  });

  // Close WS when leaving market detail
  if (page !== "market-detail" && ws) {
    ws.close();
    ws = null;
    clearTimeout(wsReconnectTimer);
  }

  if (page === "markets") {
    $("page-markets").classList.remove("hidden");
    $("nav-markets").classList.add("bg-surface", "text-white");
    $("nav-markets").classList.remove("text-gray-400");
    loadMarkets();
    loadWallet();
  } else if (page === "market-detail") {
    $("page-market-detail").classList.remove("hidden");
    loadMarketDetail();
  } else if (page === "portfolio") {
    $("page-portfolio").classList.remove("hidden");
    $("nav-portfolio").classList.add("bg-surface", "text-white");
    $("nav-portfolio").classList.remove("text-gray-400");
    loadPortfolio();
    loadWallet();
  } else if (page === "anchor-bets") {
    $("page-anchor-bets").classList.remove("hidden");
    $("nav-anchor-bets").classList.add("bg-surface", "text-white");
    $("nav-anchor-bets").classList.remove("text-gray-400");
    loadAnchorBets();
  } else if (page === "admin") {
    $("page-admin").classList.remove("hidden");
    $("nav-admin").classList.add("bg-surface", "text-white");
    $("nav-admin").classList.remove("text-gray-400");
    loadAdmin();
  }
}

// ── Wallet ───────────────────────────────────────────────────

async function loadWallet() {
  try {
    const w = await api("/wallet");
    $("wallet-amount").textContent = `$${centsToPrice(w.availableCents)}`;
  } catch {}
}

// ── Markets Page ─────────────────────────────────────────────

async function loadMarkets() {
  try {
    allMarkets = await api("/markets");
    renderMarkets();
  } catch (e) { showToast(e.message, "error"); }
}

function filterMarkets(filter) {
  currentMarketFilter = filter;
  const filters = { ALL: "filter-all", OPEN: "filter-open", RESOLVED: "filter-resolved" };
  for (const [key, id] of Object.entries(filters)) {
    const btn = $(id);
    if (key === filter) {
      btn.className = "text-xs font-semibold px-3 py-1.5 rounded-full bg-accent text-white transition";
    } else {
      btn.className = "text-xs font-semibold px-3 py-1.5 rounded-full bg-surface text-muted border border-border hover:text-white transition";
    }
  }
  renderMarkets();
}

function renderMarkets() {
  const grid = $("markets-grid");
  clearChildren(grid);

  const filtered = currentMarketFilter === "ALL" ? allMarkets : allMarkets.filter(m => m.status === currentMarketFilter);

  if (filtered.length === 0) {
    grid.appendChild(el("div", { class: "col-span-full text-center text-muted py-12" }, "No markets found"));
    return;
  }

  for (const m of filtered) {
    const prob = m.book ? computeProbability(m.book) : null;
    const probText = prob !== null ? prob + "%" : "—";
    const probColor = prob !== null ? (prob >= 50 ? "text-yes" : "text-no") : "text-muted";

    const card = el("div", { class: "bg-surface border border-border rounded-2xl p-5 cursor-pointer hover:border-accent/50 transition group animate-fade" },
      el("div", { class: "flex items-start justify-between mb-3" },
        statusBadge(m.status + (m.resolvesTo ? " \u2192 " + m.resolvesTo : "")),
        el("span", { class: `text-2xl font-extrabold ${probColor}` }, probText),
      ),
      el("h3", { class: "text-white font-semibold text-sm mb-1 group-hover:text-accent transition" }, m.title),
      el("p", { class: "text-muted text-xs line-clamp-2" }, m.description || ""),
      el("div", { class: "flex gap-2 mt-4" },
        el("button", { class: "flex-1 text-xs font-semibold py-1.5 rounded-lg bg-yes/10 text-yes hover:bg-yes/20 transition", onclick: (e) => { e.stopPropagation(); openMarket(m.id); } }, "Yes"),
        el("button", { class: "flex-1 text-xs font-semibold py-1.5 rounded-lg bg-no/10 text-no hover:bg-no/20 transition", onclick: (e) => { e.stopPropagation(); openMarket(m.id); } }, "No"),
      ),
    );
    card.addEventListener("click", () => openMarket(m.id));
    grid.appendChild(card);
  }
}

function openMarket(id) {
  currentMarketId = id;
  showPage("market-detail");
}

// ── Market Detail ────────────────────────────────────────────

let currentBook = { bids: [], asks: [] };

async function loadMarketDetail() {
  if (!currentMarketId) return;
  try {
    const m = await api(`/markets/${currentMarketId}`);
    $("market-title").textContent = m.title;

    const badge = $("market-status-badge");
    clearChildren(badge);
    badge.appendChild(statusBadge(m.status + (m.resolvesTo ? " \u2192 " + m.resolvesTo : "")));

    // Show resolve buttons for admin on open markets
    if (currentUser && currentUser.role === "ADMIN" && m.status === "OPEN") {
      $("resolve-buttons").classList.remove("hidden");
    } else {
      $("resolve-buttons").classList.add("hidden");
    }

    currentBook = m.book || { bids: [], asks: [] };
    renderBook(currentBook);
    updateHeroStats(currentBook);
    loadMyOrders();
    loadTrades();
    loadPosition();
    connectWs();
  } catch (e) { showToast(e.message, "error"); }
}

function updateHeroStats(book) {
  const prob = computeProbability(book);
  $("market-probability").textContent = prob !== null ? prob + "%" : "—";
  if (prob !== null) {
    $("market-probability").className = `text-5xl font-extrabold ${prob >= 50 ? "text-yes" : "text-no"}`;
  } else {
    $("market-probability").className = "text-5xl font-extrabold text-muted";
  }

  const bestBid = book.bids && book.bids.length > 0 ? book.bids[0].priceCents : null;
  const bestAsk = book.asks && book.asks.length > 0 ? book.asks[0].priceCents : null;
  $("market-best-bid").textContent = bestBid !== null ? bestBid + "\u00A2" : "—";
  $("market-best-ask").textContent = bestAsk !== null ? bestAsk + "\u00A2" : "—";
  $("market-spread").textContent = bestBid !== null && bestAsk !== null ? (bestAsk - bestBid) + "\u00A2" : "—";
}

function renderBook(book) {
  currentBook = book;
  updateHeroStats(book);

  const bidsEl = $("bids-book");
  const asksEl = $("asks-book");
  clearChildren(bidsEl);
  clearChildren(asksEl);

  const maxBidQty = Math.max(...(book.bids || []).map(l => l.totalQty), 1);
  const maxAskQty = Math.max(...(book.asks || []).map(l => l.totalQty), 1);

  if (!book.bids || book.bids.length === 0) {
    bidsEl.appendChild(el("div", { class: "text-xs text-muted py-2" }, "No bids"));
  } else {
    for (const level of book.bids) {
      const pct = Math.round((level.totalQty / maxBidQty) * 100);
      const row = el("div", { class: "depth-bar flex items-center justify-between px-2 py-1 rounded text-xs", style: `--depth: ${pct}%` },
        el("span", { class: "text-yes font-semibold" }, level.priceCents + "\u00A2"),
        el("span", { class: "text-gray-300" }, String(level.totalQty)),
      );
      row.style.background = `linear-gradient(to left, rgba(39,174,96,0.15) ${pct}%, transparent ${pct}%)`;
      bidsEl.appendChild(row);
    }
  }

  if (!book.asks || book.asks.length === 0) {
    asksEl.appendChild(el("div", { class: "text-xs text-muted py-2" }, "No asks"));
  } else {
    for (const level of book.asks) {
      const pct = Math.round((level.totalQty / maxAskQty) * 100);
      const row = el("div", { class: "depth-bar flex items-center justify-between px-2 py-1 rounded text-xs", style: `--depth: ${pct}%` },
        el("span", { class: "text-no font-semibold" }, level.priceCents + "\u00A2"),
        el("span", { class: "text-gray-300" }, String(level.totalQty)),
      );
      row.style.background = `linear-gradient(to right, rgba(245,90,0,0.15) ${pct}%, transparent ${pct}%)`;
      asksEl.appendChild(row);
    }
  }
}

// ── Trade Panel ──────────────────────────────────────────────

function setSide(side) {
  currentSide = side;
  if (side === "BUY") {
    $("side-buy").className = "flex-1 text-sm font-semibold py-2 rounded-lg bg-yes text-white transition";
    $("side-sell").className = "flex-1 text-sm font-semibold py-2 rounded-lg text-muted transition";
    $("order-submit-btn").className = "w-full bg-yes hover:bg-yes/80 text-white font-semibold py-2.5 rounded-xl transition text-sm";
    $("order-submit-btn").textContent = "Buy YES";
  } else {
    $("side-sell").className = "flex-1 text-sm font-semibold py-2 rounded-lg bg-no text-white transition";
    $("side-buy").className = "flex-1 text-sm font-semibold py-2 rounded-lg text-muted transition";
    $("order-submit-btn").className = "w-full bg-no hover:bg-no/80 text-white font-semibold py-2.5 rounded-xl transition text-sm";
    $("order-submit-btn").textContent = "Sell YES";
  }
  estimateCost();
}

function togglePrice() {
  $("price-group").style.display = $("order-type").value === "MARKET" ? "none" : "";
  estimateCost();
}

function estimateCost() {
  const type = $("order-type").value;
  const qty = parseInt($("order-qty").value) || 0;
  const price = parseInt($("order-price").value) || 0;
  const costEl = $("cost-estimate");

  if (type === "LIMIT" && qty > 0 && price > 0) {
    const totalCents = qty * price;
    costEl.textContent = `Est. cost: $${centsToPrice(totalCents)} (${qty} shares \u00D7 ${price}\u00A2)`;
  } else if (type === "MARKET" && qty > 0) {
    costEl.textContent = `Market order: ${qty} shares at best available price`;
  } else {
    costEl.textContent = "";
  }
}

async function placeOrder() {
  try {
    const body = {
      side: currentSide,
      type: $("order-type").value,
      qty: parseInt($("order-qty").value),
    };
    if (body.type === "LIMIT") body.priceCents = parseInt($("order-price").value);
    await api(`/markets/${currentMarketId}/orders`, { method: "POST", body: JSON.stringify(body) });
    showToast("Order placed");
    loadMarketDetail();
    loadWallet();
  } catch (e) { showToast(e.message, "error"); }
}

async function cancelOrder(orderId) {
  try {
    await api(`/markets/${currentMarketId}/orders/${orderId}/cancel`, { method: "POST" });
    showToast("Order canceled");
    loadMyOrders();
    loadWallet();
  } catch (e) { showToast(e.message, "error"); }
}

// ── Orders ───────────────────────────────────────────────────

async function loadMyOrders() {
  try {
    allOrders = await api(`/markets/${currentMarketId}/orders`);
    renderOrders();
  } catch {}
}

function filterOrders(filter) {
  currentOrderFilter = filter;
  $("orders-filter-all").className = filter === "ALL"
    ? "text-xs px-2.5 py-1 rounded-full bg-accent text-white font-semibold"
    : "text-xs px-2.5 py-1 rounded-full bg-bg text-muted border border-border font-semibold";
  $("orders-filter-open").className = filter === "OPEN"
    ? "text-xs px-2.5 py-1 rounded-full bg-accent text-white font-semibold"
    : "text-xs px-2.5 py-1 rounded-full bg-bg text-muted border border-border font-semibold";
  renderOrders();
}

function renderOrders() {
  const tbody = $("my-orders-table");
  clearChildren(tbody);

  const filtered = currentOrderFilter === "ALL"
    ? allOrders
    : allOrders.filter(o => o.status === "OPEN" || o.status === "PARTIAL");

  if (filtered.length === 0) {
    const row = el("tr", {},
      el("td", { colspan: "6", class: "text-muted text-center py-4" }, "No orders"),
    );
    tbody.appendChild(row);
    return;
  }

  for (const o of filtered) {
    const sideColor = o.side === "BUY" ? "text-yes" : "text-no";
    const canCancel = o.status === "OPEN" || o.status === "PARTIAL";
    const cancelBtn = canCancel
      ? el("button", { class: "text-xs text-red-400 hover:text-red-300 font-semibold", onclick: () => cancelOrder(o.id) }, "Cancel")
      : el("span");

    const row = el("tr", { class: "border-t border-border/50" },
      el("td", { class: `py-2 font-semibold ${sideColor}` }, o.side),
      el("td", { class: "py-2" }, o.priceCents != null ? o.priceCents + "\u00A2" : "MKT"),
      el("td", { class: "py-2 text-right" }, String(o.qty)),
      el("td", { class: "py-2 text-right" }, String(o.remainingQty)),
      el("td", { class: "py-2" }, statusBadge(o.status)),
      el("td", { class: "py-2 text-right" }, cancelBtn),
    );
    tbody.appendChild(row);
  }
}

// ── Trades ───────────────────────────────────────────────────

async function loadTrades() {
  try {
    const trades = await api(`/markets/${currentMarketId}/trades`);
    const tbody = $("trades-table");
    clearChildren(tbody);

    if (trades.length === 0) {
      tbody.appendChild(el("tr", {},
        el("td", { colspan: "4", class: "text-muted text-center py-4" }, "No trades yet"),
      ));
      return;
    }

    for (const t of trades.slice(0, 20)) {
      tbody.appendChild(el("tr", { class: "border-t border-border/50" },
        el("td", { class: "py-2 font-semibold" }, t.priceCents + "\u00A2"),
        el("td", { class: "py-2 text-right" }, String(t.qty)),
        el("td", { class: "py-2 text-right text-muted" }, t.takerFeeCents + "\u00A2"),
        el("td", { class: "py-2 text-right text-muted" }, timeAgo(t.createdAt)),
      ));
    }
  } catch {}
}

// ── Position ─────────────────────────────────────────────────

async function loadPosition() {
  try {
    const p = await api(`/markets/${currentMarketId}/position`);
    const display = $("position-display");
    clearChildren(display);
    const pnlColor = p.realizedPnlCents >= 0 ? "text-yes" : "text-no";
    display.appendChild(el("div", { class: "space-y-1" },
      el("div", {}, el("span", { class: "text-muted" }, "YES Shares: "), el("span", { class: "text-white font-semibold" }, String(p.yesShares))),
      el("div", {}, el("span", { class: "text-muted" }, "Avg Cost: "), el("span", { class: "text-white font-semibold" }, p.avgCostCents + "\u00A2")),
      el("div", {}, el("span", { class: "text-muted" }, "Realized PnL: "), el("span", { class: `font-semibold ${pnlColor}` }, (p.realizedPnlCents >= 0 ? "+" : "") + p.realizedPnlCents + "\u00A2")),
    ));
  } catch {}
}

// ── Resolve Market ───────────────────────────────────────────

async function resolveMarket(resolution) {
  if (!confirm(`Resolve this market as ${resolution}? This cannot be undone.`)) return;
  try {
    await api(`/markets/${currentMarketId}/resolve`, {
      method: "POST",
      body: JSON.stringify({ resolvesTo: resolution }),
    });
    showToast(`Market resolved: ${resolution}`);
    loadMarketDetail();
  } catch (e) { showToast(e.message, "error"); }
}

// ── WebSocket ────────────────────────────────────────────────

function connectWs() {
  if (ws) { ws.close(); ws = null; }
  clearTimeout(wsReconnectTimer);

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/ws?market_id=${currentMarketId}${token ? "&token=" + token : ""}`;
  ws = new WebSocket(url);

  ws.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.type === "book_snapshot") renderBook(msg.data);
      if (msg.type === "trade") loadTrades();
      if (msg.type === "order_update") loadMyOrders();
      if (msg.type === "market_resolved") loadMarketDetail();
    } catch {}
  };

  ws.onerror = () => {};

  ws.onclose = () => {
    ws = null;
    // Auto-reconnect only if still on market detail page
    if (!$("page-market-detail").classList.contains("hidden") && currentMarketId) {
      wsReconnectTimer = setTimeout(connectWs, 3000);
    }
  };
}

// ── Portfolio Page ───────────────────────────────────────────

async function loadPortfolio() {
  try {
    const [markets, wallet] = await Promise.all([api("/markets"), api("/wallet")]);

    // Fetch positions for all markets in parallel
    const positions = await Promise.all(
      markets.map(m =>
        api(`/markets/${m.id}/position`).then(p => ({ ...p, market: m })).catch(() => null)
      )
    );

    const active = positions.filter(p => p && p.yesShares !== 0);

    // Stats
    const statsEl = $("portfolio-stats");
    clearChildren(statsEl);

    const totalPnl = active.reduce((s, p) => s + (p.realizedPnlCents || 0), 0);
    const totalShares = active.reduce((s, p) => s + Math.abs(p.yesShares), 0);

    const stats = [
      { label: "Available", value: "$" + centsToPrice(wallet.availableCents), color: "text-white" },
      { label: "Locked", value: "$" + centsToPrice(wallet.lockedCents), color: "text-muted" },
      { label: "Positions", value: String(active.length), color: "text-white" },
      { label: "Realized PnL", value: (totalPnl >= 0 ? "+" : "") + totalPnl + "\u00A2", color: totalPnl >= 0 ? "text-yes" : "text-no" },
    ];

    for (const s of stats) {
      statsEl.appendChild(el("div", { class: "bg-surface border border-border rounded-2xl p-4 text-center" },
        el("div", { class: `text-xl font-bold ${s.color}` }, s.value),
        el("div", { class: "text-xs text-muted mt-1" }, s.label),
      ));
    }

    // Table
    const tbody = $("portfolio-table");
    clearChildren(tbody);

    if (active.length === 0) {
      tbody.appendChild(el("tr", {},
        el("td", { colspan: "4", class: "text-muted text-center py-8" }, "No positions yet. Start trading!"),
      ));
      return;
    }

    for (const p of active) {
      const pnlColor = p.realizedPnlCents >= 0 ? "text-yes" : "text-no";
      tbody.appendChild(el("tr", { class: "border-t border-border/50 cursor-pointer hover:bg-surfaceHover transition", onclick: () => openMarket(p.market.id) },
        el("td", { class: "py-3" },
          el("div", { class: "font-semibold text-white" }, p.market.title),
          el("div", { class: "text-xs text-muted" }, p.market.status),
        ),
        el("td", { class: "py-3 text-right font-semibold" }, String(p.yesShares)),
        el("td", { class: "py-3 text-right" }, p.avgCostCents + "\u00A2"),
        el("td", { class: `py-3 text-right font-semibold ${pnlColor}` }, (p.realizedPnlCents >= 0 ? "+" : "") + p.realizedPnlCents + "\u00A2"),
      ));
    }
  } catch (e) { showToast(e.message, "error"); }
}

// ── Anchor Bets Page ─────────────────────────────────────────

function toggleAnchorForm() {
  $("anchor-form").classList.toggle("hidden");
}

async function createAnchorBet() {
  try {
    const body = {
      title: $("ab-title").value,
      rulesText: $("ab-rules").value,
    };
    const opponent = $("ab-opponent").value.trim();
    if (opponent) body.opponentUserId = opponent;
    const arbitrator = $("ab-arbitrator").value.trim();
    if (arbitrator) body.arbitratorUserId = arbitrator;

    await api("/anchor-bets", { method: "POST", body: JSON.stringify(body) });
    showToast("Anchor bet created");
    $("ab-title").value = "";
    $("ab-rules").value = "";
    $("ab-opponent").value = "";
    $("ab-arbitrator").value = "";
    $("anchor-form").classList.add("hidden");
    loadAnchorBets();
  } catch (e) { showToast(e.message, "error"); }
}

async function loadAnchorBets() {
  try {
    const bets = await api("/anchor-bets");
    const list = $("anchor-bets-list");
    clearChildren(list);

    if (bets.length === 0) {
      list.appendChild(el("div", { class: "text-muted text-center py-12" }, "No anchor bets yet"));
      return;
    }

    for (const ab of bets) {
      const sideCount = ab._count?.sideBets || 0;
      const card = el("div", { class: "bg-surface border border-border rounded-2xl p-5 animate-fade" },
        el("div", { class: "flex items-start justify-between mb-3" },
          el("div", {},
            el("h3", { class: "text-white font-semibold" }, ab.title),
            el("p", { class: "text-muted text-xs mt-1" }, ab.rulesText),
          ),
          el("div", { class: "flex items-center gap-2" },
            statusBadge(ab.status),
            el("span", { class: "text-xs text-muted" }, sideCount + " side bet" + (sideCount !== 1 ? "s" : "")),
          ),
        ),
      );

      // Side bets list
      if (ab.sideBets && ab.sideBets.length > 0) {
        const sbList = el("div", { class: "mb-3 space-y-1" });
        for (const sb of ab.sideBets) {
          const dirColor = sb.direction === "YES" ? "text-yes" : "text-no";
          sbList.appendChild(el("div", { class: "flex items-center gap-2 text-xs" },
            el("span", { class: `font-semibold ${dirColor}` }, sb.direction),
            el("span", { class: "text-muted" }, "$" + centsToPrice(sb.amountCents)),
            el("span", { class: "text-muted truncate" }, sb.userId),
          ));
        }
        card.appendChild(sbList);
      }

      // Add side bet form (only for OPEN)
      if (ab.status === "OPEN") {
        const formId = "sb-form-" + ab.id;
        const form = el("div", { class: "flex flex-wrap items-end gap-2 pt-3 border-t border-border" },
          el("select", { id: formId + "-dir", class: "bg-bg border border-border rounded-lg px-2 py-1.5 text-xs" },
            el("option", { value: "YES" }, "YES"),
            el("option", { value: "NO" }, "NO"),
          ),
          el("input", { id: formId + "-amt", type: "number", min: "1", value: "100", placeholder: "Amount (cents)", class: "bg-bg border border-border rounded-lg px-2 py-1.5 text-xs w-28" }),
          el("button", { class: "text-xs font-semibold bg-accent hover:bg-accentHover text-white px-3 py-1.5 rounded-lg transition", onclick: () => addSideBet(ab.id, formId) }, "Add Side Bet"),
        );
        card.appendChild(form);

        // Admin promote button
        if (currentUser && currentUser.role === "ADMIN") {
          const promoteDiv = el("div", { class: "flex flex-wrap items-end gap-2 pt-3 mt-3 border-t border-border" },
            el("input", { id: formId + "-slug", placeholder: "market-slug", class: "bg-bg border border-border rounded-lg px-2 py-1.5 text-xs w-32" }),
            el("input", { id: formId + "-threshold", type: "number", min: "0", value: "0", placeholder: "Threshold (cents)", class: "bg-bg border border-border rounded-lg px-2 py-1.5 text-xs w-32" }),
            el("button", { class: "text-xs font-semibold bg-accent/20 text-accent hover:bg-accent/30 px-3 py-1.5 rounded-lg transition", onclick: () => promoteAnchorBet(ab.id, formId) }, "Promote to Market"),
          );
          card.appendChild(promoteDiv);
        }
      }

      list.appendChild(card);
    }
  } catch (e) { showToast(e.message, "error"); }
}

async function addSideBet(anchorBetId, formId) {
  try {
    const direction = document.getElementById(formId + "-dir").value;
    const amountCents = parseInt(document.getElementById(formId + "-amt").value);
    await api(`/anchor-bets/${anchorBetId}/side-bets`, {
      method: "POST",
      body: JSON.stringify({ direction, amountCents }),
    });
    showToast("Side bet added");
    loadAnchorBets();
  } catch (e) { showToast(e.message, "error"); }
}

async function promoteAnchorBet(anchorBetId, formId) {
  try {
    const slug = document.getElementById(formId + "-slug").value;
    const thresholdCents = parseInt(document.getElementById(formId + "-threshold").value) || 0;
    await api(`/anchor-bets/${anchorBetId}/promote`, {
      method: "POST",
      body: JSON.stringify({ slug, thresholdCents }),
    });
    showToast("Anchor bet promoted to market");
    loadAnchorBets();
  } catch (e) { showToast(e.message, "error"); }
}

// ── Admin Page ───────────────────────────────────────────────

async function loadAdmin() {
  try {
    const [metrics, users, events] = await Promise.all([
      api("/admin/metrics"),
      api("/admin/users"),
      api("/admin/events?limit=50"),
    ]);

    // Metrics cards
    const metricsEl = $("admin-metrics");
    clearChildren(metricsEl);
    const metricsList = [
      { label: "Users", value: metrics.totalUsers },
      { label: "Open Markets", value: metrics.openMarkets },
      { label: "Resolved", value: metrics.resolvedMarkets },
      { label: "Open Orders", value: metrics.totalOpenOrders },
      { label: "Total Balance", value: "$" + centsToPrice(metrics.totalBalanceCents) },
      { label: "Platform Fees", value: "$" + centsToPrice(metrics.platformFeeCents) },
    ];
    for (const m of metricsList) {
      metricsEl.appendChild(el("div", { class: "bg-surface border border-border rounded-2xl p-4 text-center" },
        el("div", { class: "text-xl font-bold text-white" }, String(m.value)),
        el("div", { class: "text-xs text-muted mt-1" }, m.label),
      ));
    }

    // Populate deposit dropdown
    const depSelect = $("dep-user");
    clearChildren(depSelect);
    depSelect.appendChild(el("option", { value: "" }, "Select user\u2026"));
    for (const u of users) {
      depSelect.appendChild(el("option", { value: u.id }, u.email + " ($" + centsToPrice(u.balanceCents) + ")"));
    }

    // Users table
    const usersBody = $("admin-users-table");
    clearChildren(usersBody);
    for (const u of users) {
      usersBody.appendChild(el("tr", { class: "border-t border-border/50" },
        el("td", { class: "py-2" }, u.email),
        el("td", { class: "py-2" }, statusBadge(u.role)),
        el("td", { class: "py-2 text-right font-semibold" }, "$" + centsToPrice(u.balanceCents)),
        el("td", { class: "py-2 text-right text-muted" }, "$" + centsToPrice(u.lockedCents)),
        el("td", { class: "py-2 text-xs text-muted truncate max-w-[140px]" }, u.id),
      ));
    }

    // Events table
    const eventsBody = $("admin-events-table");
    clearChildren(eventsBody);
    for (const e of events) {
      eventsBody.appendChild(el("tr", { class: "border-t border-border/50" },
        el("td", { class: "py-2 font-semibold text-xs" }, e.type),
        el("td", { class: "py-2 text-xs text-muted" }, e.marketId || "—"),
        el("td", { class: "py-2 text-xs text-muted truncate max-w-[300px]" }, JSON.stringify(e.payload)),
        el("td", { class: "py-2 text-right text-xs text-muted whitespace-nowrap" }, timeAgo(e.createdAt)),
      ));
    }
  } catch (e) { showToast(e.message, "error"); }
}

async function createMarket() {
  try {
    await api("/markets", {
      method: "POST",
      body: JSON.stringify({
        slug: $("cm-slug").value,
        title: $("cm-title").value,
        description: $("cm-desc").value || "",
      }),
    });
    showToast("Market created");
    $("cm-slug").value = "";
    $("cm-title").value = "";
    $("cm-desc").value = "";
    loadAdmin();
  } catch (e) { showToast(e.message, "error"); }
}

async function deposit() {
  try {
    const userId = $("dep-user").value;
    if (!userId) { showToast("Select a user first", "error"); return; }
    await api("/wallet/deposit", {
      method: "POST",
      body: JSON.stringify({ userId, amountCents: parseInt($("dep-amount").value) }),
    });
    showToast("Deposit successful");
    loadAdmin();
  } catch (e) { showToast(e.message, "error"); }
}

// ── Init ─────────────────────────────────────────────────────

updateAuthUI();
