const BASE = location.origin;
let token = '';
let currentUser = null;
let currentMarketID = '';
let ws = null;

// ── Auth ─────────────────────────────────────────────

async function doRegister() {
  const email = document.getElementById('auth-email').value;
  const password = document.getElementById('auth-pass').value;
  const res = await api('POST', '/api/register', { email, password });
  if (res.error) return toast(res.error, true);
  token = res.token;
  currentUser = res.user;
  document.getElementById('auth-status').textContent = `Logged in as ${res.user.email} (${res.user.role})`;
  afterLogin();
}

async function doLogin() {
  const email = document.getElementById('auth-email').value;
  const password = document.getElementById('auth-pass').value;
  const res = await api('POST', '/api/login', { email, password });
  if (res.error) return toast(res.error, true);
  token = res.token;
  currentUser = res.user;
  document.getElementById('auth-status').textContent = `Logged in as ${res.user.email} (${res.user.role})`;
  afterLogin();
}

function afterLogin() {
  loadMarkets();
  loadWallet();
  if (currentUser.role === 'ADMIN') loadAdminData();
}

// ── API helper ───────────────────────────────────────

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;
  if (body) opts.body = JSON.stringify(body);
  try {
    const r = await fetch(BASE + path, opts);
    return await r.json();
  } catch (e) {
    return { error: e.message };
  }
}

// ── Markets ──────────────────────────────────────────

async function loadMarkets() {
  const markets = await api('GET', '/api/markets');
  if (Array.isArray(markets)) {
    const sel = document.getElementById('market-select');
    const resolveSel = document.getElementById('resolve-market');
    sel.innerHTML = '<option value="">-- select market --</option>';
    resolveSel.innerHTML = '';
    markets.forEach(m => {
      sel.innerHTML += `<option value="${m.id}">${m.title} (${m.status})</option>`;
      if (m.status === 'OPEN') {
        resolveSel.innerHTML += `<option value="${m.id}">${m.title}</option>`;
      }
    });
  }
}

async function selectMarket() {
  const id = document.getElementById('market-select').value;
  currentMarketID = id;
  if (!id) return;
  loadBook();
  loadTrades();
  loadOrders();
  connectWS(id);
  const mkt = await api('GET', `/api/markets/${id}`);
  document.getElementById('market-status').textContent = mkt.status || '';
}

async function loadBook() {
  if (!currentMarketID) return;
  const data = await api('GET', `/api/markets/${currentMarketID}/book`);
  renderBook(data.bids || [], data.asks || []);
}

function renderBook(bids, asks) {
  document.getElementById('bids-body').innerHTML = bids.map(b =>
    `<tr class="bid"><td>${b.price}¢</td><td>${b.qty}</td></tr>`
  ).join('') || '<tr><td colspan="2" class="info">empty</td></tr>';
  document.getElementById('asks-body').innerHTML = asks.map(a =>
    `<tr class="ask"><td>${a.price}¢</td><td>${a.qty}</td></tr>`
  ).join('') || '<tr><td colspan="2" class="info">empty</td></tr>';
}

async function loadTrades() {
  if (!currentMarketID) return;
  const trades = await api('GET', `/api/markets/${currentMarketID}/trades?limit=20`);
  if (!Array.isArray(trades)) return;
  document.getElementById('trades-body').innerHTML = trades.map(t =>
    `<tr><td>${t.price_cents}¢</td><td>${t.qty}</td><td>${t.maker_user_id.slice(0,8)}</td><td>${t.taker_user_id.slice(0,8)}</td><td>${t.fee_cents}¢</td><td>${new Date(t.created_at).toLocaleTimeString()}</td></tr>`
  ).join('') || '<tr><td colspan="6" class="info">no trades</td></tr>';
}

async function loadOrders() {
  if (!currentMarketID) return;
  const orders = await api('GET', `/api/markets/${currentMarketID}/orders`);
  if (!Array.isArray(orders)) return;
  document.getElementById('orders-body').innerHTML = orders.map(o =>
    `<tr>
      <td>${o.id.slice(0,8)}</td>
      <td class="${o.side === 'BUY' ? 'bid' : 'ask'}">${o.side}</td>
      <td>${o.order_type}</td>
      <td>${o.price_cents || '-'}¢</td>
      <td>${o.qty}</td>
      <td>${o.remaining_qty}</td>
      <td>${o.status}</td>
      <td>${(o.status === 'OPEN' || o.status === 'PARTIAL') ? `<button class="danger" onclick="cancelOrd('${o.id}')">Cancel</button>` : ''}</td>
    </tr>`
  ).join('') || '<tr><td colspan="8" class="info">no orders</td></tr>';
}

// ── Place / Cancel ───────────────────────────────────

async function placeOrder() {
  if (!currentMarketID) return toast('Select a market first', true);
  const side = document.getElementById('order-side').value;
  const type_ = document.getElementById('order-type').value;
  const price = parseInt(document.getElementById('order-price').value);
  const qty = parseInt(document.getElementById('order-qty').value);
  const body = { side, type: type_, qty };
  if (type_ === 'LIMIT') body.price_cents = price;
  const res = await api('POST', `/api/markets/${currentMarketID}/orders`, body);
  if (res.error) return toast(res.error, true);
  toast(`Order ${res.status}: ${res.order_id ? res.order_id.slice(0,8) : ''}`);
  loadOrders();
  loadBook();
  loadTrades();
  loadWallet();
}

async function cancelOrd(id) {
  const res = await api('DELETE', `/api/orders/${id}`);
  if (res.error) return toast(res.error, true);
  toast('Order canceled');
  loadOrders();
  loadBook();
  loadWallet();
}

// ── Wallet ───────────────────────────────────────────

async function loadWallet() {
  const w = await api('GET', '/api/wallet');
  if (w.error) return;
  const avail = w.balance_cents - w.locked_cents;
  document.getElementById('wallet-info').textContent =
    `Balance: ${w.balance_cents}¢ | Locked: ${w.locked_cents}¢ | Available: ${avail}¢`;
}

// ── WebSocket ────────────────────────────────────────

function connectWS(marketID) {
  if (ws) ws.close();
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.onopen = () => {
    document.getElementById('ws-dot').classList.add('connected');
    document.getElementById('ws-status').textContent = 'connected';
    ws.send(JSON.stringify({ action: 'subscribe', market_id: marketID }));
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'book_snapshot') {
      renderBook(msg.data.bids || [], msg.data.asks || []);
    } else if (msg.type === 'trade') {
      loadTrades();
      loadWallet();
    }
  };
  ws.onclose = () => {
    document.getElementById('ws-dot').classList.remove('connected');
    document.getElementById('ws-status').textContent = 'disconnected';
  };
}

// ── Admin ────────────────────────────────────────────

async function loadAdminData() {
  loadUsers();
  loadMetrics();
}

async function createMarket() {
  const slug = document.getElementById('mkt-slug').value;
  const title = document.getElementById('mkt-title').value;
  const description = document.getElementById('mkt-desc').value;
  const res = await api('POST', '/api/admin/markets', { slug, title, description, tick_size_cents: 1 });
  if (res.error) return toast(res.error, true);
  toast(`Market created: ${res.title}`);
  loadMarkets();
}

async function resolveMarket() {
  const id = document.getElementById('resolve-market').value;
  const to = document.getElementById('resolve-to').value;
  if (!id) return toast('Select a market', true);
  if (!confirm(`Resolve market to ${to}?`)) return;
  const res = await api('POST', `/api/admin/markets/${id}/resolve`, { resolves_to: to });
  if (res.error) return toast(res.error, true);
  toast(`Market resolved: ${to}`);
  loadMarkets();
}

async function adminDeposit() {
  const user_id = document.getElementById('deposit-user').value;
  const cents = parseInt(document.getElementById('deposit-cents').value);
  const res = await api('POST', '/api/admin/deposit', { user_id, cents });
  if (res.error) return toast(res.error, true);
  toast(`Deposited ${cents}¢`);
  loadUsers();
  loadWallet();
}

async function loadUsers() {
  const users = await api('GET', '/api/admin/users');
  if (!Array.isArray(users)) return;
  document.getElementById('users-body').innerHTML = users.map(u =>
    `<tr><td>${u.email}</td><td>${u.role}</td><td>${u.balance_cents}¢</td><td>${u.locked_cents}¢</td></tr>`
  ).join('');
  const depSel = document.getElementById('deposit-user');
  depSel.innerHTML = users.map(u => `<option value="${u.id}">${u.email}</option>`).join('');
}

async function loadMetrics() {
  const m = await api('GET', '/api/admin/metrics');
  if (m.error) return;
  document.getElementById('metrics-info').textContent =
    `Markets: ${m.total_markets} (${m.open_markets} open) | Users: ${m.total_users} | Platform fees: ${m.platform_fee_cents}¢`;
}

async function loadEvents() {
  const events = await api('GET', '/api/admin/events?limit=50');
  if (!Array.isArray(events)) return;
  document.getElementById('events-body').innerHTML = events.map(e =>
    `<tr><td>${e.id}</td><td>${e.type}</td><td>${(e.market_id||'').slice(0,8)}</td><td>${e.seq||'-'}</td><td><code>${JSON.stringify(e.payload).slice(0,80)}</code></td><td>${new Date(e.created_at).toLocaleTimeString()}</td></tr>`
  ).join('');
}

// ── Tabs ─────────────────────────────────────────────

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab).classList.add('active');
  });
});

// ── Toast ────────────────────────────────────────────

function toast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.display = 'block';
  el.style.borderColor = isError ? '#da3633' : '#238636';
  setTimeout(() => { el.style.display = 'none'; }, 3000);
}
