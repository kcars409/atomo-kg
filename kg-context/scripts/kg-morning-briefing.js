require('dotenv').config({ path: '/home/kent/.env-atomo' });
const https = require('https');
const fs = require('fs');
const querystring = require('querystring');
const TelegramBot = require('node-telegram-bot-api');
const XLSX = require('/home/kent/contexts/KG/node_modules/xlsx');
const { loadProspectsFlat } = require('../parsers/lib/shared');

const bot = new TelegramBot(process.env.TELEGRAM_KG_BOT_TOKEN);
const chatId = process.env.TELEGRAM_KG_CHAT_ID;
const TOKEN_PATH = '/home/kent/.outlook-mcp-tokens.json';
const HOME_ADDRESS = '1404 E 8th St, Hickman, NE 68372';
const SALES_TRACKER = '/home/kent/contexts/KG/assets/Sales Tracker.xlsx';
const KG_PROJECT_ID = '6f4m82q2vvjQPV7X';

// Spam senders/domains to ignore for inbox check
const SPAM_PATTERNS = ['noreply', 'no-reply', 'newsletter', 'beehiiv', 'whitespark',
  'microsoft', 'linkedin', 'yelp', 'doordash', 'grubhub', 'cohesiveai', 'zoominfo'];

function httpsRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function loadTokens() {
  return JSON.parse(fs.readFileSync(TOKEN_PATH));
}

function saveTokens(tokens) {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

async function refreshAccessToken(tokens) {
  const postData = querystring.stringify({
    client_id: process.env.AZURE_CLIENT_ID,
    client_secret: process.env.AZURE_CLIENT_SECRET,
    refresh_token: tokens.refresh_token,
    grant_type: 'refresh_token',
    scope: tokens.scope
  });
  const res = await httpsRequest({
    hostname: 'login.microsoftonline.com',
    path: `/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData)
    }
  }, postData);
  const newTokens = JSON.parse(res.body);
  if (!newTokens.access_token) throw new Error('Token refresh failed: ' + res.body);
  newTokens.expires_at = Date.now() + newTokens.expires_in * 1000;
  saveTokens({ ...tokens, ...newTokens });
  return { ...tokens, ...newTokens };
}

async function getValidToken() {
  let tokens = loadTokens();
  if (Date.now() > tokens.expires_at - 5 * 60 * 1000) {
    tokens = await refreshAccessToken(tokens);
  }
  return tokens.access_token;
}

async function graphGet(accessToken, path, extraHeaders = {}) {
  const res = await httpsRequest({
    hostname: 'graph.microsoft.com',
    path,
    headers: { Authorization: 'Bearer ' + accessToken, ...extraHeaders }
  });
  return { status: res.status, data: JSON.parse(res.body) };
}


async function getFirstAppointment(accessToken) {
  const now = new Date();
  const localMidnight = new Date(now);
  localMidnight.setUTCHours(5, 0, 0, 0);
  if (now.getUTCHours() < 5) localMidnight.setUTCDate(localMidnight.getUTCDate() - 1);
  const dayEnd = new Date(localMidnight.getTime() + 24 * 60 * 60 * 1000);

  const params = new URLSearchParams({
    startDateTime: localMidnight.toISOString().replace('Z', '-05:00'),
    endDateTime: dayEnd.toISOString().replace('Z', '-05:00'),
    '$orderby': 'start/dateTime',
    '$top': '1',
    '$select': 'subject,start,end,location'
  });

  const res = await graphGet(accessToken, '/v1.0/me/calendarView?' + params, {
    'Prefer': 'outlook.timezone="Central Standard Time"'
  });
  return (res.data.value || [])[0] || null;
}

async function getDriveTime(destination) {
  return new Promise((resolve) => {
    const params = new URLSearchParams({
      origins: HOME_ADDRESS,
      destinations: destination,
      mode: 'driving',
      key: process.env.GOOGLE_MAPS_API_KEY
    });
    https.get({
      hostname: 'maps.googleapis.com',
      path: '/maps/api/distancematrix/json?' + params
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const el = JSON.parse(data).rows[0].elements[0];
          resolve(el.status === 'OK' ? { distance: el.distance.text, duration: el.duration.text } : null);
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

async function getRecentInboxEmails(accessToken) {
  const since = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString(); // ~since yesterday evening
  const filter = encodeURIComponent(`isRead eq false and receivedDateTime ge ${since}`);
  const res = await graphGet(
    accessToken,
    `/v1.0/me/mailFolders/inbox/messages?$filter=${filter}&$top=20&$select=subject,from,receivedDateTime,isRead`
  );
  const emails = res.data.value || [];

  const prospect = [];
  const other = [];
  for (const e of emails) {
    const sender = (e.from?.emailAddress?.address || '').toLowerCase();
    const isSpam = SPAM_PATTERNS.some(p => sender.includes(p));
    if (isSpam) continue;
    // Heuristic: not an automated system email
    const subj = (e.subject || '').toLowerCase();
    const isAuto = ['undeliverable', 'out of office', 'automatic reply', 'delivery failed'].some(s => subj.includes(s));
    if (isAuto) { other.push(e); continue; }
    prospect.push(e);
  }
  return { prospect, other, total: emails.length };
}

function excelDateToISO(val) {
  if (!val) return '';
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  if (typeof val === 'number') {
    const d = XLSX.SSF.parse_date_code(val);
    if (!d) return '';
    return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}/.test(val)) return val.slice(0, 10);
  return '';
}

function parseSalesTracker(today) {
  const stat = fs.statSync(SALES_TRACKER);
  const ageHours = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);
  const isStale = ageHours > 24;

  const wb = XLSX.readFile(SALES_TRACKER);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 'A', defval: '', raw: true });

  const seen = {};
  for (const row of rows.slice(1)) {
    const owner = (row.B || '').toLowerCase();
    const status = (row.S || '').toLowerCase();
    const name = (row.A || '').trim();
    if (!name || !owner.includes('kent')) continue;
    if (['closed won', 'closed lost', 'won', 'lost'].includes(status)) continue;
    const nsd = excelDateToISO(row.F);
    if (!nsd || nsd > today) continue;
    const key = name.toLowerCase();
    if (!seen[key] || nsd > seen[key].next_step_date) {
      seen[key] = { name, next_step_date: nsd, next_step: (row.E || '').trim().slice(0, 60) };
    }
  }

  return { isStale, ageHours, leads: Object.values(seen) };
}

function parseProspectsJson(today) {
  const data = loadProspectsFlat();
  const active = [];
  for (const p of data) {
    const status = (p.status || '').toLowerCase();
    if (['closed won', 'closed lost'].includes(status)) continue;
    const nsd = p.next_step_date || '';
    if (!nsd || nsd > today) continue;
    const daysOver = Math.floor((Date.now() - new Date(nsd).getTime()) / (1000 * 60 * 60 * 24));
    active.push({
      name: p.name || p.company || '',
      status: p.status || '',
      next_step: (p.next_step || '').slice(0, 60),
      next_step_date: nsd,
      days_overdue: daysOver,
      '14day_step': p['14day_step'] || '',
      contact_person: p.contact_person || '',
      phone: p.phone || '',
      email: p.email || ''
    });
  }
  return active;
}

function buildWorkingList(stLeads, pjLeads, today) {
  const map = {};
  for (const l of stLeads) {
    map[l.name.toLowerCase()] = { ...l };
  }
  for (const p of pjLeads) {
    const key = p.name.toLowerCase();
    if (map[key]) {
      if (p.next_step_date > map[key].next_step_date) map[key] = { ...p };
    } else {
      map[key] = { ...p };
    }
  }
  return Object.values(map)
    .sort((a, b) => a.next_step_date.localeCompare(b.next_step_date));
}

function getHotSignals(leads) {
  const signals = [];
  for (const l of leads) {
    if (l['14day_step']) {
      signals.push(`14-day ${l['14day_step']}: ${l.name}`);
    } else if ((l.status || '').toLowerCase().includes('proposal') && l.days_overdue > 14) {
      signals.push(`Proposal ${l.days_overdue}d w/no activity: ${l.name}`);
    }
  }
  return signals;
}

async function sendBriefing() {
  const today = new Date().toISOString().slice(0, 10);
  const dayName = new Date().toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/Chicago' });
  const dateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/Chicago' });

  let message = `🔥 *KG Morning Briefing*\n📅 ${dayName}, ${dateStr}\n\n`;

  // --- Outlook: inbox + calendar ---
  let accessToken = null;
  try {
    accessToken = await getValidToken();
  } catch (e) {
    message += `⚠️ Outlook auth failed: ${e.message}\n\n`;
  }

  if (accessToken) {
    // Inbox
    try {
      const { prospect, total } = await getRecentInboxEmails(accessToken);
      if (prospect.length > 0) {
        message += `📧 *Inbox (${total} unread):*\n`;
        for (const e of prospect.slice(0, 4)) {
          const from = e.from?.emailAddress?.name || e.from?.emailAddress?.address || 'Unknown';
          message += `• ${e.subject.slice(0, 50)} — _${from}_\n`;
        }
        if (prospect.length > 4) message += `_...and ${prospect.length - 4} more_\n`;
        message += '\n';
      } else if (total > 0) {
        message += `📧 *Inbox:* ${total} unread (no prospect replies)\n\n`;
      } else {
        message += `📧 *Inbox:* Clear\n\n`;
      }
    } catch (e) {
      message += `📧 *Inbox:* Error — ${e.message}\n\n`;
    }

    // Calendar
    try {
      const appt = await getFirstAppointment(accessToken);
      if (appt) {
        const timeStr = new Date(appt.start.dateTime).toLocaleTimeString('en-US', {
          hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago'
        });
        const loc = appt.location?.displayName?.trim() || null;
        message += `📍 *First Appt:* ${appt.subject} — ${timeStr}\n`;
        if (loc) {
          const drive = await getDriveTime(loc);
          message += drive
            ? `🚗 ${drive.duration} (${drive.distance}) from home\n\n`
            : `📍 ${loc}\n\n`;
        } else {
          message += `_(No location)_\n\n`;
        }
      } else {
        message += `📍 *First Appt:* None today\n\n`;
      }
    } catch (e) {
      message += `📍 *First Appt:* Error — ${e.message}\n\n`;
    }
  }

  // --- Pipeline ---
  try {
    const { isStale, ageHours, leads: stLeads } = parseSalesTracker(today);
    const pjLeads = parseProspectsJson(today);
    const working = buildWorkingList(stLeads, pjLeads, today);
    const hot = getHotSignals(working);

    if (isStale) {
      const ageDays = Math.floor(ageHours / 24);
      message += `⚠️ _Sales Tracker is ${ageDays}d old — upload a fresh copy before your review_\n\n`;
    }

    if (working.length > 0) {
      message += `📋 *Pipeline: ${working.length} due/overdue*\n`;
      for (const p of working.slice(0, 8)) {
        const age = p.days_overdue > 0 ? `${p.days_overdue}d overdue` : 'today';
        const step14 = p['14day_step'] ? ` [14d-${p['14day_step']}]` : '';
        const contact = p.phone || p.email || '';
        const step = p.next_step ? ` → ${p.next_step}` : '';
        const contactStr = contact ? ` | ${contact}` : '';
        message += `• ${p.name} — ${age}${step14}${step}${contactStr}\n`;
      }
      if (working.length > 8) message += `_...and ${working.length - 8} more_\n`;
      message += '\n';
    } else {
      message += `📋 *Pipeline:* All clear\n\n`;
    }

    if (hot.length > 0) {
      message += `🔥 *Hot signals:*\n`;
      hot.forEach(s => { message += `• ${s}\n`; });
    }
  } catch (e) {
    message += `📋 *Pipeline:* Error — ${e.message}\n`;
  }

  await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  console.log('KG morning briefing sent.');
  process.exit(0);
}

sendBriefing().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
