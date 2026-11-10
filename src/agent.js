// Kaasu's brain: the AI agent, its tools, approvals, risk scoring,
// cash-flow insights and the proactive "payment chaser" scan.

const { db, save, reset, logEvent } = require('./db');
const paypal = require('./paypal');
const ai = require('./ai');

// ---------- small helpers ----------
const DAY = 86_400_000;
const todayStr = () => new Date().toISOString().slice(0, 10);
const addDays = (n) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / DAY);
const uid = (p) => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const fmt = (n, c = 'USD') => {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: c }).format(n); } catch { return c + ' ' + Number(n).toFixed(2); }
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PAID = ['PAID', 'MARKED_AS_PAID'];
const OPEN = ['SENT', 'PARTIALLY_PAID', 'UNPAID', 'PAYMENT_PENDING', 'SCHEDULED'];
const isPaid = (i) => PAID.includes(i.status);
const isOpen = (i) => OPEN.includes(i.status);
const overdueDays = (i) => (isOpen(i) && i.due_date ? daysBetween(i.due_date, todayStr()) : 0);
const displayStatus = (i) => (isOpen(i) && overdueDays(i) > 0 ? 'OVERDUE' : i.status);

// Split rule is stored in the PayPal invoice's private memo so it survives restarts.
const SPLIT_TAG = /kaasu-split:([^\s:]+@[^\s:]+):(\d+(?:\.\d+)?)/;
const parseSplit = (memo) => {
  const m = SPLIT_TAG.exec(memo || '');
  return m ? { email: m[1], percent: parseFloat(m[2]) } : null;
};

// ---------- risk scoring (transparent, explainable) ----------
function clientHistory(email, excludeId) {
  const past = db().invoices.filter((i) => i.client_email === email && i.id !== excludeId && isPaid(i) && i.due_date && i.paid_at);
  const lateDays = past.map((i) => Math.max(0, daysBetween(i.due_date, i.paid_at)));
  const lateCount = lateDays.filter((d) => d > 0).length;
  return {
    count: past.length,
    lateCount,
    lateRatio: past.length ? lateCount / past.length : 0,
    avgDaysLate: lateCount ? Math.round(lateDays.reduce((a, b) => a + b, 0) / lateCount) : 0,
  };
}

function riskOf(inv) {
  if (!isOpen(inv)) return null;
  const h = clientHistory(inv.client_email, inv.id);
  const reasons = [];
  let score = 15;
  if (h.count) {
    score += h.lateRatio * 45;
    if (h.lateCount) reasons.push(`paid ${h.lateCount} of ${h.count} past invoices late (avg ${h.avgDaysLate} days)`);
    else { reasons.push(`paid all ${h.count} past invoices on time`); score -= 5; }
  } else {
    score += 10;
    reasons.push('new client, no payment history');
  }
  const od = overdueDays(inv);
  if (od > 0) { score += Math.min(30, od * 1.5); reasons.push(`${od} days overdue`); }
  if (inv.amount >= 2000) { score += 10; reasons.push('large invoice'); }
  const r = (inv.reminders || []).length;
  if (r >= 2) { score += 8; reasons.push(`${r} reminders sent, still unpaid`); }
  score = Math.max(5, Math.min(98, Math.round(score)));
  return { score, level: score >= 60 ? 'High' : score >= 35 ? 'Medium' : 'Low', reasons };
}

function enrich(inv) {
  return { ...inv, display_status: displayStatus(inv), overdue_days: overdueDays(inv), risk: riskOf(inv) };
}

function brief(inv) {
  const e = enrich(inv);
  return {
    id: e.id, number: e.number, client: e.client_name, email: e.client_email,
    amount: fmt(e.amount, e.currency), status: e.display_status, due_date: e.due_date,
    overdue_days: e.overdue_days > 0 ? e.overdue_days : undefined,
    due_in_days: e.overdue_days < 0 && isOpen(e) ? -e.overdue_days : undefined, reminders_sent: (e.reminders || []).length,
    risk: e.risk ? `${e.risk.level} (${e.risk.score}/100): ${e.risk.reasons.join('; ')}` : undefined,
    split: e.split ? `${e.split.percent}% to ${e.split.email}` : undefined,
    sample_data: e.demo || undefined,
  };
}

function findInvoice(ref) {
  if (!ref) return null;
  const q = String(ref).toLowerCase().trim();
  const all = db().invoices;
  return all.find((i) => i.id.toLowerCase() === q || (i.number || '').toLowerCase() === q)
    || all.find((i) => (i.client_name || '').toLowerCase().includes(q) && isOpen(i))
    || all.find((i) => (i.client_name || '').toLowerCase().includes(q) || (i.client_email || '').toLowerCase().includes(q));
}

// ---------- syncing with PayPal ----------
function upsert(remote) {
  const d = db();
  let local = d.invoices.find((i) => i.id === remote.id);
  let becamePaid = false;
  if (!local) {
    local = { reminders: [], payouts: [], created_at: new Date().toISOString(), ...remote, split: parseSplit(remote.memo) };
    d.invoices.unshift(local);
  } else {
    const wasPaid = isPaid(local);
    const keep = { reminders: local.reminders || [], payouts: local.payouts || [], split: local.split || parseSplit(remote.memo), sent_at: local.sent_at, created_at: local.created_at };
    Object.assign(local, remote, keep);
    if (!wasPaid && isPaid(local)) becamePaid = true;
  }
  if (isPaid(local) && !local.paid_at) local.paid_at = todayStr();
  return { invoice: local, becamePaid };
}

async function syncAll() {
  if (paypal.MODE !== 'sandbox') return { synced: 0, mode: paypal.MODE };
  const remote = await paypal.listInvoices();
  const newlyPaid = [];
  for (const r of remote) {
    const { invoice, becamePaid } = upsert(r);
    if (becamePaid) newlyPaid.push(invoice);
  }
  save();
  for (const inv of newlyPaid) handlePaid(inv);
  return { synced: remote.length, newly_paid: newlyPaid.map((i) => i.number) };
}

async function syncOne(id) {
  if (paypal.MODE !== 'sandbox') return null;
  const r = await paypal.getInvoice(id);
  if (!r) return null;
  const { invoice, becamePaid } = upsert(r);
  save();
  if (becamePaid) handlePaid(invoice);
  return invoice;
}

function handlePaid(inv) {
  logEvent('paid', `💰 ${inv.client_name} paid invoice ${inv.number} (${fmt(inv.amount, inv.currency)})`, { invoice_id: inv.id });
  // Client paid: withdraw any reminders still waiting for approval.
  for (const a of db().actions) {
    if (a.invoice_id === inv.id && a.status === 'pending' && (a.type === 'send_reminder' || a.type === 'record_payment')) {
      a.status = 'rejected';
      a.error = 'Not needed: invoice was paid';
    }
  }
  save();
  if (inv.split && !(inv.payouts || []).length && !hasPending(inv.id, 'payout')) {
    const amount = Math.round(inv.amount * inv.split.percent) / 100;
    createAction('payout', inv.id, { email: inv.split.email, amount, currency: inv.currency, note: `Your ${inv.split.percent}% share of invoice ${inv.number}` },
      `Split ${inv.split.percent}% of ${inv.number}: send ${fmt(amount, inv.currency)} to ${inv.split.email} via PayPal Payouts`);
  }
}

// ---------- approvals (human in the loop) ----------
function hasPending(invoiceId, type) {
  return db().actions.some((a) => a.invoice_id === invoiceId && a.type === type && a.status === 'pending');
}

function createAction(type, invoiceId, payload, summary, source = 'agent') {
  const a = { id: uid('act'), type, invoice_id: invoiceId, payload, summary, status: 'pending', source, created_at: new Date().toISOString() };
  db().actions.unshift(a);
  db().actions = db().actions.slice(0, 300);
  save();
  return a;
}

async function executeAction(id, edits = {}) {
  const a = db().actions.find((x) => x.id === id);
  if (!a) throw new Error('Action not found');
  if (a.status !== 'pending') throw new Error('Action is already ' + a.status);
  // The user may edit an AI-drafted reminder before approving it.
  if (a.type === 'send_reminder') {
    if (typeof edits.subject === 'string' && edits.subject.trim()) a.payload.subject = edits.subject.trim();
    if (typeof edits.message === 'string' && edits.message.trim()) a.payload.message = edits.message.trim();
  }
  const inv = db().invoices.find((i) => i.id === a.invoice_id);
  if (!inv) throw new Error('Invoice not found');
  const live = paypal.MODE === 'sandbox' && !inv.demo; // demo/sample invoices never hit PayPal invoicing
  try {
    if (a.type === 'send_invoice') {
      if (live) await paypal.sendInvoice(inv.id);
      inv.status = 'SENT';
      inv.sent_at = new Date().toISOString();
      if (live) await syncOne(inv.id).catch(() => {});
      logEvent('sent', `📤 Sent invoice ${inv.number} to ${inv.client_name} (${fmt(inv.amount, inv.currency)})`, { invoice_id: inv.id });
    } else if (a.type === 'send_reminder') {
      if (!isOpen(inv)) throw new Error(`Invoice is ${inv.status}, no reminder needed.`);
      if (live) await paypal.remindInvoice(inv.id, a.payload.subject, a.payload.message);
      inv.reminders = inv.reminders || [];
      inv.reminders.push({ at: new Date().toISOString(), tone: a.payload.tone, subject: a.payload.subject });
      logEvent('reminder', `🔔 ${a.payload.tone} reminder sent for ${inv.number} to ${inv.client_name}`, { invoice_id: inv.id });
    } else if (a.type === 'payout') {
      if (!isPaid(inv)) throw new Error('Invoice is not paid yet, so there is nothing to split.');
      const already = (inv.payouts || []).reduce((s, p) => s + p.amount, 0);
      if (already + a.payload.amount > inv.amount + 0.001) throw new Error('Payout would exceed the invoice amount.');
      // Payouts always go through PayPal in sandbox mode (sandbox money only).
      const res = await paypal.sendPayout(a.payload);
      inv.payouts = inv.payouts || [];
      inv.payouts.push({ at: new Date().toISOString(), email: a.payload.email, amount: a.payload.amount, batch_id: res.batch_id, status: res.status });
      logEvent('payout', `💸 Paid ${fmt(a.payload.amount, a.payload.currency)} to ${a.payload.email} (PayPal batch ${res.batch_id})`, { invoice_id: inv.id });
    } else if (a.type === 'record_payment') {
      if (live) await paypal.recordPayment(inv.id, inv.due_amount || inv.amount, inv.currency, a.payload.method);
      if (live) await syncOne(inv.id).catch(() => {});
      if (!isPaid(inv)) { inv.status = 'MARKED_AS_PAID'; inv.paid_at = todayStr(); inv.due_amount = 0; handlePaid(inv); }
    } else {
      throw new Error('Unknown action type ' + a.type);
    }
    a.status = 'done';
    a.done_at = new Date().toISOString();
    save();
    return a;
  } catch (err) {
    a.status = 'failed';
    a.error = err.message;
    save();
    logEvent('error', `⚠️ ${a.summary} failed: ${err.message}`, { invoice_id: inv.id });
    throw err;
  }
}

function rejectAction(id) {
  const a = db().actions.find((x) => x.id === id);
  if (!a) throw new Error('Action not found');
  if (a.status !== 'pending') throw new Error('Action is already ' + a.status);
  a.status = 'rejected';
  save();
  return a;
}

// ---------- date parsing for the fallback (no-AI) mode ----------
function parseDue(text) {
  const t = (text || '').toLowerCase();
  let m = t.match(/(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  m = t.match(/in (\d+) days?/);
  if (m) return addDays(parseInt(m[1], 10));
  if (/tomorrow/.test(t)) return addDays(1);
  if (/next week/.test(t)) return addDays(7);
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (let d = 0; d < 7; d++) {
    if (t.includes(days[d])) {
      const diff = (d - new Date().getUTCDay() + 7) % 7 || 7;
      return addDays(diff);
    }
  }
  return null;
}

// ---------- the tools the AI agent can call ----------
const TOOLS = [
  {
    name: 'create_invoice',
    description: 'Create a PayPal invoice as a DRAFT. Nothing is sent to the client until the user approves the queued "send" action. Ask the user for the client email if it is missing.',
    parameters: {
      type: 'OBJECT',
      properties: {
        client_name: { type: 'STRING', description: 'Client full name or company' },
        client_email: { type: 'STRING', description: 'Client email address' },
        items: {
          type: 'ARRAY',
          description: 'Line items',
          items: { type: 'OBJECT', properties: { description: { type: 'STRING' }, amount: { type: 'NUMBER' } }, required: ['description', 'amount'] },
        },
        currency: { type: 'STRING', description: 'ISO currency code, default USD' },
        due_date: { type: 'STRING', description: 'Due date YYYY-MM-DD (today or later). Default: 14 days from today.' },
        note: { type: 'STRING', description: 'Short friendly note shown to the client' },
        split_with_email: { type: 'STRING', description: 'Optional collaborator email who gets a share when the client pays' },
        split_percent: { type: 'NUMBER', description: 'Optional collaborator share in percent (1-90)' },
      },
      required: ['client_name', 'client_email', 'items'],
    },
  },
  {
    name: 'list_invoices',
    description: 'List invoices with status, due date, risk score and reminders. Use to answer "who owes me", "what is overdue", etc.',
    parameters: { type: 'OBJECT', properties: { status: { type: 'STRING', description: 'ALL, OPEN, OVERDUE, PAID or DRAFT. Default OPEN.' } } },
  },
  {
    name: 'find_invoice',
    description: 'Find one invoice by invoice number, id, client name or email.',
    parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' } }, required: ['query'] },
  },
  {
    name: 'sync_with_paypal',
    description: 'Refresh all invoice statuses from PayPal (e.g. to check if a client has paid).',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'propose_reminder',
    description: 'Queue a payment reminder for an open invoice. YOU write the subject and message. Tone: friendly (first nudge / not yet due), firm (overdue), final (long overdue, mentions next steps politely). The user must approve before PayPal sends it.',
    parameters: {
      type: 'OBJECT',
      properties: {
        invoice_id: { type: 'STRING' },
        tone: { type: 'STRING', description: 'friendly, firm or final' },
        subject: { type: 'STRING' },
        message: { type: 'STRING', description: 'Reminder body, under 90 words, warm and professional, mention amount, invoice number and due date' },
      },
      required: ['invoice_id', 'tone', 'subject', 'message'],
    },
  },
  {
    name: 'propose_payout',
    description: 'Queue a PayPal Payout to a collaborator from a PAID invoice (revenue split). Give percent or amount. Needs user approval.',
    parameters: {
      type: 'OBJECT',
      properties: {
        invoice_id: { type: 'STRING' },
        recipient_email: { type: 'STRING' },
        percent: { type: 'NUMBER' },
        amount: { type: 'NUMBER' },
        note: { type: 'STRING' },
      },
      required: ['invoice_id', 'recipient_email'],
    },
  },
  {
    name: 'propose_mark_paid',
    description: 'Queue recording an offline payment (bank transfer, cash) against an invoice in PayPal. Needs user approval.',
    parameters: {
      type: 'OBJECT',
      properties: { invoice_id: { type: 'STRING' }, method: { type: 'STRING', description: 'BANK_TRANSFER, CASH, CHECK or OTHER' } },
      required: ['invoice_id'],
    },
  },
  {
    name: 'get_cashflow_insights',
    description: 'Get numbers: outstanding, overdue, paid in last 30 days, expected next 30 days (risk-weighted), average days to pay, riskiest clients.',
    parameters: { type: 'OBJECT', properties: {} },
  },
];

async function runTool(name, args, created) {
  args = args || {};
  switch (name) {
    case 'create_invoice': {
      const email = String(args.client_email || '').trim();
      if (!EMAIL_RE.test(email)) return { error: 'A valid client email is required. Ask the user for it.' };
      const items = (args.items || []).map((i) => ({ description: String(i.description || 'Service'), amount: Number(i.amount) })).filter((i) => i.amount > 0);
      if (!items.length) return { error: 'At least one item with a positive amount is required.' };
      if (items.some((i) => i.amount >= 1000000)) return { error: 'That amount looks wrong (over 1,000,000). Please check the amount and try again.' };
      const currency = String(args.currency || 'USD').toUpperCase().slice(0, 3);
      let due = /^\d{4}-\d{2}-\d{2}$/.test(args.due_date || '') ? args.due_date : addDays(14);
      if (due < todayStr()) due = todayStr();
      let split = null;
      if (args.split_with_email && EMAIL_RE.test(args.split_with_email) && args.split_percent > 0 && args.split_percent <= 90) {
        split = { email: args.split_with_email.trim(), percent: Number(args.split_percent) };
      }
      const memo = split ? `kaasu-split:${split.email}:${split.percent}` : '';
      const remote = await paypal.createDraftInvoice({ client_name: args.client_name, client_email: email, items, currency, due_date: due, note: args.note, memo });
      const { invoice } = upsert({ ...remote, client_name: remote.client_name || args.client_name, client_email: remote.client_email || email });
      invoice.split = split;
      invoice.source = 'kaasu';
      save();
      logEvent('draft', `📝 Drafted invoice ${invoice.number} for ${invoice.client_name} (${fmt(invoice.amount, currency)}) in PayPal`, { invoice_id: invoice.id });
      const action = createAction('send_invoice', invoice.id, {}, `Send invoice ${invoice.number} (${fmt(invoice.amount, currency)}, due ${due}) to ${invoice.client_name} <${email}>${split ? ` · auto-split ${split.percent}% to ${split.email} when paid` : ''}`);
      created.push(action);
      return { ok: true, invoice: brief(invoice), status: 'Draft created in PayPal. A "Send invoice" approval card is now shown to the user; it is NOT sent yet.' };
    }
    case 'list_invoices': {
      const s = String(args.status || 'OPEN').toUpperCase();
      let list = db().invoices.filter((i) => i.status !== 'CANCELLED');
      if (s === 'OPEN') list = list.filter(isOpen);
      else if (s === 'OVERDUE') list = list.filter((i) => overdueDays(i) > 0);
      else if (s === 'PAID') list = list.filter(isPaid);
      else if (s === 'DRAFT') list = list.filter((i) => i.status === 'DRAFT');
      return { count: list.length, invoices: list.slice(0, 25).map(brief) };
    }
    case 'find_invoice': {
      const inv = findInvoice(args.query);
      return inv ? { invoice: brief(inv) } : { error: 'No invoice matches "' + args.query + '"' };
    }
    case 'sync_with_paypal':
      return await syncAll();
    case 'propose_reminder': {
      const inv = findInvoice(args.invoice_id);
      if (!inv) return { error: 'Invoice not found' };
      if (!isOpen(inv)) return { error: `Invoice ${inv.number} is ${inv.status}; reminders only work for sent, unpaid invoices.` };
      if (hasPending(inv.id, 'send_reminder')) return { error: 'A reminder for this invoice is already waiting for approval.' };
      const tone = ['friendly', 'firm', 'final'].includes(args.tone) ? args.tone : 'friendly';
      const action = createAction('send_reminder', inv.id, { tone, subject: args.subject, message: args.message }, `${cap(tone)} reminder to ${inv.client_name} for ${inv.number} (${fmt(inv.due_amount ?? inv.amount, inv.currency)})`);
      created.push(action);
      return { ok: true, status: 'Reminder queued for user approval.' };
    }
    case 'propose_payout': {
      const inv = findInvoice(args.invoice_id);
      if (!inv) return { error: 'Invoice not found' };
      if (!isPaid(inv)) return { error: `Invoice ${inv.number} is not paid yet (${displayStatus(inv)}). Payouts can only split money that has arrived.` };
      if (!EMAIL_RE.test(args.recipient_email || '')) return { error: 'Valid recipient email required' };
      let amount = args.amount ? Number(args.amount) : args.percent ? Math.round(inv.amount * Number(args.percent)) / 100 : 0;
      if (!(amount > 0)) return { error: 'Give a percent or an amount.' };
      if (amount > inv.amount) return { error: 'Amount exceeds invoice total.' };
      const action = createAction('payout', inv.id, { email: args.recipient_email, amount, currency: inv.currency, note: args.note || `Your share of invoice ${inv.number}` }, `Send ${fmt(amount, inv.currency)} to ${args.recipient_email} from ${inv.number} via PayPal Payouts`);
      created.push(action);
      return { ok: true, status: 'Payout queued for user approval.' };
    }
    case 'propose_mark_paid': {
      const inv = findInvoice(args.invoice_id);
      if (!inv) return { error: 'Invoice not found' };
      if (!isOpen(inv)) return { error: `Invoice ${inv.number} is ${inv.status}.` };
      const method = ['BANK_TRANSFER', 'CASH', 'CHECK', 'OTHER'].includes(args.method) ? args.method : 'BANK_TRANSFER';
      const action = createAction('record_payment', inv.id, { method }, `Record ${fmt(inv.due_amount ?? inv.amount, inv.currency)} ${method.replace('_', ' ').toLowerCase()} payment for ${inv.number} (${inv.client_name})`);
      created.push(action);
      return { ok: true, status: 'Queued for user approval.' };
    }
    case 'get_cashflow_insights':
      return stats();
    default:
      return { error: 'Unknown tool ' + name };
  }
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function systemPrompt() {
  return `You are Kaasu, an AI accounts-receivable agent for freelancers and small businesses. You help them get paid on time using PayPal.
Today is ${todayStr()} (${new Date().toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })}).
Rules:
- Use tools for every fact about invoices; never invent invoice data.
- create_invoice only makes a PayPal DRAFT and queues a "Send" approval card. Never say an invoice was sent until the user approves it.
- Every action that emails a client or moves money (send, remind, payout, mark paid) needs the user's click on the approval card. Say so briefly.
- If the client email is missing, ask for it before creating the invoice.
- Convert relative dates ("Friday", "in 10 days") to YYYY-MM-DD. Default currency USD, default due date 14 days.
- When asked to chase/follow up, list overdue or soon-due invoices and call propose_reminder for each, choosing tone from overdue days and reminders already sent, and the client's risk.
- Explain risk scores in plain words using the reasons provided.
- Keep replies short and friendly: 1-4 sentences or a short bullet list. Use **bold** for amounts and invoice numbers.`;
}

// ---------- chat entry point ----------
async function chat(messages) {
  const created = [];
  const history = (messages || []).filter((m) => m && m.text).slice(-12);
  while (history.length && history[0].role !== 'user') history.shift();
  if (!history.length) return { reply: 'Say hi or ask me to create an invoice!', actions: [] };
  const lastUser = history[history.length - 1].text;

  if (ai.MODE !== 'gemini') {
    return fallbackChat(lastUser, created, 'AI is in offline mode (no GEMINI_API_KEY), using simple commands.');
  }

  const contents = history.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] }));
  try {
    for (let step = 0; step < 6; step++) {
      const content = await ai.generate({ system: systemPrompt(), contents, tools: TOOLS, temperature: 0.3 });
      contents.push(content);
      const calls = (content.parts || []).filter((p) => p.functionCall);
      if (!calls.length) {
        return { reply: ai.textOf(content) || 'Done.', actions: created, tools_used: step };
      }
      const responses = [];
      for (const c of calls) {
        let result;
        try { result = await runTool(c.functionCall.name, c.functionCall.args, created); } catch (err) { result = { error: err.message }; }
        responses.push({ functionResponse: { name: c.functionCall.name, response: { result } } });
      }
      contents.push({ role: 'user', parts: responses });
    }
    return { reply: 'I did several steps; check the approval cards on the right.', actions: created };
  } catch (err) {
    if (err instanceof ai.AIError) {
      return fallbackChat(lastUser, created, err.message + ' Using simple commands instead.');
    }
    throw err;
  }
}

// Simple rule-based mode so the app still works if the AI is unavailable.
async function fallbackChat(text, created, notice) {
  const t = text.toLowerCase();
  let reply;
  if (/\b(invoice|bill)\b/.test(t) && /\d/.test(t)) {
    const email = (text.match(/[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/i) || [])[0];
    // Ignore digits inside the email (e.g. sb-abc123@...) and prefer an amount with a currency sign.
    const noEmail = email ? text.replace(email, ' ') : text;
    const amt = noEmail.match(/(?:\$|usd\s?|€|eur\s?|£|gbp\s?|₹|inr\s?)(\d[\d,]*(?:\.\d{1,2})?)/i)
      || noEmail.match(/\b(\d[\d,]*(?:\.\d{1,2})?)\b(?!\s*(?:%|days?|weeks?))/i);
    const currency = /€|eur/i.test(text) ? 'EUR' : /£|gbp/i.test(text) ? 'GBP' : /₹|inr/i.test(text) ? 'INR' : 'USD';
    const nameMatch = text.match(/\b(?:invoice|bill)\s+(.+?)(?=\s+[^\s@]+@|\s+(?:\$|usd|€|eur|£|gbp|₹|inr)?\s?\d|\s+for\s|$)/i);
    const descMatch = text.match(/\bfor\s+(.+?)(?=,?\s+(?:due|split|give)\b|,|$)/i);
    const splitMatch = noEmail.match(/(\d{1,2})\s*%/);
    const splitEmail = (text.replace(email || '', ' ').match(/[^\s@<>(),]+@[^\s@<>(),]+\.[a-z]{2,}/i) || [])[0];
    if (!email) {
      reply = 'Please include the client email, e.g. **Bill John Doe john@client.com $400 for logo design due Friday**.';
    } else {
      const res = await runTool('create_invoice', {
        client_name: nameMatch ? nameMatch[1].replace(/[,.]$/, '') : email.split('@')[0],
        client_email: email,
        items: [{ description: descMatch ? descMatch[1] : 'Professional services', amount: parseFloat((amt ? amt[1] : '0').replace(/,/g, '')) }],
        currency,
        due_date: parseDue(text) || undefined,
        split_with_email: splitMatch && splitEmail ? splitEmail : undefined,
        split_percent: splitMatch && splitEmail ? Number(splitMatch[1]) : undefined,
      }, created);
      reply = res.error ? res.error : `Drafted **${res.invoice.number}** for ${res.invoice.client}: **${res.invoice.amount}**, due ${res.invoice.due_date}. Approve the card to send it through PayPal.`;
    }
  } else if (/(chase|remind|follow)/.test(t)) {
    const made = await scan();
    created.push(...made);
    reply = made.length ? `I drafted ${made.length} reminder(s). Review and approve them.` : 'Nothing needs chasing right now. 🎉';
  } else if (/(cash|insight|summary|how am i|forecast)/.test(t)) {
    const s = stats();
    reply = `Outstanding **${fmt(s.outstanding)}**, overdue **${fmt(s.overdue_amount)}** (${s.overdue_count} invoices), paid last 30 days **${fmt(s.paid_last_30_days)}**, expected next 30 days **${fmt(s.expected_next_30_days)}**.`;
  } else if (/sync|refresh/.test(t)) {
    const r = await syncAll();
    reply = `Synced ${r.synced} invoices from PayPal.`;
  } else if (/(owe|unpaid|outstanding|overdue|list|show|open)/.test(t)) {
    const open = db().invoices.filter(isOpen).map(brief);
    reply = open.length ? open.map((i) => `• **${i.number}** ${i.client}: ${i.amount}, ${i.status}${i.overdue_days ? ` (${i.overdue_days}d late)` : ''}`).join('\n') : 'No open invoices.';
  } else {
    reply = 'Try: **Bill Jane jane@acme.com $400 for logo design due Friday**, **who owes me?**, **chase overdue invoices**, or **cash flow summary**.';
  }
  return { reply, actions: created, notice };
}

// ---------- cash-flow numbers ----------
function stats() {
  const all = db().invoices.filter((i) => i.status !== 'CANCELLED');
  const open = all.filter(isOpen);
  const today = todayStr();
  const due = (i) => (i.due_amount ?? i.amount);
  const overdue = open.filter((i) => overdueDays(i) > 0);
  const paid30 = all.filter((i) => isPaid(i) && i.paid_at && daysBetween(i.paid_at, today) <= 30);
  const expected = open
    .filter((i) => !i.due_date || daysBetween(today, i.due_date) <= 30)
    .reduce((s, i) => s + due(i) * (1 - ((riskOf(i) || { score: 0 }).score / 100)), 0);
  const paidWithDates = all.filter((i) => isPaid(i) && i.paid_at && (i.invoice_date || i.sent_at));
  const avgDaysToPay = paidWithDates.length
    ? Math.round(paidWithDates.reduce((s, i) => s + Math.max(0, daysBetween(i.invoice_date || i.sent_at, i.paid_at)), 0) / paidWithDates.length)
    : null;
  const lateRate = all.filter((i) => isPaid(i) && i.paid_at && i.due_date);
  return {
    currency_note: 'Amounts summed in USD-equivalent display; mixed currencies are added at face value.',
    outstanding: round2(open.reduce((s, i) => s + due(i), 0)),
    open_count: open.length,
    overdue_amount: round2(overdue.reduce((s, i) => s + due(i), 0)),
    overdue_count: overdue.length,
    paid_last_30_days: round2(paid30.reduce((s, i) => s + i.amount, 0)),
    expected_next_30_days: round2(expected),
    avg_days_to_pay: avgDaysToPay,
    late_payment_rate_pct: lateRate.length ? Math.round((lateRate.filter((i) => daysBetween(i.due_date, i.paid_at) > 0).length / lateRate.length) * 100) : null,
    riskiest_open: open.map(enrich).filter((i) => i.risk).sort((a, b) => b.risk.score - a.risk.score).slice(0, 3)
      .map((i) => ({ number: i.number, client: i.client_name, amount: fmt(due(i), i.currency), risk: i.risk.level + ' ' + i.risk.score, why: i.risk.reasons.join('; ') })),
    drafts_not_sent: all.filter((i) => i.status === 'DRAFT').length,
  };
}
const round2 = (n) => Math.round(n * 100) / 100;

let insightCache = { key: '', at: 0, data: null };
async function insights(force = false) {
  const s = stats();
  const key = JSON.stringify(s);
  // Reuse the last answer until the numbers change, so the dashboard's auto-refresh doesn't use up Gemini's free quota.
  if (!force && insightCache.data && insightCache.key === key && (insightCache.data.source === 'gemini' || Date.now() - insightCache.at < 2 * 60_000)) return insightCache.data;
  let bullets = null;
  let source = 'rules';
  if (ai.MODE === 'gemini') {
    try {
      const text = await ai.generateText(
        `Here are a freelancer's receivables numbers as JSON:\n${key}\n\nWrite exactly 3 short, specific, actionable insights (max 22 words each) as lines starting with "- ". Mention client names and amounts where useful. No intro text.`,
        'You are a friendly, sharp cash-flow advisor for freelancers.', 0.5);
      bullets = text.split('\n').map((l) => l.replace(/^[-*•\d.\s]+/, '').trim()).filter(Boolean).slice(0, 3);
      if (bullets.length) source = 'gemini';
    } catch { bullets = null; }
  }
  if (!bullets || !bullets.length) {
    bullets = [];
    if (s.overdue_count) bullets.push(`${s.overdue_count} invoice(s) overdue worth ${fmt(s.overdue_amount)}. Run the agent scan to draft reminders.`);
    if (s.riskiest_open[0]) bullets.push(`Highest risk: ${s.riskiest_open[0].client} (${s.riskiest_open[0].amount}): ${s.riskiest_open[0].why}.`);
    bullets.push(`Expect about ${fmt(s.expected_next_30_days)} in the next 30 days (risk-weighted).`);
    if (s.drafts_not_sent) bullets.push(`${s.drafts_not_sent} draft(s) not sent yet.`);
    bullets = bullets.slice(0, 3);
  }
  insightCache = { key, at: Date.now(), data: { stats: s, bullets, source } };
  return insightCache.data;
}

// ---------- proactive agent: the payment chaser ----------
async function draftReminder(inv, tone) {
  const e = enrich(inv);
  const fallback = {
    subject: tone === 'friendly' ? `Friendly reminder: invoice ${inv.number}` : tone === 'firm' ? `Overdue: invoice ${inv.number}` : `Final reminder: invoice ${inv.number}`,
    message: tone === 'friendly'
      ? `Hi ${inv.client_name}, just a quick reminder that invoice ${inv.number} for ${fmt(e.due_amount ?? e.amount, inv.currency)} is due on ${inv.due_date}. You can pay securely with PayPal using the invoice link. Thanks!`
      : tone === 'firm'
        ? `Hi ${inv.client_name}, invoice ${inv.number} for ${fmt(e.due_amount ?? e.amount, inv.currency)} was due on ${inv.due_date} and is now ${e.overdue_days} days overdue. Could you arrange payment via the PayPal link this week? Thank you.`
        : `Hi ${inv.client_name}, this is a final reminder that invoice ${inv.number} (${fmt(e.due_amount ?? e.amount, inv.currency)}) is ${e.overdue_days} days overdue. Please pay via the PayPal link or reply with a payment date so we can avoid further follow-up.`,
  };
  if (ai.MODE !== 'gemini') return fallback;
  try {
    const text = await ai.generateText(
      `Write a ${tone} payment reminder email.\nClient: ${inv.client_name}\nInvoice: ${inv.number}\nAmount due: ${fmt(e.due_amount ?? e.amount, inv.currency)}\nDue date: ${inv.due_date}\nDays overdue: ${e.overdue_days}\nReminders already sent: ${(inv.reminders || []).length}\nClient payment history: ${e.risk ? e.risk.reasons.join('; ') : 'n/a'}\n\nRules: under 80 words, warm and professional, mention they can pay with the PayPal invoice link, no placeholders like [Your Name].\nReturn ONLY JSON: {"subject": "...", "message": "..."}`,
      'You write short, effective, polite payment reminders that preserve client relationships.', 0.6);
    const json = JSON.parse((text.match(/\{[\s\S]*\}/) || ['{}'])[0]);
    if (json.subject && json.message) return { subject: json.subject, message: json.message };
  } catch { /* use fallback */ }
  return fallback;
}

let scanning = false;
async function scan() {
  if (scanning) return [];
  scanning = true;
  const created = [];
  try {
    if (paypal.MODE === 'sandbox') await syncAll().catch((e) => logEvent('error', '⚠️ Sync failed: ' + e.message));
    for (const inv of db().invoices.filter(isOpen)) {
      const od = overdueDays(inv);
      const dueIn = inv.due_date ? -od : 99;
      if (!(od > 0 || (dueIn >= 0 && dueIn <= 2))) continue;
      if (hasPending(inv.id, 'send_reminder')) continue;
      const last = (inv.reminders || []).slice(-1)[0];
      if (last && daysBetween(last.at, new Date().toISOString()) < 3) continue;
      const n = (inv.reminders || []).length;
      const tone = od <= 0 ? 'friendly' : n >= 2 || od > 21 ? 'final' : n >= 1 || od > 7 ? 'firm' : 'friendly';
      const draft = await draftReminder(inv, tone);
      const why = od > 0 ? `${od} days overdue` : dueIn === 0 ? 'due today' : `due in ${dueIn} day(s)`;
      created.push(createAction('send_reminder', inv.id, { tone, ...draft }, `${cap(tone)} reminder to ${inv.client_name} for ${inv.number} (${fmt(inv.due_amount ?? inv.amount, inv.currency)}, ${why})`, 'scan'));
    }
    // Note: split payouts are only proposed at the moment an invoice turns PAID (see handlePaid),
    // never re-proposed later, so a collaborator can't be paid twice after a reset or restart.
    logEvent('scan', `🤖 Agent scan finished: ${created.length} new suggestion(s)`);
  } finally {
    scanning = false;
  }
  return created;
}

// ---------- sample data so the dashboard is not empty in a demo ----------
function seedDemo() {
  const d = db();
  d.invoices = d.invoices.filter((i) => !i.demo);
  d.actions = d.actions.filter((a) => !String(a.invoice_id).startsWith('DEMO-'));
  const mk = (n, name, email, desc, amount, issuedAgo, dueAgo, paidAgo, reminders = 0) => ({
    id: 'DEMO-' + n, number: 'S-' + n, demo: true, client_name: name, client_email: email, currency: 'USD',
    items: [{ description: desc, amount }], amount, due_amount: paidAgo == null ? amount : 0,
    invoice_date: addDays(-issuedAgo), sent_at: addDays(-issuedAgo), due_date: addDays(-dueAgo),
    status: paidAgo == null ? 'SENT' : 'PAID', paid_at: paidAgo == null ? null : addDays(-paidAgo),
    reminders: Array.from({ length: reminders }, (_, k) => ({ at: addDays(-(dueAgo - 5 - k * 5 > 0 ? dueAgo - 5 - k * 5 : 1)), tone: k ? 'firm' : 'friendly', subject: 'Reminder' })),
    payouts: [], split: null, created_at: addDays(-issuedAgo),
  });
  const sample = [
    // Northwind Studio: pays late regularly
    mk('1001', 'Northwind Studio', 'ap@northwind.example', 'Brand identity package', 1800, 120, 106, 88),
    mk('1002', 'Northwind Studio', 'ap@northwind.example', 'Website landing page', 1200, 80, 66, 47),
    mk('1003', 'Northwind Studio', 'ap@northwind.example', 'Social media kit', 950, 40, 26, null, 1),
    // Bella Bakery: always on time
    mk('1004', 'Bella Bakery', 'owner@bellabakery.example', 'Menu design', 300, 70, 56, 58),
    mk('1005', 'Bella Bakery', 'owner@bellabakery.example', 'Instagram posts (May)', 250, 35, 21, 22),
    mk('1006', 'Bella Bakery', 'owner@bellabakery.example', 'Instagram posts (June)', 250, 10, -4, null),
    // Orbit Apps: big client, slow payer
    mk('1007', 'Orbit Apps Inc', 'finance@orbitapps.example', 'Mobile app UI (phase 1)', 4200, 95, 81, 60),
    mk('1008', 'Orbit Apps Inc', 'finance@orbitapps.example', 'Mobile app UI (phase 2)', 3800, 30, 9, null),
    // New client, due soon
    mk('1009', 'Leo Martins', 'leo@martins.example', 'Podcast cover art', 180, 12, -1, null),
  ];
  d.invoices.push(...sample);
  save();
  logEvent('demo', '🧪 Loaded sample invoice history (marked as SAMPLE, never sent to PayPal)');
  return sample.length;
}

function simulatePayment(id) {
  const inv = db().invoices.find((i) => i.id === id);
  if (!inv) throw new Error('Invoice not found');
  if (!(inv.demo || paypal.MODE === 'mock')) throw new Error('Only sample/mock invoices can be simulated. Pay real sandbox invoices with your PayPal sandbox buyer account.');
  if (!isOpen(inv)) throw new Error('Invoice is ' + inv.status);
  inv.status = 'PAID';
  inv.paid_at = todayStr();
  inv.due_amount = 0;
  save();
  handlePaid(inv);
  return inv;
}

async function handleWebhook(headers, event) {
  const v = await paypal.verifyWebhook(headers, event).catch(() => ({ verified: false }));
  if (process.env.PAYPAL_WEBHOOK_ID && !v.verified) return { ok: false, reason: 'signature not verified' };
  const type = event && event.event_type;
  const id = event && event.resource && (event.resource.invoice ? event.resource.invoice.id : event.resource.id);
  logEvent('webhook', `🔗 PayPal webhook: ${type}`);
  if (type && type.startsWith('INVOICING.') && id) await syncOne(id).catch(() => {});
  return { ok: true };
}

module.exports = {
  TOOLS, chat, runTool, stats, insights, scan, syncAll, syncOne, executeAction, rejectAction,
  seedDemo, simulatePayment, handleWebhook, enrich, reset,
};
