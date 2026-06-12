'use strict';
require('dotenv').config({ path: '/home/kent/.env-atomo' });
const fs = require('fs');
const path = require('path');
const https = require('https');
const TelegramBot = require('node-telegram-bot-api');

const KG_DIR = path.join(__dirname, '../..');
const PROSPECTS_PATH = path.join(KG_DIR, 'prospects.json');
const ROTATION_PATH = path.join(KG_DIR, 'lead-rotation.json');
const SM_TEMPLATE_PATH = path.join(KG_DIR, 'serviceminder_upload_template.csv');
const OUTPUT_DIR = path.join(KG_DIR, 'output');

/*
 * prospects.json on disk: { companies: [ { company_id, company, locations: [...] } ] }
 * Each location object holds everything below except `company` (lives on the
 * company node, re-derived by flatten()):
 *
 * SM fields (map to serviceminder_upload_template.csv):
 *   name, company, title, email, phone, alt_phone,
 *   address1, address2, city, state, zip,
 *   owner, lead_source, next_service_name, next_service_date,
 *   contact_person, contact_person_mobile, contact_person_email,
 *   first_name, last_name, notes, how_did_you_find_out, are_you_a_new_customer
 *
 * Atomo-specific:
 *   location_id         — e.g. "spaghetti-works-1"
 *   lead_source_type    — CSS | WebForm | Cohesive | ColdCall | ...
 *   assigned_to         — Kent | Vincent
 *   rotation_override   — true if normal rotation was bypassed
 *   sister_property     — false | { flagged: true, notes: "..." }
 *   timetap_id          — CSS only
 *   cohesive_campaign_url — Cohesive only
 *   temperature         — Hot | Contacted - Responded | null
 *   atomo_notes         — free text
 *   last_updated        — ISO timestamp
 *
 * loadProspects()/saveProspects() below give every caller the flat,
 * one-record-per-location array this file always had — see flatten()/nest().
 */

// ── Schema: companies[] -> locations[] ────────────────────────────────────────

function slugifyCompanyName(str) {
  const base = (str || '')
    .toLowerCase()
    .replace(/['''`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'company';
}

// Nested -> flat. Every location becomes its own record, with `company` and
// `company_id` copied down from its parent company node.
function flatten(nested) {
  const out = [];
  for (const co of (nested.companies || [])) {
    for (const loc of (co.locations || [])) {
      out.push({ ...loc, company: co.company, company_id: co.company_id });
    }
  }
  return out;
}

// Flat -> nested. Groups by company_id (assigning fresh ids to records that
// don't have one yet — new leads each become their own single-location
// company by default). `company`/`company_id` are stripped from the location
// object since they're re-derived by flatten() on the next load.
function nest(flatArray) {
  const companies = new Map();
  const usedIds = new Set();
  const usedLocationIds = new Set();

  for (const rec of flatArray) {
    const { company, company_id, location_id, ...rest } = rec;
    let coId = company_id;
    if (coId) {
      usedIds.add(coId);
      if (!companies.has(coId)) {
        companies.set(coId, { company_id: coId, company: company || rest.name || '', locations: [] });
      }
    } else {
      const base = slugifyCompanyName(company || rest.name);
      coId = base;
      let n = 2;
      while (usedIds.has(coId)) { coId = `${base}-${n}`; n++; }
      usedIds.add(coId);
      companies.set(coId, { company_id: coId, company: company || rest.name || '', locations: [] });
    }
    const companyNode = companies.get(coId);
    let locId = location_id;
    if (!locId) {
      let n = companyNode.locations.length + 1;
      locId = `${coId}-${n}`;
      while (usedLocationIds.has(locId)) { n++; locId = `${coId}-${n}`; }
    } else if (usedLocationIds.has(locId)) {
      // Pre-existing location_id collides (e.g. two records that slugify to
      // the same id) - disambiguate rather than silently dropping a key.
      let n = 2;
      let candidate = `${locId}-${n}`;
      while (usedLocationIds.has(candidate)) { n++; candidate = `${locId}-${n}`; }
      locId = candidate;
    }
    usedLocationIds.add(locId);
    companyNode.locations.push({ location_id: locId, ...rest });
  }

  return { companies: Array.from(companies.values()) };
}

// ── prospects.json ────────────────────────────────────────────────────────────

function loadProspectsFlat() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(PROSPECTS_PATH, 'utf8')); }
  catch { return []; }
  if (Array.isArray(raw)) return raw; // pre-migration flat file
  return flatten(raw);
}

function saveProspectsFlat(prospects) {
  // Rotate backup: keep last 3 copies
  const backupPath = PROSPECTS_PATH + '.bak';
  const backup2Path = PROSPECTS_PATH + '.bak2';
  const backup3Path = PROSPECTS_PATH + '.bak3';
  try {
    if (fs.existsSync(backup2Path)) fs.renameSync(backup2Path, backup3Path);
    if (fs.existsSync(backupPath)) fs.renameSync(backupPath, backup2Path);
    if (fs.existsSync(PROSPECTS_PATH)) fs.copyFileSync(PROSPECTS_PATH, backupPath);
  } catch (_) {}
  fs.writeFileSync(PROSPECTS_PATH, JSON.stringify(nest(prospects), null, 2));
}

function loadProspects() {
  return loadProspectsFlat();
}

function saveProspects(prospects) {
  saveProspectsFlat(prospects);
}

function addOrUpdateProspect(lead) {
  const prospects = loadProspects();
  const key = (lead.email || '').toLowerCase();
  const idx = key ? prospects.findIndex(p => (p.email || '').toLowerCase() === key) : -1;
  const today = new Date().toISOString().slice(0, 10);
  const record = {
    status: 'New Lead',
    next_step_date: '',
    last_activity_date: today,
    ...lead,
    last_updated: new Date().toISOString()
  };
  const action = idx >= 0 ? 'UPDATE' : 'CREATE';
  if (idx >= 0) {
    prospects[idx] = { ...prospects[idx], ...record };
  } else {
    prospects.push(record);
  }
  saveProspects(prospects);
  // Audit log - one line per add/update so silent failures are traceable
  try {
    const auditPath = require('path').join(__dirname, '../../../../temp/prospects-audit.log');
    const ts = new Date().toISOString();
    require('fs').appendFileSync(auditPath, `${ts} ${action} "${lead.name || lead.email}" email=${lead.email || ''}\n`);
  } catch (_) {}
  return record;
}

function findProspectByEmail(email) {
  return loadProspects().find(p => (p.email || '').toLowerCase() === email.toLowerCase()) || null;
}

// ── lead-rotation.json ────────────────────────────────────────────────────────

function loadRotation() {
  return JSON.parse(fs.readFileSync(ROTATION_PATH, 'utf8'));
}

function setRotation(next) {
  const r = { next };
  fs.writeFileSync(ROTATION_PATH, JSON.stringify(r, null, 2));
}

// ── geo filter ────────────────────────────────────────────────────────────────

const GEO_ORIGIN = 'Lincoln,NE+68508';
const GEO_THRESHOLD_SECONDS = 90 * 60;
const GEO_EXCEPTIONS = ['grand island, ne'];

function geoCheck(addressOrCity) {
  return new Promise((resolve, reject) => {
    const dest = encodeURIComponent(addressOrCity);
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${GEO_ORIGIN}&destinations=${dest}&mode=driving&units=imperial&key=${process.env.GOOGLE_MAPS_API_KEY}`;
    https.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          const el = result.rows?.[0]?.elements?.[0];
          if (!el || el.status !== 'OK') {
            return resolve({ withinRadius: true, display: 'unknown', error: el?.status });
          }
          const secs = el.duration.value;
          const isException = GEO_EXCEPTIONS.includes(addressOrCity.toLowerCase());
          const tripFee = secs > GEO_THRESHOLD_SECONDS && !isException;
          const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60);
          resolve({ withinRadius: !tripFee, tripFee, display: h > 0 ? `${h}hr ${m}min` : `${m}min` });
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ── Telegram ──────────────────────────────────────────────────────────────────

function sendTelegram(message) {
  const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
  return bot.sendMessage(process.env.TELEGRAM_CHAT_ID, message);
}

function sendKgTelegram(message) {
  const bot = new TelegramBot(process.env.TELEGRAM_KG_BOT_TOKEN);
  return bot.sendMessage(process.env.TELEGRAM_KG_CHAT_ID, message);
}

async function waitForYesNo(timeoutMs = 5 * 60 * 1000) {
  const bot = new TelegramBot(process.env.TELEGRAM_KG_BOT_TOKEN);
  const chatId = String(process.env.TELEGRAM_KG_CHAT_ID);
  const deadline = Date.now() + timeoutMs;

  // Advance offset past any queued messages so we only see new replies
  let offset = 0;
  const priming = await bot.getUpdates({ limit: 100, timeout: 0 }).catch(() => []);
  if (priming.length) offset = priming[priming.length - 1].update_id + 1;

  while (Date.now() < deadline) {
    const wait = Math.min(30, Math.ceil((deadline - Date.now()) / 1000));
    if (wait <= 0) break;
    const updates = await bot.getUpdates({ offset, timeout: wait, limit: 10 }).catch(() => []);
    for (const u of updates) {
      offset = u.update_id + 1;
      if (String(u.message?.chat?.id) !== chatId) continue;
      const text = (u.message?.text || '').trim().toLowerCase();
      if (text === 'yes' || text === 'y') return 'yes';
      if (text === 'no'  || text === 'n') return 'no';
    }
  }
  throw new Error('Timeout: no Yes/No received within 5 minutes');
}

// ── ServiceMinder CSV ─────────────────────────────────────────────────────────

function parseCSVHeader() {
  const raw = fs.readFileSync(SM_TEMPLATE_PATH, 'utf8');
  const line = raw.split('\n')[0];
  const cols = [];
  let cur = '', inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; }
    else if (ch === ',' && !inQ) { cols.push(cur); cur = ''; }
    else cur += ch;
  }
  cols.push(cur);
  return cols;
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return (s.includes(',') || s.includes('"') || s.includes('\n'))
    ? '"' + s.replace(/"/g, '""') + '"'
    : s;
}

function generateSmCsv(lead, suffix = '') {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const headers = parseCSVHeader();
  const slug = (lead.company || lead.name || 'unknown')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const sfx = suffix ? `_${suffix}` : '';
  const outPath = path.join(OUTPUT_DIR, `sm_import_${slug}${sfx}_${date}.csv`);

  const map = {
    'Name': lead.name || '',
    'Title': lead.title || '',
    'Company': lead.company || lead.name || '',
    'Email': lead.email || '',
    'Phone': lead.phone || '',
    'Address1': lead.address1 || '',
    'Address2': lead.address2 || '',
    'City': lead.city || '',
    'State': lead.state || '',
    'Zip': lead.zip || '',
    'Owner': lead.owner || 'Kent Seevers',
    'LeadSource': lead.lead_source || '',
    'NextServiceName': lead.next_service_name || '',
    'NextServiceDate': lead.next_service_date || '',
    'Contact Person': lead.contact_person || '',
    'Contact Person Mobile': lead.contact_person_mobile || '',
    'Contact Person Email': lead.contact_person_email || lead.email || '',
    'Notes': lead.notes || '',
    'How did you find out about us?': lead.how_did_you_find_out || '',
    'Are you a New Customer ?': lead.are_you_a_new_customer || 'Yes',
    'Initial Contact First Name': lead.first_name || '',
    'Initial Contact Last Name': lead.last_name || '',
  };

  const row = headers.map(h => csvEscape(map[h] != null ? map[h] : ''));
  fs.writeFileSync(outPath, [headers.map(csvEscape).join(','), row.join(',')].join('\n') + '\n');
  return outPath;
}

// ── EML / MIME helpers ────────────────────────────────────────────────────────

function decodeQuotedPrintable(str) {
  return str
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function getMimePart(emlContent, targetType) {
  // Single-part: no boundary
  const bMatch = emlContent.match(/boundary="?([^";\r\n]+)"?/i);
  if (!bMatch) {
    const sep = emlContent.search(/\r?\n\r?\n/);
    if (sep === -1) return emlContent;
    const sepEnd = emlContent[sep] === '\r' ? sep + 4 : sep + 2;
    const body = emlContent.slice(sepEnd);
    const encMatch = emlContent.match(/content-transfer-encoding:\s*(\S+)/i);
    const enc = (encMatch ? encMatch[1] : '').toLowerCase();
    if (enc === 'quoted-printable') return decodeQuotedPrintable(body);
    if (enc === 'base64') return Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf-8');
    return body;
  }

  const boundary = bMatch[1].trim();
  const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = emlContent.split(new RegExp(`--${escaped}(?:\r?\n|--)`));

  for (const part of parts) {
    if (!part.trim()) continue;
    const sep = part.search(/\r?\n\r?\n/);
    if (sep === -1) continue;
    const hdrs = part.slice(0, sep).toLowerCase();
    if (!hdrs.includes(`content-type: ${targetType}`) && !hdrs.includes(`content-type:${targetType}`)) continue;
    const sepEnd = part[sep] === '\r' ? sep + 4 : sep + 2;
    const body = part.slice(sepEnd);
    const encMatch = part.match(/content-transfer-encoding:\s*(\S+)/i);
    const enc = (encMatch ? encMatch[1] : '').toLowerCase();
    if (enc === 'quoted-printable') return decodeQuotedPrintable(body);
    if (enc === 'base64') return Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf-8');
    return body;
  }
  return null;
}

// ── misc helpers ──────────────────────────────────────────────────────────────

function formatPhone(raw) {
  // Normalize to (NXX) NXX-XXXX — strip country code if present
  const digits = (raw || '').replace(/\D/g, '');
  const d = digits.startsWith('1') && digits.length === 11 ? digits.slice(1) : digits;
  if (d.length !== 10) return raw || '';
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

function companyFromDomain(domain) {
  const base = domain.replace(/\.(com|net|org|io|co|biz|us)$/i, '');
  return base
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}


const QUEUE_PATH = "/home/kent/atomo-data/pipeline-queue.json";

function queueToSalesTracker(lead) {
  let queue = [];
  try { queue = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8")); if (!Array.isArray(queue)) queue = []; }
  catch (_) {}
  const notes = [lead.contact_person, lead.phone, lead.email, lead.address1]
    .filter(Boolean).join(" | ");
  queue.push({
    prospect: lead.name || lead.company || "",
    owner:    lead.owner || "Kent Seevers",
    next_step:      lead.next_step || "",
    next_step_date: lead.next_step_date || "",
    lead_source:    lead.lead_source || "",
    notes,
    new_row:   true,
    timestamp: new Date().toISOString(),
  });
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2));
}

// Queues a status-only Sales Tracker update for an existing row (e.g. closing
// a prospect as Cold / Closed Lost / Closed Won from /execute). new_row is
// false so pipeline-writeback.py skips it (reports "skipped") rather than
// creating a sparse ghost row if the name isn't found in the sheet.
function queueStatusUpdate(prospectName, status) {
  let queue = [];
  try { queue = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8")); if (!Array.isArray(queue)) queue = []; }
  catch (_) {}
  queue.push({
    prospect: prospectName,
    status,
    new_row: false,
    timestamp: new Date().toISOString(),
  });
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2));
}

// ── Company de-dup helpers ────────────────────────────────────────────────────

function normalizeCompany(str) {
  return (str || '')
    .toLowerCase()
    .replace(/['''`]/g, '')        // remove apostrophes/smart quotes before spacing
    .replace(/[^a-z0-9 ]/g, ' ')  // replace remaining punctuation with space
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeAddress(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

// Returns existing prospects that share the same normalized company name.
// Optionally filters to only same-address matches (true duplicates).
function findSiblingLocations(lead, prospects) {
  const normNew = normalizeCompany(lead.company || lead.name);
  if (!normNew) return [];
  return prospects.filter(p => {
    const normExisting = normalizeCompany(p.company || p.name);
    return normExisting === normNew;
  });
}

module.exports = {
  PROSPECTS_PATH, ROTATION_PATH, OUTPUT_DIR,
  flatten, nest, loadProspectsFlat, saveProspectsFlat,
  loadProspects, saveProspects, addOrUpdateProspect, findProspectByEmail,
  loadRotation, setRotation,
  geoCheck,
  sendTelegram, sendKgTelegram, waitForYesNo,
  generateSmCsv,
  decodeQuotedPrintable, getMimePart,
  formatPhone, companyFromDomain, todayYmd,
  queueToSalesTracker, queueStatusUpdate,
  normalizeCompany, normalizeAddress, findSiblingLocations,
};
