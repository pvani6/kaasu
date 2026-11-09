// Tiny JSON-file database. No setup, no paid database needed.
// PayPal is the real source of truth for invoices; this file just keeps
// Kaasu's own extras (reminders sent, payouts, approvals, activity log).
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'db.json');

function empty() {
  return { invoices: [], actions: [], events: [] };
}

let state = null;

function load() {
  try {
    state = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    state = null;
  }
  if (!state || typeof state !== 'object') state = empty(); // file missing, broken or "null"
  const base = empty();
  for (const k of Object.keys(base)) if (!Array.isArray(state[k])) state[k] = base[k];
  return state;
}

function db() {
  return state || load();
}

function save() {
  db(); // make sure data is loaded before writing, so we never save "null"
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

function reset() {
  state = empty();
  save();
}

function logEvent(type, message, extra = {}) {
  const d = db();
  d.events.unshift({ id: 'evt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), type, message, at: new Date().toISOString(), ...extra });
  d.events = d.events.slice(0, 200);
  save();
}

module.exports = { db, save, reset, logEvent };
