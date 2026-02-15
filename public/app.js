// ── State ────────────────────────────────────────────
let token = localStorage.getItem('token');
let user = JSON.parse(localStorage.getItem('user') || 'null');
let currentMarketId = null;
let ws = null;

const API = '';

// ── Helpers ──────────────────────────────────────────
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, { ...opts, headers: { ...headers, ...opts.headers } });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

function flash(elId, msg, type = 'error') {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = `<div class="flash flash-${type}">${msg}</div>`;
  setTimeout(() => { el.innerHTML = ''; }, 5000);
}

function $(id) { return document.getElementById(id); }

function cents(c) { return (c / 100).toFixed(2); }

// ── Auth ─────────────────────────────────────────────
function showAuthTab(tab) {
  $('login-form').classList.toggle('hidden', tab !== 'login');
  $('register-form').classList.toggle('hidden', tab !== 'register');
  document.querySelectorAll('#auth-section .tab').forEach((t, i) => {
    t.classList.toggle('active', (tab === 'login' && i === 0) || (tab === 'register' && i === 1));
  });
}

async function doLogin() {
  try {
    const data = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: $('login-email').value, password: $('login-password').value }),
    });
    token = data.token; user = data.user;
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    showApp();
  } catch (e) { flash('auth-flash', e.message); }
}

async function doRegister() {
  try {
    const data = await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: $('reg-email').value, password: $('reg-password').value }),
    });
    token = data.token; user = data.user;
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    showApp();
  } catch (e) { flash('auth-flash', e.message); }
}

function doLogout() {
  token = null; user = null;
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  if (ws) { ws.close(); ws = null; }
  $('auth-section').classList.remove('hidden');
  $('app-section').classList.add('hidden');
}

// ── App Init ─────────────────────────────────────────
function showApp() {
  $('auth-section').classList.add('hidden');
  $('app-section').classList.remove('hidden');
  $('user-email').textContent = user.email;
  $('user-role').textContent = user.role;
  $('user-role').className = 'tag ' + (user.role === 'ADMIN' ? 'tag-admin' : 'tag-open');
  refreshBalance();
  loadMarkets();
  if (user.role === 'ADMIN') {
    $('tab-admin').style.display = '';
    loadAdminData();
  } else {
    $('tab-admin').style.display = 'none';
  }
}

async function refreshBalance() {
  try {
    const w = await api('/wallet');
    $('user-balance').textContent = `$${cents(w.balanceCents)} (locked: $${cents(w.lockedCents)})`;
  } catch { $('user-balance').textContent = ''; }
}

// ── Tabs ─────────────────────────────────────────────
function showTab(tab) {
  ['markets', 'market-detail', 'admin'].forEach(t => {
    $(`panel-${t}`).classList.toggle('hidden', t !== tab);
    $(`tab-${t}`).classList.toggle('active', t === tab);
  });
  if (tab === 'markets') loadMarkets();
  if (tab === 'admin') loadAdminData();
}

// ── Markets ──────────────────────────────────────────
async function loadMarkets() {
  try {
    const markets = await api('/markets');
    const tbody = $('markets-tbody');
    tbody.innerHTML = markets.map(m => `
      <tr>
        <td>${m.title}</td>
        <td class="mono">${m.slug}</td>
        <td><span class="tag tag-${m.status.toLowerCase()}">${m.status}</span></td>
        <td class="bid mono">${m.bestBid ?? '-'}</td>
        <td class="ask mono">${m.bestAsk ?? '-'}</td>
        <td><button class="secondary" onclick="selectMarket('${m.id}')">View</button></td>
      </tr>
    `).join('');
  } catch (e) { console.error(e); }
}

async function selectMarket(id) {
  currentMarketId = id;
  showTab('market-detail');
  await refreshMarketDetail();
  connectWS(id);
}

async function refreshMarketDetail() {
  if (!currentMarketId) return;
  try {
    const m = await api(`/markets/${currentMarketId}`);
    $('market-title').textContent = m.title;
    $('market-status').innerHTML = `<span class="tag tag-${m.status.toLowerCase()}">${m.status}</span>` +
      (m.resolvesTo ? ` → ${m.resolvesTo}` : '') + ` | Slug: ${m.slug}`;
    if (m.book) renderBook(m.book);
    if (m.recentTrades) renderTrades(m.recentTrades);
    await loadMyOrders();
  } catch (e) { console.error(e); }
}

function renderBook(book) {
  const bidsTbody = $('book-bids');
  const asksTbody = $('book-asks');
  bidsTbody.innerHTML = book.bids.map(([p, q]) =>
    `<tr><td class="text-right mono">${q}</td><td class="text-right bid mono">${p}¢</td></tr>`
  ).join('') || '<tr><td colspan="2" style="color:#666">No bids</td></tr>';
  asksTbody.innerHTML = book.asks.map(([p, q]) =>
    `<tr><td class="ask mono">${p}¢</td><td class="mono">${q}</td></tr>`
  ).join('') || '<tr><td colspan="2" style="color:#666">No asks</td></tr>';
}

function renderTrades(trades) {
  $('trades-tbody').innerHTML = trades.slice(0, 20).map(t =>
    `<tr><td class="mono">${t.priceCents}¢</td><td class="mono">${t.qty}</td><td>${new Date(t.createdAt).toLocaleTimeString()}</td></tr>`
  ).join('') || '<tr><td colspan="3" style="color:#666">No trades</td></tr>';
}

async function loadMyOrders() {
  if (!currentMarketId) return;
  try {
    const orders = await api(`/markets/${currentMarketId}/orders`);
    $('my-orders-tbody').innerHTML = orders.map(o => `
      <tr>
        <td class="${o.side === 'BUY' ? 'bid' : 'ask'}">${o.side}</td>
        <td class="mono">${o.priceCents ?? 'MKT'}¢</td>
        <td class="mono">${o.qty}</td>
        <td class="mono">${o.remainingQty}</td>
        <td><span class="tag tag-${o.status === 'OPEN' || o.status === 'PARTIAL' ? 'open' : 'resolved'}">${o.status}</span></td>
        <td>${(o.status === 'OPEN' || o.status === 'PARTIAL') ? `<button class="danger" onclick="cancelMyOrder('${o.id}')">Cancel</button>` : ''}</td>
      </tr>
    `).join('') || '<tr><td colspan="6" style="color:#666">No orders</td></tr>';
  } catch (e) { console.error(e); }
}

// ── Place Order ──────────────────────────────────────
function togglePrice() {
  $('price-row').classList.toggle('hidden', $('order-type').value === 'MARKET');
}

async function placeOrder() {
  if (!currentMarketId) return;
  const body = {
    side: $('order-side').value,
    type: $('order-type').value,
    qty: parseInt($('order-qty').value, 10),
  };
  if (body.type === 'LIMIT') body.priceCents = parseInt($('order-price').value, 10);
  try {
    const result = await api(`/markets/${currentMarketId}/orders`, { method: 'POST', body: JSON.stringify(body) });
    flash('order-flash', `Order ${result.orderId.slice(0,8)}... ${result.status} (${result.trades.length} fills)`, 'success');
    refreshMarketDetail();
    refreshBalance();
  } catch (e) { flash('order-flash', e.message); }
}

async function cancelMyOrder(orderId) {
  if (!currentMarketId) return;
  try {
    await api(`/markets/${currentMarketId}/orders/${orderId}/cancel`, { method: 'POST' });
    flash('order-flash', 'Order canceled', 'success');
    refreshMarketDetail();
    refreshBalance();
  } catch (e) { flash('order-flash', e.message); }
}

// ── WebSocket ────────────────────────────────────────
function connectWS(marketId) {
  if (ws) { ws.close(); ws = null; }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws?market_id=${marketId}` + (token ? `&token=${token}` : '');
  ws = new WebSocket(url);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'book_snapshot') renderBook(msg.data);
    if (msg.type === 'trade') {
      refreshMarketDetail(); // Simple: just refresh everything
      refreshBalance();
    }
    if (msg.type === 'order_update') {
      loadMyOrders();
      refreshBalance();
    }
  };
  ws.onclose = () => { ws = null; };
}

// ── Admin ────────────────────────────────────────────
async function loadAdminData() {
  if (user?.role !== 'ADMIN') return;
  try {
    const m = await api('/admin/metrics');
    $('metrics-grid').innerHTML = [
      { v: m.openMarkets, l: 'Open Markets' },
      { v: m.openOrders, l: 'Open Orders' },
      { v: m.totalTrades, l: 'Total Trades' },
      { v: '$' + cents(m.totalLockedCents), l: 'Total Locked' },
      { v: '$' + cents(m.platformFeeCents), l: 'Platform Fees' },
      { v: m.userCount, l: 'Users' },
    ].map(x => `<div class="card metric"><div class="value">${x.v}</div><div class="label">${x.l}</div></div>`).join('');
  } catch (e) { console.error(e); }

  // Load users for deposit dropdown
  try {
    const users = await api('/admin/users');
    $('dep-user').innerHTML = users.map(u => `<option value="${u.id}">${u.email} ($${cents(u.wallet?.balanceCents || 0)})</option>`).join('');
  } catch {}

  // Load markets for resolve dropdown
  try {
    const markets = await api('/markets');
    $('resolve-market').innerHTML = markets.filter(m => m.status === 'OPEN')
      .map(m => `<option value="${m.id}">${m.title}</option>`).join('');
  } catch {}

  // Load events
  try {
    const events = await api('/admin/events?limit=30');
    $('events-tbody').innerHTML = events.map(e => `
      <tr>
        <td>${new Date(e.createdAt).toLocaleString()}</td>
        <td class="mono">${e.type}</td>
        <td class="mono">${e.marketId ? e.marketId.slice(0,8) + '...' : '-'}</td>
        <td style="max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px">${JSON.stringify(e.payload)}</td>
      </tr>
    `).join('');
  } catch {}
}

async function createMarket() {
  try {
    const data = await api('/markets', {
      method: 'POST',
      body: JSON.stringify({
        slug: $('cm-slug').value,
        title: $('cm-title').value,
        description: $('cm-desc').value || undefined,
      }),
    });
    flash('cm-flash', `Market "${data.title}" created`, 'success');
    $('cm-slug').value = ''; $('cm-title').value = ''; $('cm-desc').value = '';
    loadMarkets();
    loadAdminData();
  } catch (e) { flash('cm-flash', e.message); }
}

async function doDeposit() {
  try {
    const data = await api('/wallet/deposit', {
      method: 'POST',
      body: JSON.stringify({
        userId: $('dep-user').value,
        amountCents: parseInt($('dep-amount').value, 10),
      }),
    });
    flash('dep-flash', `Deposited. New balance: $${cents(data.balanceCents)}`, 'success');
    refreshBalance();
    loadAdminData();
  } catch (e) { flash('dep-flash', e.message); }
}

async function resolveMarket() {
  const marketId = $('resolve-market').value;
  const resolvesTo = $('resolve-to').value;
  if (!marketId) return;
  try {
    const data = await api(`/markets/${marketId}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ resolvesTo }),
    });
    flash('resolve-flash', `Resolved! ${data.settledPositions} positions settled, $${cents(data.totalPayout)} payout`, 'success');
    loadMarkets();
    loadAdminData();
    refreshBalance();
  } catch (e) { flash('resolve-flash', e.message); }
}

// ── Init ─────────────────────────────────────────────
if (token && user) {
  showApp();
} else {
  $('auth-section').classList.remove('hidden');
  $('app-section').classList.add('hidden');
}
