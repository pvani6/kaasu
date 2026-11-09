// Diagnostic: shows which PayPal permissions your keys have. Never prints your secret.
// Run:  node check-paypal.js
require('dotenv').config();
const id = process.env.PAYPAL_CLIENT_ID || '';
const secret = process.env.PAYPAL_CLIENT_SECRET || '';
const base = process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';

(async () => {
  if (!id || !secret) return console.log('X  PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET is empty in .env');
  console.log('Client ID in .env starts with:', id.slice(0, 8) + '...  (compare with the app page in PayPal)');
  const r = await fetch(base + '/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(id + ':' + secret).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const j = await r.json();
  if (!r.ok) return console.log('X  Login failed:', j.error_description || r.status);
  const scopes = (j.scope || '').split(' ');
  const has = (s) => scopes.some((x) => x.includes(s));
  console.log('OK Login works. App id:', j.app_id);
  console.log(has('invoicing') ? 'OK Invoicing permission: YES' : 'X  Invoicing permission: NO  (tick Invoicing + Save, wait 5 min)');
  console.log(has('payouts') ? 'OK Payouts permission:   YES' : 'X  Payouts permission:   NO  (tick Payouts + Save)');
  const t = await fetch(base + '/v2/invoicing/invoices?page=1&page_size=1', { headers: { Authorization: 'Bearer ' + j.access_token } });
  console.log(t.ok ? 'OK Invoice API test call: works' : 'X  Invoice API test call failed: HTTP ' + t.status + ' ' + (await t.text()).slice(0, 200));
})().catch((e) => console.log('X  Error:', e.message));
