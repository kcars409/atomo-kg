require('dotenv').config({ path: '/home/kent/.env-atomo' });
const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PROSPECTS_PATH = '/home/kent/contexts/KG/prospects.json';
const ROTATION_PATH  = '/home/kent/contexts/KG/lead-rotation.json';
const QUEUE_PATH     = '/home/kent/atomo-data/pipeline-queue.json';
const SESSION_PATH   = '/home/kent/atomo-data/kg-review-session.json';
const TOKEN_PATH     = path.join(process.env.HOME || '/home/kent', '.outlook-mcp-tokens.json');
const PORT = 3100;


const SCHEDULING_CHECKLIST = [
  'What time can we start cleaning?',
  'When do we need to be out?',
  'Can we keep a key on file? Can we pick it up at the first cleaning or does it need to be picked up prior?',
  'Who is the best scheduling / on-site contact for this location? (name and phone or email)',
  'Do we need to confirm dates prior to each cleaning, or can we schedule and simply let you know when we are coming?',
  'Is there an alarm code?',
  'Any special notes for this location?',
];

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

const ACTIVE_STATUSES = [
  'New Lead', 'Working', 'Contacted - Responded', 'Contacted - Spoke',
  'Inspection Scheduled', 'Inspection Complete', 'Proposal Delivered', 'In 14-Day',
];

function readProspects() {
  return JSON.parse(fs.readFileSync(PROSPECTS_PATH, 'utf8'));
}

function writeProspects(data) {
  fs.writeFileSync(PROSPECTS_PATH, JSON.stringify(data, null, 2));
}

function todayYmd() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

function queuePriority(p, today) {
  const date = p.next_step_date || '';
  if (date && date < today) return 0;
  if (date === today)       return 1;
  if (p.status === 'In 14-Day') return 2;
  if (date && date > today) return 3;
  return 4;
}

const KENT_ASSIGNEES = new Set(['Kent', 'Kent Seevers']);

function isKentsProspect(p) {
  const a = p.assigned_to;
  return !a || KENT_ASSIGNEES.has(a);
}

function buildQueue(prospects) {
  const today = todayYmd();
  return prospects
    .filter(p => ACTIVE_STATUSES.includes(p.status) && isKentsProspect(p) && p.next_step_date && p.next_step_date <= today)
    .sort((a, b) => {
      const diff = queuePriority(a, today) - queuePriority(b, today);
      if (diff !== 0) return diff;
      return (a.last_activity_date || '').localeCompare(b.last_activity_date || '');
    });
}

// ── Outlook / Graph API helpers ────────────────────────────────────────────
function graphToken() {
  try {
    execSync(
      'bash -c "set -a; source /home/kent/.env-atomo; set +a; python3 /home/kent/scripts/outlook-token-refresh.py"',
      { stdio: 'pipe' }
    );
  } catch(e) { /* proceed with current token */ }
  return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')).access_token;
}

function graphPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const token = graphToken();
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: 'graph.microsoft.com',
      path: `/v1.0${endpoint}`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400)
          return reject(new Error(`Graph ${res.statusCode}: ${data.slice(0, 300)}`));
        resolve(data ? JSON.parse(data) : {});
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function createOutlookEvent(subject, startIso, endIso, location, attendees = []) {
  const event = {
    subject,
    start: { dateTime: startIso, timeZone: 'America/Chicago' },
    end:   { dateTime: endIso,   timeZone: 'America/Chicago' },
  };
  if (location) event.location = { displayName: location };
  if (attendees.length) {
    event.attendees = attendees.map(a => ({
      emailAddress: { address: a.email, name: a.name || a.email },
      type: 'required',
    }));
  }
  const result = await graphPost('/me/events', event);
  return result.id;
}

// ── Stats ──────────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const prospects = readProspects();
  const today = todayYmd();
  const byStatus = {};
  let overdue = 0, dueToday = 0;
  for (const p of prospects) {
    byStatus[p.status] = (byStatus[p.status] || 0) + 1;
    if (ACTIVE_STATUSES.includes(p.status)) {
      if (p.next_step_date && p.next_step_date < today) overdue++;
      if (p.next_step_date === today) dueToday++;
    }
  }
  res.json({ total: prospects.length, byStatus, overdue, dueToday });
});

// ── Review queue ───────────────────────────────────────────────────────────
app.get('/api/review-queue', (req, res) => {
  const prospects = readProspects();
  const queue = buildQueue(prospects);
  const today = todayYmd();
  res.json(queue.map(p => ({
    name: p.name,
    company: p.company || p.name,
    status: p.status,
    city: p.city,
    state: p.state,
    contact_person: p.contact_person,
    phone: p.phone,
    email: p.email,
    next_step: p.next_step,
    next_step_date: p.next_step_date,
    last_activity_date: p.last_activity_date,
    atomo_notes: p.atomo_notes,
    notes: p.notes,
    temperature: p.temperature,
    assigned_to: p.assigned_to,
    timetap_id: p.timetap_id,
    priority: queuePriority(p, today),
    inspection_meeting: p.inspection_meeting || null,
    proposal_meeting:   p.proposal_meeting   || null,
    decision_maker: p.decision_maker || p.contact_person || null,
    dm_email: p.dm_email || p.email || null,
  })));
});

// ── All prospects ──────────────────────────────────────────────────────────
app.get('/api/prospects', (req, res) => {
  let prospects = readProspects();
  if (req.query.status)      prospects = prospects.filter(p => p.status === req.query.status);
  if (req.query.assigned_to) prospects = prospects.filter(p => p.assigned_to === req.query.assigned_to);
  if (req.query.q) {
    const q = req.query.q.toLowerCase();
    prospects = prospects.filter(p =>
      (p.name || '').toLowerCase().includes(q) ||
      (p.city || '').toLowerCase().includes(q) ||
      (p.contact_person || '').toLowerCase().includes(q)
    );
  }
  res.json(prospects);
});

// ── Update prospect ────────────────────────────────────────────────────────
app.patch('/api/prospects/:name', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const prospects = readProspects();
  const idx = prospects.findIndex(p => p.name === name);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  const allowed = [
    'status', 'next_step', 'next_step_date', 'atomo_notes',
    'assigned_to', 'temperature',
  ];
  const updates = {};
  for (const key of allowed) {
    if (key in req.body) updates[key] = req.body[key];
  }
  updates.last_activity_date = todayYmd();
  updates.last_updated = new Date().toISOString();

  if (req.body.atomo_notes && prospects[idx].atomo_notes) {
    updates.atomo_notes = prospects[idx].atomo_notes + `[${todayYmd()}] ${req.body.atomo_notes}\n`;
  }

  prospects[idx] = { ...prospects[idx], ...updates };

  // Auto-create todos on status triggers
  if (!prospects[idx].todos) prospects[idx].todos = [];
  const hasTodo = (text) => prospects[idx].todos.some(t => t.text === text);
  const pushTodo = (text) => prospects[idx].todos.push({ id: newId(), text, done: false, done_at: null, created_at: todayYmd() });
  const isCSSLead = prospects[idx].lead_source === 'CSS';

  if (updates.status === 'Inspection Complete' && isCSSLead) {
    const t = 'Add inspection notes in CSS (ServiceMinder)';
    if (!hasTodo(t)) pushTodo(t);
  }
  if (updates.status === 'Closed Won') {
    if (isCSSLead) {
      const t = 'Add closing notes in CSS (ServiceMinder)';
      if (!hasTodo(t)) pushTodo(t);
    }
    const hasChecklist = SCHEDULING_CHECKLIST.some(ck => hasTodo(ck));
    if (!hasChecklist) {
      SCHEDULING_CHECKLIST.forEach(text => pushTodo(text));
    }
  }
  writeProspects(prospects);

  if (updates.status || updates.next_step || updates.next_step_date) {
    try {
      const p = prospects[idx];
      const raw1 = fs.existsSync(QUEUE_PATH) ? JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8')) : [];
      const queue = Array.isArray(raw1) ? raw1 : (raw1.changes || []);
      const existing = queue.findIndex(e => e.prospect === p.name);
      const entry = {
        prospect:       p.name,
        status:         p.status || '',
        next_step:      p.next_step || '',
        next_step_date: p.next_step_date || '',
        notes:          p.atomo_notes || '',
        timestamp:      new Date().toISOString(),
      };
      if (existing >= 0) queue[existing] = entry;
      else queue.push(entry);
      fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2));
    } catch (e) {
      console.error('Queue write error:', e.message);
    }
  }

  res.json({ success: true, prospect: prospects[idx] });
});

// ── Schedule meeting ───────────────────────────────────────────────────────
app.post('/api/prospects/:name/meeting', async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const { type, datetime, dm_contacts, sop_exception } = req.body;

  if (!['inspection', 'proposal'].includes(type))
    return res.status(400).json({ error: 'type must be inspection or proposal' });
  if (!datetime)
    return res.status(400).json({ error: 'datetime required' });

  const prospects = readProspects();
  const idx = prospects.findIndex(p => p.name === name);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  const p = prospects[idx];
  const startDt = new Date(datetime);
  const endIso  = new Date(startDt.getTime() + 60 * 60 * 1000).toISOString().slice(0, 16);

  let outlookEventId = null;
  let calendarError  = null;
  try {
    const subject  = type === 'inspection'
      ? `KG Inspection - ${p.company || p.name}`
      : `KG Proposal - ${p.company || p.name}`;
    const location = [p.city, p.state].filter(Boolean).join(', ');
    const attendees = type === 'proposal' && dm_contacts
      ? dm_contacts.filter(c => c.email)
      : [];
    outlookEventId = await createOutlookEvent(subject, datetime, endIso, location, attendees);
  } catch(e) {
    calendarError = e.message;
    console.error('Outlook event creation failed:', e.message);
  }

  const meetingKey  = type === 'inspection' ? 'inspection_meeting' : 'proposal_meeting';
  const meetingData = {
    datetime,
    outlook_event_id: outlookEventId,
    scheduled_at: new Date().toISOString(),
  };
  if (sop_exception)                      meetingData.sop_exception = sop_exception;
  if (type === 'proposal' && dm_contacts) meetingData.dm_contacts   = dm_contacts;

  prospects[idx][meetingKey]  = meetingData;
  prospects[idx].last_updated = new Date().toISOString();
  writeProspects(prospects);

  res.json({
    success: true,
    event_id: outlookEventId,
    calendar_error: calendarError,
    meeting: meetingData,
  });
});

// ── Pending post-meeting prompts ───────────────────────────────────────────
app.get('/api/meetings/pending', (req, res) => {
  const now       = new Date().toISOString();
  const prospects = readProspects();
  const pending   = [];

  for (const p of prospects) {
    if (p.inspection_meeting?.datetime &&
        p.inspection_meeting.datetime < now &&
        !p.inspection_meeting.completed_at) {
      pending.push({
        name: p.name,
        company: p.company || p.name,
        type: 'inspection',
        datetime: p.inspection_meeting.datetime,
        has_proposal_meeting: !!(p.proposal_meeting?.datetime),
      });
    }
    if (p.proposal_meeting?.datetime &&
        p.proposal_meeting.datetime < now &&
        !p.proposal_meeting.completed_at) {
      pending.push({
        name: p.name,
        company: p.company || p.name,
        type: 'proposal',
        datetime: p.proposal_meeting.datetime,
      });
    }
  }

  res.json(pending);
});

// ── Complete meeting ───────────────────────────────────────────────────────
app.post('/api/prospects/:name/meeting/complete', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const { type, outcome, notes } = req.body;

  if (!['inspection', 'proposal'].includes(type))
    return res.status(400).json({ error: 'invalid type' });

  const prospects = readProspects();
  const idx       = prospects.findIndex(p => p.name === name);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  const meetingKey = type === 'inspection' ? 'inspection_meeting' : 'proposal_meeting';
  if (!prospects[idx][meetingKey])
    return res.status(400).json({ error: 'No meeting found' });

  const today = todayYmd();
  prospects[idx][meetingKey].completed_at = new Date().toISOString();
  prospects[idx][meetingKey].outcome      = outcome;

  const statusMap = {
    inspection: { completed: 'Inspection Complete' },
    proposal:   { signed: 'Closed Won', lost: 'Closed Lost' },
  };
  const newStatus = statusMap[type]?.[outcome];

  const notePrefix = type === 'inspection' ? 'INSPECTION' : 'PROPOSAL';
  if (notes) {
    const existing = prospects[idx].atomo_notes || '';
    prospects[idx].atomo_notes = existing + `[${today}] ${notePrefix} (${outcome}): ${notes}\n`;
  }
  if (newStatus) prospects[idx].status = newStatus;
  prospects[idx].last_activity_date = today;
  prospects[idx].last_updated       = new Date().toISOString();
  writeProspects(prospects);

  // Queue status changes for SharePoint nightly sync
  if (newStatus) {
    try {
      const p = prospects[idx];
      const raw2 = fs.existsSync(QUEUE_PATH) ? JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8')) : [];
      const queue = Array.isArray(raw2) ? raw2 : (raw2.changes || []);
      const existing = queue.findIndex(e => e.prospect === p.name);
      const entry = {
        prospect: p.name, status: newStatus, next_step: p.next_step || '',
        next_step_date: p.next_step_date || '', notes: p.atomo_notes || '',
        timestamp: new Date().toISOString(),
      };
      if (existing >= 0) queue[existing] = entry;
      else queue.push(entry);
      fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2));
    } catch(e) { console.error('Queue write error:', e.message); }
  }

  res.json({ success: true, new_status: newStatus });
});

// ── Lead rotation ──────────────────────────────────────────────────────────
app.get('/api/lead-rotation', (req, res) => {
  res.json(JSON.parse(fs.readFileSync(ROTATION_PATH, 'utf8')));
});

app.put('/api/lead-rotation', (req, res) => {
  const { next } = req.body;
  if (!['Kent', 'Vince'].includes(next)) return res.status(400).json({ error: 'Invalid' });
  fs.writeFileSync(ROTATION_PATH, JSON.stringify({ next }, null, 2));
  res.json({ success: true, next });
});

// ── SM Feedback (stub until API key arrives) ───────────────────────────────
app.post('/api/sm-feedback', (req, res) => {
  const { hashKey, score, note, contactMe } = req.body;
  if (!process.env.SM_API_KEY) {
    console.log('[SM Feedback stub]', { hashKey, score, note, contactMe });
    return res.json({ success: true, stub: true, message: 'SM_API_KEY not set — logged only' });
  }
  const body = JSON.stringify({ ApiKey: process.env.SM_API_KEY, HashKey: hashKey, Score: score, Note: note, ContactMe: !!contactMe });
  const reqSM = https.request({
    hostname: 'serviceminder.io',
    path: '/api/appointments/feedback',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, smRes => {
    let data = '';
    smRes.on('data', c => data += c);
    smRes.on('end', () => res.json({ success: smRes.statusCode === 200, status: smRes.statusCode, body: data }));
  });
  reqSM.on('error', err => res.status(500).json({ error: err.message }));
  reqSM.write(body);
  reqSM.end();
});


// -- Todos ------------------------------------------------------------------
app.get('/api/todos', (req, res) => {
  const prospects = readProspects();
  const todos = [];
  for (const p of prospects) {
    for (const t of (p.todos || [])) {
      if (!t.done) todos.push({ ...t, prospect: p.name, company: p.company || p.name });
    }
  }
  todos.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  res.json(todos);
});

app.post('/api/prospects/:name/todos', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const prospects = readProspects();
  const idx = prospects.findIndex(p => p.name === name);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const todo = { id: newId(), text: req.body.text, done: false, done_at: null, created_at: todayYmd() };
  if (!prospects[idx].todos) prospects[idx].todos = [];
  prospects[idx].todos.push(todo);
  writeProspects(prospects);
  res.json({ success: true, todo });
});

app.patch('/api/prospects/:name/todos/:id', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const prospects = readProspects();
  const idx = prospects.findIndex(p => p.name === name);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const todo = (prospects[idx].todos || []).find(t => t.id === req.params.id);
  if (!todo) return res.status(404).json({ error: 'Todo not found' });
  if ('done' in req.body) { todo.done = req.body.done; todo.done_at = req.body.done ? new Date().toISOString() : null; }
  if ('text' in req.body) todo.text = req.body.text;
  writeProspects(prospects);
  res.json({ success: true, todo });
});

app.delete('/api/prospects/:name/todos/:id', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const prospects = readProspects();
  const idx = prospects.findIndex(p => p.name === name);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const before = (prospects[idx].todos || []).length;
  prospects[idx].todos = (prospects[idx].todos || []).filter(t => t.id !== req.params.id);
  writeProspects(prospects);
  res.json({ success: before !== prospects[idx].todos.length });
});

// ── Review session (autosave / resume) ────────────────────────────────────
app.get('/api/review-session', (req, res) => {
  if (!fs.existsSync(SESSION_PATH)) return res.json(null);
  try {
    const s = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'));
    res.json(s.date === todayYmd() ? s : null);
  } catch { res.json(null); }
});

app.post('/api/review-session', (req, res) => {
  const { pos, skipped } = req.body;
  fs.writeFileSync(SESSION_PATH, JSON.stringify({ date: todayYmd(), pos, skipped: skipped || [] }));
  res.json({ ok: true });
});

app.listen(PORT, '0.0.0.0', () => console.log(`KG Dashboard running on :${PORT}`));
