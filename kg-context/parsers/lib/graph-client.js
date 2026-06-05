'use strict';
const https = require('https');
const querystring = require('querystring');
const fs = require('fs');

const TOKEN_PATH = '/home/kent/.outlook-mcp-tokens.json';

function loadTokens() {
  return JSON.parse(fs.readFileSync(TOKEN_PATH));
}

function saveTokens(tokens) {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

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

async function getAccessToken() {
  let tokens = loadTokens();
  if (Date.now() < tokens.expires_at - 5 * 60 * 1000) return tokens.access_token;

  const postData = querystring.stringify({
    client_id:     process.env.AZURE_CLIENT_ID,
    client_secret: process.env.AZURE_CLIENT_SECRET,
    refresh_token: tokens.refresh_token,
    grant_type:    'refresh_token',
    scope:         tokens.scope,
  });
  const res = await httpsRequest({
    hostname: 'login.microsoftonline.com',
    path: `/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData),
    },
  }, postData);

  const fresh = JSON.parse(res.body);
  if (!fresh.access_token) throw new Error('Token refresh failed: ' + res.body);
  fresh.expires_at = Date.now() + fresh.expires_in * 1000;
  saveTokens({ ...tokens, ...fresh });
  return fresh.access_token;
}

// Convert ICS UTC datetime string (e.g. "20260421T143000Z") to local ISO string
// for Graph API (e.g. "2026-04-21T09:30:00") with timeZone: "America/Chicago"
function icsUtcToLocalIso(dtStr) {
  const m = dtStr.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?/);
  if (!m) return null;
  const utc = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  return utc.toLocaleString('sv', { timeZone: 'America/Chicago' }).replace(' ', 'T');
}

async function createCalendarEvent({ subject, dtstart, dtend, location, body }) {
  const token = await getAccessToken();
  const start = icsUtcToLocalIso(dtstart);
  const end   = dtend ? icsUtcToLocalIso(dtend) : null;

  // Default to 45 min if no DTEND
  const endTime = end || (() => {
    const d = new Date(start);
    d.setMinutes(d.getMinutes() + 45);
    return d.toISOString().slice(0, 19);
  })();

  const payload = JSON.stringify({
    subject,
    start: { dateTime: start,   timeZone: 'America/Chicago' },
    end:   { dateTime: endTime, timeZone: 'America/Chicago' },
    location: location ? { displayName: location } : undefined,
    body: body ? { contentType: 'text', content: body } : undefined,
  });

  const res = await httpsRequest({
    hostname: 'graph.microsoft.com',
    path: '/v1.0/me/events',
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  }, payload);

  if (res.status >= 300) throw new Error(`Graph calendar error ${res.status}: ${res.body.slice(0, 200)}`);
  const event = JSON.parse(res.body);
  return { id: event.id, webLink: event.webLink };
}

async function graphGet(path) {
  const token = await getAccessToken();
  const res = await httpsRequest({
    hostname: 'graph.microsoft.com',
    path,
    method: 'GET',
    headers: { Authorization: 'Bearer ' + token },
  });
  if (res.status >= 300) throw new Error(`Graph GET ${path} → ${res.status}: ${res.body.slice(0, 200)}`);
  return JSON.parse(res.body);
}

async function graphPost(path, payload) {
  const token = await getAccessToken();
  const body  = JSON.stringify(payload);
  const res   = await httpsRequest({
    hostname: 'graph.microsoft.com',
    path,
    method: 'POST',
    headers: {
      Authorization:   'Bearer ' + token,
      'Content-Type':  'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
  if (res.status >= 300) throw new Error(`Graph POST ${path} → ${res.status}: ${res.body.slice(0, 300)}`);
  return res.body ? JSON.parse(res.body) : {};
}

async function sendTeamsMessage(toEmail, messageText) {
  const me = await graphGet('/v1.0/me');

  // Use UPN (email) directly in odata.bind — avoids needing User.ReadBasic.All
  const chat = await graphPost('/v1.0/chats', {
    chatType: 'oneOnOne',
    members: [
      {
        '@odata.type': '#microsoft.graph.aadUserConversationMember',
        roles: ['owner'],
        'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${me.id}')`,
      },
      {
        '@odata.type': '#microsoft.graph.aadUserConversationMember',
        roles: ['owner'],
        'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${toEmail}')`,
      },
    ],
  });

  const sanitized = messageText.replace(/—/g, '-').replace(/–/g, '-');

  await graphPost(`/v1.0/chats/${chat.id}/messages`, {
    body: { contentType: 'text', content: sanitized },
  });

  return { chatId: chat.id, to: toEmail, preview: sanitized.slice(0, 80) };
}

module.exports = { getAccessToken, createCalendarEvent, icsUtcToLocalIso, graphGet, graphPost, sendTeamsMessage };
