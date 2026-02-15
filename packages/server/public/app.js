/* global fetch, WebSocket, localStorage, document, window, location */
const API = location.origin;
let token = localStorage.getItem("token");
let currentUser = JSON.parse(localStorage.getItem("user") || "null");
let currentMarketId = null;
let ws = null;

// ── Helpers ─────────────────────────────────────────────────

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, { ...opts, headers });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.error || res.statusText;
    throw new Error(msg);
  }
  return data;
}

function showToast(msg, type = "success") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = `toast ${type}`;
  t.style.display = "block";
  setTimeout(() => (t.style.display = "none"), 3000);
}

function $(id) { return document.getElementById(id); }

function centsToPrice(c) { return (c / 100).toFixed(2); }

function timeAgo(d) {
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  return Math.floor(s / 3600) + "h ago";
}

// ── Auth ────────────────────────────────────────────────────

function updateAuthUI() {
  if (token && currentUser) {
    $("auth-section").style.display = "none";
    $("app-section").style.display = "block";
    $("user-email").textContent = currentUser.email;
    $("logout-btn").classList.remove("hidden");
    if (currentUser.role === "ADMIN") $("nav-admin").classList.remove("hidden");
    else $("nav-admin").classList.add("hidden");
    showPage("markets");
  } else {
    $("auth-section").style.display = "block";
    $("app-section").style.display = "none";
    $("user-email").textContent = "";
    $("logout-btn").classList.add("hidden");
  }
}

async function doLogin() {
  try {
    const data = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: $("auth-email").value, password: $("auth-pass").value }),
    });
    token = data.token;
    currentUser = data.user;
    localStorage.setItem("token", token);
    localStorage.setItem("user", JSON.stringify(currentUser));
    updateAuthUI();
    showToast("Logged in");
  } catch (e) { showToast(e.message, "error"); }
}

async function doRegister() {
  try {
    const data = await api("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: $("auth-email").value, password: $("auth-pass").value }),
    });
    token = data.token;
    currentUser = data.user;
    localStorage.setItem("token", token);
    localStorage.setItem("user", JSON.stringify(currentUser));
    updateAuthUI();
    showToast("Registered");
  } catch (e) { showToast(e.message, "error"); }
}

function logout() {
  token = null;
  currentUser = null;
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  if (ws) { ws.close(); ws = null; }
  updateAuthUI();
}

// ── Navigation ──────────────────────────────────────────────

function showPage(page) {
  $("page-markets").classList.add("hidden");
  $("page-market-detail").classList.add("hidden");
  $("page-admin").classList.add("hidden");
  document.querySelectorAll(".nav a").forEach(a => a.classList.remove("active"));

  if (page === "markets") {
    $("page-markets").classList.remove("hidden");
    $("nav-markets").classList.add("active");
    loadMarkets();
    loadWallet();
  } else if (page === "market-detail") {
    $("page-market-detail").classList.remove("hidden");
    loadMarketDetail();
  } else if (page === "admin") {
    $("page-admin").classList.remove("hidden");
    $("nav-admin").classList.add("active");
    loadAdmin();
  }
}

// ── Markets ─────────────────────────────────────────────────

async function loadMarkets() {
  try {
    const markets = await api("/markets");
    const html = markets.map(m => `
      <div class="card" style="cursor:pointer" onclick="openMarket('${m.id}')">
        <div class="flex-between">
          <div><strong>${m.title}</strong> <span style="color:var(--muted)">/${m.slug}</span></div>
          <span class="badge ${m.status === 'OPEN' ? 'badge-open' : 'badge-resolved'}">${m.status}${m.resolvesTo ? ' → ' + m.resolvesTo : ''}</span>
        </div>
        <div style="color:var(--muted);font-size:13px">${m.description || ''}</div>
      </div>
    `).join("");
    $("markets-list").innerHTML = html || '<div style="color:var(--muted)">No markets yet</div>';
  } catch (e) { showToast(e.message, "error"); }
}

async function loadWallet() {
  try {
    const w = await api("/wallet");
    $("wallet-display").textContent = `Balance: $${centsToPrice(w.balanceCents)} | Locked: $${centsToPrice(w.lockedCents)} | Available: $${centsToPrice(w.availableCents)}`;
  } catch {}
}

function openMarket(id) {
  currentMarketId = id;
  showPage("market-detail");
}

// ── Market Detail ───────────────────────────────────────────

async function loadMarketDetail() {
  if (!currentMarketId) return;
  try {
    const m = await api(`/markets/${currentMarketId}`);
    $("market-title").textContent = m.title;
    $("market-status").textContent = m.status + (m.resolvesTo ? " → " + m.resolvesTo : "");
    $("market-status").className = `badge ${m.status === "OPEN" ? "badge-open" : "badge-resolved"}`;
    renderBook(m.book);
    loadMyOrders();
    loadTrades();
    loadPosition();
    connectWs();
  } catch (e) { showToast(e.message, "error"); }
}

function renderBook(book) {
  $("bids-table").innerHTML = (book.bids || []).map(l =>
    `<tr><td class="bid">${l.priceCents}¢</td><td>${l.totalQty}</td></tr>`
  ).join("") || '<tr><td colspan="2" style="color:var(--muted)">No bids</td></tr>';

  $("asks-table").innerHTML = (book.asks || []).map(l =>
    `<tr><td class="ask">${l.priceCents}¢</td><td>${l.totalQty}</td></tr>`
  ).join("") || '<tr><td colspan="2" style="color:var(--muted)">No asks</td></tr>';
}

async function loadMyOrders() {
  try {
    const orders = await api(`/markets/${currentMarketId}/orders`);
    const open = orders.filter(o => o.status === "OPEN" || o.status === "PARTIAL");
    $("my-orders-table").innerHTML = open.map(o => `
      <tr>
        <td class="${o.side === 'BUY' ? 'bid' : 'ask'}">${o.side}</td>
        <td>${o.priceCents ?? 'MKT'}¢</td>
        <td>${o.qty}</td>
        <td>${o.remainingQty}</td>
        <td><button class="danger" onclick="cancelOrder('${o.id}')">Cancel</button></td>
      </tr>
    `).join("") || '<tr><td colspan="5" style="color:var(--muted)">No open orders</td></tr>';
  } catch {}
}

async function loadTrades() {
  try {
    const trades = await api(`/markets/${currentMarketId}/trades`);
    $("trades-table").innerHTML = trades.slice(0, 20).map(t => `
      <tr><td>${t.priceCents}¢</td><td>${t.qty}</td><td>${t.takerFeeCents}¢</td><td>${timeAgo(t.createdAt)}</td></tr>
    `).join("") || '<tr><td colspan="4" style="color:var(--muted)">No trades</td></tr>';
  } catch {}
}

async function loadPosition() {
  try {
    const p = await api(`/markets/${currentMarketId}/position`);
    $("position-display").textContent = `YES shares: ${p.yesShares} | Avg cost: ${p.avgCostCents}¢ | PnL: ${p.realizedPnlCents}¢`;
  } catch {}
}

function togglePrice() {
  $("price-group").style.display = $("order-type").value === "MARKET" ? "none" : "block";
}

async function placeOrder() {
  try {
    const body = {
      side: $("order-side").value,
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
    loadMarketDetail();
    loadWallet();
  } catch (e) { showToast(e.message, "error"); }
}

// ── WebSocket ───────────────────────────────────────────────

function connectWs() {
  if (ws) { ws.close(); ws = null; }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/ws?market_id=${currentMarketId}${token ? "&token=" + token : ""}`;
  ws = new WebSocket(url);
  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === "book_snapshot") renderBook(msg.data);
    if (msg.type === "trade") loadTrades();
    if (msg.type === "order_update") loadMyOrders();
    if (msg.type === "market_resolved") loadMarketDetail();
  };
  ws.onerror = () => {};
  ws.onclose = () => {};
}

// ── Admin ───────────────────────────────────────────────────

async function loadAdmin() {
  try {
    const [metrics, users, events] = await Promise.all([
      api("/admin/metrics"),
      api("/admin/users"),
      api("/admin/events?limit=50"),
    ]);

    $("admin-metrics").innerHTML = [
      { label: "Users", value: metrics.totalUsers },
      { label: "Open Markets", value: metrics.openMarkets },
      { label: "Resolved", value: metrics.resolvedMarkets },
      { label: "Open Orders", value: metrics.totalOpenOrders },
      { label: "Total Balance", value: "$" + centsToPrice(metrics.totalBalanceCents) },
      { label: "Platform Fees", value: "$" + centsToPrice(metrics.platformFeeCents) },
    ].map(s => `<div class="card stat"><div class="value">${s.value}</div><div class="label">${s.label}</div></div>`).join("");

    $("admin-users-table").innerHTML = users.map(u => `
      <tr><td>${u.email}</td><td>${u.role}</td><td>$${centsToPrice(u.balanceCents)}</td><td>$${centsToPrice(u.lockedCents)}</td>
        <td style="font-size:11px;color:var(--muted)">${u.id}</td></tr>
    `).join("");

    $("admin-events-table").innerHTML = events.map(e => `
      <tr><td>${e.type}</td><td style="font-size:11px">${e.marketId || '-'}</td>
        <td style="font-size:11px;max-width:300px;overflow:hidden;text-overflow:ellipsis">${JSON.stringify(e.payload)}</td>
        <td>${timeAgo(e.createdAt)}</td></tr>
    `).join("");
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
    $("cm-slug").value = ""; $("cm-title").value = ""; $("cm-desc").value = "";
    loadAdmin();
  } catch (e) { showToast(e.message, "error"); }
}

async function deposit() {
  try {
    await api("/wallet/deposit", {
      method: "POST",
      body: JSON.stringify({ userId: $("dep-user").value, amountCents: parseInt($("dep-amount").value) }),
    });
    showToast("Deposit successful");
    loadAdmin();
  } catch (e) { showToast(e.message, "error"); }
}

// ── Init ────────────────────────────────────────────────────

updateAuthUI();
