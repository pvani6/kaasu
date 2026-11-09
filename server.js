// Kaasu - AI agent that gets freelancers paid.
// Start: npm start   ->   http://localhost:3000
require('dotenv').config(); // must run before the other modules read process.env

const path = require('path');
const express = require('express');
const paypal = require('./src/paypal');
const ai = require('./src/ai');
const agent = require('./src/agent');
const { db, reset, logEvent } = require('./src/db');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// AG Grid is installed by npm and served from node_modules (no CDN needed).
app.use('/vendor', express.static(path.join(__dirname, 'node_modules', 'ag-grid-community', 'dist')));

// Wrap async routes so errors become clean JSON responses.
const h = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error(err);
  res.status(err.status && err.status >= 400 && err.status < 600 ? err.status : 500).json({ error: err.message });
});

app.get('/api/status', (req, res) => {
  res.json({
    paypal: paypal.MODE, // 'sandbox' or 'mock'
    ai: ai.MODE, // 'gemini' or 'fallback'
    model: ai.MODE === 'gemini' ? ai.MODEL : null,
    today: new Date().toISOString().slice(0, 10),
  });
});

app.get('/api/invoices', (req, res) => {
  res.json(db().invoices.map(agent.enrich));
});

app.post('/api/sync', h(async (req, res) => res.json(await agent.syncAll())));

app.get('/api/actions', (req, res) => {
  const status = req.query.status;
  res.json(db().actions.filter((a) => !status || a.status === status).slice(0, 50));
});
app.post('/api/actions/:id/approve', h(async (req, res) => res.json(await agent.executeAction(req.params.id, req.body || {}))));
app.post('/api/actions/:id/reject', h(async (req, res) => res.json(agent.rejectAction(req.params.id))));

app.post('/api/chat', h(async (req, res) => res.json(await agent.chat(req.body.messages))));

app.get('/api/insights', h(async (req, res) => res.json(await agent.insights(req.query.refresh === '1'))));
app.post('/api/agent/scan', h(async (req, res) => res.json(await agent.scan())));
app.get('/api/events', (req, res) => res.json(db().events.slice(0, 40)));

app.post('/api/demo/seed', h(async (req, res) => res.json({ added: agent.seedDemo() })));
app.post('/api/demo/reset', h(async (req, res) => { reset(); res.json({ ok: true }); }));
app.post('/api/demo/simulate-payment/:id', h(async (req, res) => res.json(agent.simulatePayment(req.params.id))));

// PayPal webhook receiver (optional). Point a sandbox webhook to https://<your-app>/api/webhooks/paypal
app.post('/api/webhooks/paypal', h(async (req, res) => res.json(await agent.handleWebhook(req.headers, req.body))));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\n  Kaasu is running:  http://localhost:${PORT}`);
  console.log(`  PayPal: ${paypal.MODE === 'sandbox' ? 'SANDBOX (real PayPal test API)' : 'MOCK (add PAYPAL_CLIENT_ID/SECRET to .env)'}`);
  console.log(`  AI:     ${ai.MODE === 'gemini' ? 'Gemini (' + ai.MODEL + ')' : 'OFFLINE fallback (add GEMINI_API_KEY to .env)'}\n`);
  if (paypal.MODE === 'sandbox') {
    try {
      const r = await agent.syncAll();
      console.log(`  Synced ${r.synced} invoices from PayPal sandbox.`);
    } catch (err) {
      console.error('  PayPal sync failed:', err.message);
      logEvent('error', '⚠️ PayPal sync failed on startup: ' + err.message);
    }
  }
  // The proactive agent: checks for overdue / soon-due invoices on a timer.
  const minutes = Number(process.env.AGENT_SCAN_MINUTES || 30);
  if (minutes > 0) setInterval(() => agent.scan().catch((e) => console.error('scan failed', e.message)), minutes * 60_000);
});
