// PayPal REST client (sandbox by default).
// Uses: OAuth2, Invoicing v2 (create / send / remind / record payment / get / list),
// Payouts v1, and Webhook signature verification.
// If no PayPal keys are set, Kaasu runs in MOCK mode so the app still works.

const CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const BASE = process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';
const MODE = CLIENT_ID && CLIENT_SECRET ? 'sandbox' : 'mock';

class PayPalError extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
  }
}

let accessToken = null;
let tokenExpiresAt = 0;

async function getToken() {
  if (accessToken && Date.now() < tokenExpiresAt - 60_000) return accessToken;
  const res = await fetch(BASE + '/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new PayPalError('PayPal login failed: ' + (json.error_description || res.status) + '. Check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET.', json);
  accessToken = json.access_token;
  tokenExpiresAt = Date.now() + json.expires_in * 1000;
  return accessToken;
}

async function call(method, path, body) {
  const token = await getToken();
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = (json && (json.message || json.error_description || json.name)) || '';
    const detail = json && Array.isArray(json.details)
      ? json.details.map((d) => d.issue + (d.description ? ': ' + d.description : '')).join('; ')
      : '';
    throw new PayPalError(`PayPal ${method} ${path} failed (${res.status}) ${msg} ${detail}`.trim(), json);
  }
  return json;
}

const money = (v) => Number(v).toFixed(2);

// ---------- Mapping PayPal invoice -> Kaasu invoice ----------
function fromPayPal(pi) {
  const d = pi.detail || {};
  const bill = ((pi.primary_recipients || [])[0] || {}).billing_info || {};
  const name = [bill.name && bill.name.given_name, bill.name && bill.name.surname].filter(Boolean).join(' ');
  const amount = parseFloat((pi.amount && pi.amount.value) || 0);
  const txs = (pi.payments && pi.payments.transactions) || [];
  return {
    id: pi.id,
    number: d.invoice_number || '',
    status: pi.status,
    currency: d.currency_code || (pi.amount && pi.amount.currency_code) || 'USD',
    amount,
    due_amount: pi.due_amount ? parseFloat(pi.due_amount.value) : amount,
    client_name: name || bill.business_name || '',
    client_email: bill.email_address || '',
    due_date: (d.payment_term && d.payment_term.due_date) || null,
    invoice_date: d.invoice_date || null,
    items: (pi.items || []).map((i) => ({
      description: i.name,
      amount: parseFloat((i.unit_amount && i.unit_amount.value) || 0) * parseFloat(i.quantity || 1),
    })),
    view_url: (d.metadata && d.metadata.recipient_view_url) || null,
    memo: d.memo || '',
    note: d.note || '',
    paid_at: txs.length ? txs[txs.length - 1].payment_date : null,
  };
}

// ---------- Invoicing ----------
async function createDraftInvoice({ client_name, client_email, items, currency, due_date, note, memo }) {
  const [given, ...rest] = String(client_name || 'Client').trim().split(/\s+/);
  const body = {
    detail: {
      currency_code: currency,
      note: note || 'Thank you for your business!',
      memo: memo || undefined,
      payment_term: due_date ? { due_date } : undefined,
    },
    invoicer: process.env.INVOICER_NAME ? { name: { given_name: process.env.INVOICER_NAME } } : undefined,
    primary_recipients: [
      { billing_info: { name: { given_name: given, surname: rest.join(' ') || undefined }, email_address: client_email } },
    ],
    items: items.map((i) => ({
      name: String(i.description || 'Service').slice(0, 200),
      quantity: '1',
      unit_amount: { currency_code: currency, value: money(i.amount) },
    })),
  };
  if (MODE === 'mock') {
    const id = 'MOCK-INV-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    return {
      id, number: 'K-' + Date.now().toString().slice(-6), status: 'DRAFT', currency,
      amount: items.reduce((s, i) => s + Number(i.amount), 0), client_name, client_email,
      due_date, items, view_url: null, memo: memo || '', note: body.detail.note,
    };
  }
  const created = await call('POST', '/v2/invoicing/invoices', body);
  // Some API versions return only a link; fetch the full invoice in that case.
  if (created && created.id) return fromPayPal(created);
  const href = created && created.href;
  const id = href ? href.split('/').pop() : null;
  if (!id) throw new PayPalError('PayPal did not return an invoice id', created);
  return getInvoice(id);
}

async function sendInvoice(id) {
  if (MODE === 'mock') return { ok: true };
  await call('POST', `/v2/invoicing/invoices/${id}/send`, { send_to_invoicer: true, send_to_recipient: true });
  return { ok: true };
}

async function remindInvoice(id, subject, note) {
  if (MODE === 'mock') return { ok: true };
  await call('POST', `/v2/invoicing/invoices/${id}/remind`, {
    subject: String(subject || 'Payment reminder').slice(0, 100),
    note: String(note || '').slice(0, 4000),
    send_to_invoicer: false,
    send_to_recipient: true,
  });
  return { ok: true };
}

async function recordPayment(id, amount, currency, method = 'BANK_TRANSFER') {
  if (MODE === 'mock') return { payment_id: 'MOCK-PAY-' + Date.now() };
  const today = new Date().toISOString().slice(0, 10);
  return call('POST', `/v2/invoicing/invoices/${id}/payments`, {
    method, payment_date: today, amount: { currency_code: currency, value: money(amount) },
  });
}

async function getInvoice(id) {
  if (MODE === 'mock') return null;
  return fromPayPal(await call('GET', `/v2/invoicing/invoices/${id}`));
}

async function listInvoices() {
  if (MODE === 'mock') return [];
  const json = await call('GET', '/v2/invoicing/invoices?page=1&page_size=50&total_required=false');
  return (json.items || []).map(fromPayPal);
}

// ---------- Payouts ----------
async function sendPayout({ email, amount, currency, note }) {
  if (MODE === 'mock') return { batch_id: 'MOCK-BATCH-' + Date.now(), status: 'SUCCESS' };
  const batchId = 'kaasu_' + Date.now();
  const json = await call('POST', '/v1/payments/payouts', {
    sender_batch_header: {
      sender_batch_id: batchId,
      email_subject: 'You have a payout from Kaasu',
      email_message: note || 'Your share of a client payment.',
    },
    items: [{
      recipient_type: 'EMAIL',
      amount: { value: money(amount), currency },
      receiver: email,
      note: note || 'Revenue split via Kaasu',
      sender_item_id: batchId + '_1',
    }],
  });
  const h = json.batch_header || {};
  return { batch_id: h.payout_batch_id, status: h.batch_status };
}

// ---------- Webhooks ----------
async function verifyWebhook(headers, event) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (MODE === 'mock' || !webhookId) return { verified: false, skipped: true };
  const json = await call('POST', '/v1/notifications/verify-webhook-signature', {
    auth_algo: headers['paypal-auth-algo'],
    cert_url: headers['paypal-cert-url'],
    transmission_id: headers['paypal-transmission-id'],
    transmission_sig: headers['paypal-transmission-sig'],
    transmission_time: headers['paypal-transmission-time'],
    webhook_id: webhookId,
    webhook_event: event,
  });
  return { verified: json.verification_status === 'SUCCESS' };
}

module.exports = {
  MODE, PayPalError,
  createDraftInvoice, sendInvoice, remindInvoice, recordPayment, getInvoice, listInvoices,
  sendPayout, verifyWebhook,
};
