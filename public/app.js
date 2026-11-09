// Kaasu front-end: plain JavaScript, no build step.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, c = 'USD') => { try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: c }).format(n || 0); } catch { return c + ' ' + Number(n || 0).toFixed(2); } };

let chatHistory = [];
let status = {};
let grid = null;
let invoices = [];

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'Request failed (' + res.status + ')');
  return json;
}

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = 'toast'), isError ? 6000 : 3000);
}

async function withBusy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message, true); } finally { if (btn) btn.disabled = false; }
}

// Minimal, safe markdown: **bold**, bullets, line breaks.
function md(text) {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^\s*[-*]\s+/gm, '• ');
}

// ---------- status pills ----------
async function loadStatus() {
  status = await api('/api/status');
  const pp = $('#pill-paypal');
  pp.textContent = status.paypal === 'sandbox' ? '● PayPal Sandbox' : '○ PayPal mock mode';
  pp.className = 'pill ' + (status.paypal === 'sandbox' ? 'ok' : 'warn');
  pp.title = status.paypal === 'sandbox' ? 'Connected to the real PayPal sandbox API' : 'Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to .env';
  const ai = $('#pill-ai');
  ai.textContent = status.ai === 'gemini' ? '● Gemini AI' : '○ AI offline mode';
  ai.className = 'pill ' + (status.ai === 'gemini' ? 'ok' : 'warn');
  ai.title = status.ai === 'gemini' ? 'Model: ' + status.model : 'Add GEMINI_API_KEY to .env';
}

// ---------- chat ----------
function addMsg(role, html, cls = '') {
  const el = document.createElement('div');
  el.className = `msg ${role} ${cls}`;
  el.innerHTML = html;
  $('#messages').appendChild(el);
  $('#messages').scrollTop = $('#messages').scrollHeight;
  return el;
}

async function sendChat(text) {
  text = text.trim();
  if (!text) return;
  addMsg('user', esc(text));
  chatHistory.push({ role: 'user', text });
  $('#chat-input').value = '';
  const typing = addMsg('bot', 'Kaasu is thinking…', 'typing');
  $('#chat-send').disabled = true;
  try {
    const res = await api('/api/chat', { method: 'POST', body: { messages: chatHistory } });
    typing.remove();
    if (res.notice) addMsg('notice', esc(res.notice));
    const el = addMsg('bot', md(res.reply || ''));
    chatHistory.push({ role: 'assistant', text: res.reply || '' });
    if (res.actions && res.actions.length) {
      const box = document.createElement('div');
      box.className = 'actions-inline';
      res.actions.forEach((a) => box.appendChild(actionCard(a)));
      el.appendChild(box);
      $('#messages').scrollTop = $('#messages').scrollHeight;
    }
    refreshAll();
  } catch (e) {
    typing.remove();
    addMsg('bot', '⚠️ ' + esc(e.message));
  } finally {
    $('#chat-send').disabled = false;
  }
}

// ---------- approval cards ----------
const TYPE_LABEL = { send_invoice: '📤 Send invoice', send_reminder: '🔔 Reminder', payout: '💸 Payout', record_payment: '✅ Record payment' };

function actionCard(a) {
  const el = document.createElement('div');
  el.className = 'act ' + a.type;
  el.dataset.id = a.id;
  let body = `<div class="act-top"><span class="act-type">${TYPE_LABEL[a.type] || a.type}</span><span class="act-sum">${esc(a.summary)}</span></div>`;
  if (a.type === 'send_reminder' && a.status === 'pending') {
    body += `<input class="r-subject" value="${esc(a.payload.subject)}" aria-label="Reminder subject" />
             <textarea class="r-message" aria-label="Reminder message">${esc(a.payload.message)}</textarea>`;
  } else if (a.type === 'send_reminder') {
    body += `<div class="muted small" style="margin-top:4px">“${esc(a.payload.subject)}”</div>`;
  }
  if (a.status === 'pending') {
    body += `<div class="act-btns"><button class="btn small good b-ok">Approve</button><button class="btn small bad b-no">Reject</button>
             ${a.source === 'scan' ? '<span class="muted small">suggested by agent scan</span>' : ''}</div>`;
  } else {
    body += `<div class="act-state ${a.status}">${a.status === 'done' ? '✓ Done' : a.status === 'failed' ? '✕ Failed: ' + esc(a.error) : 'Rejected'}</div>`;
  }
  el.innerHTML = body;
  const ok = el.querySelector('.b-ok');
  const no = el.querySelector('.b-no');
  if (ok) ok.onclick = () => withBusy(ok, async () => {
    const edits = a.type === 'send_reminder' ? { subject: el.querySelector('.r-subject').value, message: el.querySelector('.r-message').value } : {};
    const done = await api(`/api/actions/${a.id}/approve`, { method: 'POST', body: edits });
    toast('Done: ' + done.summary);
    syncCards(done);
    refreshAll();
  }).then(() => refreshAll());
  if (no) no.onclick = () => withBusy(no, async () => {
    const r = await api(`/api/actions/${a.id}/reject`, { method: 'POST' });
    syncCards(r);
    refreshAll();
  });
  return el;
}

// Update every copy of a card (chat + inbox) after approve/reject.
function syncCards(a) {
  document.querySelectorAll(`.act[data-id="${a.id}"]`).forEach((old) => old.replaceWith(actionCard(a)));
}

async function loadInbox() {
  const pending = await api('/api/actions?status=pending');
  $('#inbox-count').textContent = pending.length;
  const box = $('#inbox');
  // Keep cards the user is editing; only rebuild when the set changed.
  const ids = pending.map((a) => a.id).join(',');
  if (box.dataset.ids === ids) return;
  box.dataset.ids = ids;
  box.innerHTML = '';
  if (!pending.length) box.innerHTML = '<div class="empty">Nothing waiting. Ask Kaasu to bill a client, or run an agent scan.</div>';
  pending.forEach((a) => box.appendChild(actionCard(a)));
}

// ---------- insights + KPIs ----------
async function loadInsights(refresh = false) {
  const r = await api('/api/insights' + (refresh ? '?refresh=1' : ''));
  const s = r.stats;
  $('#k-out').textContent = money(s.outstanding);
  $('#k-out-sub').textContent = `${s.open_count} open invoice${s.open_count === 1 ? '' : 's'}`;
  $('#k-over').textContent = money(s.overdue_amount);
  $('#k-over-sub').textContent = `${s.overdue_count} overdue`;
  $('#k-paid').textContent = money(s.paid_last_30_days);
  $('#k-paid-sub').textContent = s.avg_days_to_pay != null ? `avg ${s.avg_days_to_pay} days to get paid` : '';
  $('#k-exp').textContent = money(s.expected_next_30_days);
  $('#insights').innerHTML = r.bullets.map((b) => `<li>${md(b)}</li>`).join('') || '<li>No data yet.</li>';
  $('#insights-src').textContent = r.source === 'gemini' ? 'Written by Gemini from your live numbers' : 'Rule-based (AI offline)';
}

// ---------- invoices grid (AG Grid) ----------
function statusCell(p) {
  const d = p.data;
  return `<span class="status ${esc(d.display_status)}">${esc(d.display_status.replace('_', ' '))}</span>${d.demo ? '<span class="sample">SAMPLE</span>' : ''}`;
}
function riskCell(p) {
  const r = p.data.risk;
  if (!r) return '<span class="muted">–</span>';
  const color = r.level === 'High' ? 'var(--red)' : r.level === 'Medium' ? 'var(--marigold)' : 'var(--green)';
  return `<span class="risk" title="${esc(r.reasons.join('\n'))}"><span class="risk-bar"><span style="width:${r.score}%;background:${color}"></span></span>${r.level} ${r.score}</span>`;
}
function actionsCell(p) {
  const d = p.data;
  const wrap = document.createElement('span');
  if (d.view_url) wrap.innerHTML += `<a class="cell-btn" href="${esc(d.view_url)}" target="_blank" rel="noopener">Open in PayPal</a>`;
  const open = ['SENT', 'PARTIALLY_PAID', 'UNPAID'].includes(d.status);
  if (open) {
    const b = document.createElement('button');
    b.className = 'cell-btn';
    b.textContent = 'Chase';
    b.onclick = () => sendChat(`Draft a reminder for invoice ${d.number} (${d.client_name}).`);
    wrap.appendChild(b);
  }
  if (open && (d.demo || status.paypal === 'mock')) {
    const b = document.createElement('button');
    b.className = 'cell-btn';
    b.textContent = 'Simulate payment';
    b.title = 'Sample/mock invoices only';
    b.onclick = () => withBusy(b, async () => { await api('/api/demo/simulate-payment/' + d.id, { method: 'POST' }); toast('Payment simulated'); refreshAll(); });
    wrap.appendChild(b);
  }
  return wrap;
}

const columnDefs = [
  { headerName: 'Invoice', field: 'number', width: 110, pinned: 'left' },
  { headerName: 'Client', field: 'client_name', flex: 1, minWidth: 150 },
  { headerName: 'Amount', field: 'amount', width: 120, type: 'rightAligned', valueFormatter: (p) => money(p.value, p.data.currency) },
  { headerName: 'Due', field: 'due_date', width: 115 },
  { headerName: 'Status', field: 'display_status', width: 195, cellRenderer: statusCell },
  { headerName: 'Late payment risk', field: 'risk.score', width: 160, cellRenderer: riskCell, comparator: (a, b) => (a ?? -1) - (b ?? -1) },
  { headerName: 'Reminders', valueGetter: (p) => (p.data.reminders || []).length, width: 110 },
  { headerName: 'Paid out', width: 170, valueGetter: (p) => (p.data.payouts || []).reduce((t, x) => t + x.amount, 0),
    cellRenderer: (p) => {
      const list = p.data.payouts || [];
      if (!list.length) return p.data.split ? `<span class="muted" title="Will propose a payout when paid">${esc(p.data.split.percent)}% split pending</span>` : '<span class="muted">–</span>';
      return `<span title="${esc(list.map((x) => money(x.amount, p.data.currency) + ' to ' + x.email + ' (batch ' + x.batch_id + ')').join('\n'))}">💸 ${money(p.value, p.data.currency)} → ${esc(list[0].email.split('@')[0])}</span>`;
    } },
  { headerName: '', field: 'id', minWidth: 230, flex: 1, sortable: false, cellRenderer: actionsCell },
];

function renderGrid() {
  const el = $('#grid');
  if (window.agGrid && agGrid.createGrid) {
    if (!grid) {
      grid = agGrid.createGrid(el, {
        theme: agGrid.themeQuartz ? agGrid.themeQuartz.withParams({ accentColor: '#E8A33D', fontFamily: 'IBM Plex Sans, sans-serif', headerFontWeight: 600, backgroundColor: '#FFFDF8', foregroundColor: '#1B2A41', borderColor: '#E4DCCB' }) : undefined,
        columnDefs,
        rowData: invoices,
        defaultColDef: { sortable: true, resizable: true, filter: true },
        getRowId: (p) => p.data.id,
        animateRows: true,
        overlayNoRowsTemplate: '<span class="muted">No invoices yet. Ask Kaasu to bill a client, or click “Sample data”.</span>',
      });
      $('#grid-search').addEventListener('input', (e) => grid.setGridOption('quickFilterText', e.target.value));
    } else {
      grid.setGridOption('rowData', invoices);
    }
    return;
  }
  // Fallback if the CDN is blocked: a plain table.
  el.style.height = 'auto';
  el.innerHTML = `<table class="fallback"><thead><tr><th>Invoice</th><th>Client</th><th>Amount</th><th>Due</th><th>Status</th><th>Risk</th></tr></thead><tbody>${
    invoices.map((d) => `<tr><td>${esc(d.number)}</td><td>${esc(d.client_name)}</td><td>${money(d.amount, d.currency)}</td><td>${esc(d.due_date)}</td><td>${statusCell({ data: d })}</td><td>${riskCell({ data: d })}</td></tr>`).join('')
  }</tbody></table>`;
}

async function loadInvoices() {
  invoices = await api('/api/invoices');
  renderGrid();
}

async function loadEvents() {
  const ev = await api('/api/events');
  $('#events').innerHTML = ev.length
    ? ev.map((e) => `<li><span>${esc(e.message)}</span><time>${new Date(e.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></li>`).join('')
    : '<li class="muted">Activity from Kaasu and PayPal will show here.</li>';
}

let refreshing = false;
async function refreshAll() {
  if (refreshing) return;
  refreshing = true;
  try { await Promise.all([loadInvoices(), loadInbox(), loadInsights(), loadEvents()]); } catch (e) { console.error(e); } finally { refreshing = false; }
}

// ---------- wire up ----------
$('#chat-form').addEventListener('submit', (e) => { e.preventDefault(); sendChat($('#chat-input').value); });
$('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat($('#chat-input').value); } });
document.querySelectorAll('.chip').forEach((c) => (c.onclick = () => sendChat(c.textContent)));

$('#btn-scan').onclick = (e) => withBusy(e.currentTarget, async () => {
  const made = await api('/api/agent/scan', { method: 'POST' });
  toast(made.length ? `Agent drafted ${made.length} suggestion(s)` : 'Nothing to chase right now');
  await refreshAll();
});
$('#btn-sync').onclick = (e) => withBusy(e.currentTarget, async () => {
  const r = await api('/api/sync', { method: 'POST' });
  toast(r.mode === 'mock' ? 'Mock mode: add PayPal keys to sync' : `Synced ${r.synced} invoices from PayPal`);
  await refreshAll();
});
$('#btn-seed').onclick = (e) => withBusy(e.currentTarget, async () => { await api('/api/demo/seed', { method: 'POST' }); toast('Sample history loaded'); await refreshAll(); });
$('#btn-reset').onclick = (e) => {
  if (!confirm('Clear all local Kaasu data? (Invoices in PayPal are not deleted.)')) return;
  withBusy(e.currentTarget, async () => { await api('/api/demo/reset', { method: 'POST' }); $('#inbox').dataset.ids = ''; toast('Cleared'); await refreshAll(); });
};
$('#btn-insights').onclick = (e) => withBusy(e.currentTarget, () => loadInsights(true));

addMsg('bot', md("Hi! I'm **Kaasu**. Tell me who to bill and I'll draft a PayPal invoice, chase late payers with the right tone, and split payments with collaborators. You approve everything before it happens."));
loadStatus().catch((e) => toast(e.message, true));
refreshAll();
setInterval(refreshAll, 20000);
