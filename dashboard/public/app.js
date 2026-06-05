'use strict';

/* ── Constants ─────────────────────────────────────────────────────────── */
const STATUSES = [
  'New Lead', 'Working', 'Contacted - Responded', 'Contacted - Spoke',
  'Proposal Delivered', 'Inspection Complete', 'In 14-Day',
  'Cold', 'Closed Won', 'Closed Lost', 'Dormant',
];

const STATUS_CLS = {
  'New Lead':               'badge-blue',
  'Working':                'badge-green',
  'Contacted - Responded':  'badge-teal',
  'Contacted - Spoke':      'badge-teal',
  'Proposal Delivered':     'badge-purple',
  'Inspection Complete':    'badge-orange',
  'In 14-Day':              'badge-yellow',
  'Cold':                   'badge-gray',
  'Closed Won':             'badge-dkgreen',
  'Closed Lost':            'badge-gray',
  'Dormant':                'badge-gray',
};

const PRIORITY = {
  0: { label: 'OVERDUE',   cls: 'badge-red'   },
  1: { label: 'DUE TODAY', cls: 'badge-amber'  },
  2: { label: '14-DAY',    cls: 'badge-yellow' },
  3: { label: 'UPCOMING',  cls: 'badge-green'  },
  4: { label: 'NO DATE',   cls: 'badge-gray'   },
};

const PRIORITY_GROUPS = [
  { priority: 0, label: 'OVERDUE',  itemCls: 'overdue' },
  { priority: 1, label: 'TODAY',    itemCls: 'today'   },
  { priority: 2, label: '14-DAY',   itemCls: ''        },
  { priority: 3, label: 'UPCOMING', itemCls: ''        },
  { priority: 4, label: 'NO DATE',  itemCls: ''        },
];

/* ── State ──────────────────────────────────────────────────────────────── */
const state = {
  view: 'review',
  queue: [],
  originalQueueLen: 0,
  pos: 0,
  skipSet: new Set(),
  todos: [],
  sessionUpdated: 0,
  sessionSkipped: 0,
  stats: { total: 0, byStatus: {}, overdue: 0, dueToday: 0 },
  prospects: [],
  rotation: { next: 'Kent' },
  openPanel: null,       // 'note' | 'step' | null
  expandedNotes: {},
  expandedAtomo: {},
  prospectsFilter: { q: '', status: '', assigned: '' },
  expandedRows: new Set(),
};

/* ── API ─────────────────────────────────────────────────────────────────── */
async function apiFetch(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`API ${res.status} ${path}`);
  return res.json();
}

/* ── Toast ──────────────────────────────────────────────────────────────── */
function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('visible')));
  setTimeout(() => {
    el.classList.remove('visible');
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

/* ── Date utils ─────────────────────────────────────────────────────────── */
function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function tomorrowYmd() {
  const d = new Date(); d.setDate(d.getDate()+1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function daysAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Math.round((Date.now() - new Date(dateStr+'T12:00:00').getTime()) / 86400000);
  if (diff <= 0) return 'today';
  if (diff === 1) return '1 day ago';
  return `${diff} days ago`;
}
function dueDateCls(dateStr) {
  if (!dateStr) return 'date-none';
  const t = todayYmd();
  if (dateStr < t) return 'date-overdue';
  if (dateStr === t) return 'date-today';
  return 'date-future';
}
function fmtDate(dateStr) {
  if (!dateStr) return '—';
  const [y, m, d] = dateStr.split('-');
  return `${parseInt(m)}/${parseInt(d)}/${y.slice(2)}`;
}

/* ── HTML helpers ───────────────────────────────────────────────────────── */
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function badge(text, cls) {
  return `<span class="badge ${cls}">${esc(text)}</span>`;
}

function buildEmailTemplate(p) {
  const name = p.contact_person || 'there';
  const company = p.company || p.name || '';
  const status = p.status || '';

  let subject, opening;
  if (status === 'Inspection Complete') {
    subject = `Kitchen Guard Proposal — ${company}`;
    opening = `I wanted to follow up after our inspection at ${company} and get you a proposal for our hood cleaning service.`;
  } else if (status === 'Proposal Delivered') {
    subject = `Following Up — Kitchen Guard Proposal for ${company}`;
    opening = `I wanted to check in on the proposal I sent over for ${company} and see if you had any questions.`;
  } else if (status === 'In 14-Day') {
    subject = `Kitchen Guard — ${company} Service Schedule`;
    opening = `I'm reaching out to confirm your upcoming Kitchen Guard hood cleaning service at ${company}.`;
  } else if (status === 'Contacted - Responded' || status === 'Contacted - Spoke') {
    subject = `Kitchen Guard — ${company}`;
    opening = `Good to connect with you! Following up as promised about Kitchen Guard hood cleaning services for ${company}.`;
  } else {
    subject = `Kitchen Guard — ${company}`;
    opening = `I'm reaching out about hood cleaning services for ${company} through Kitchen Guard.`;
  }

  const nextLine = p.next_step ? ('Next step: ' + p.next_step) : "Happy to set up a time to connect.";
  const body = `Hi ${name},\n\n${opening}\n\n${nextLine}\n\nPlease give me a call or reply to this email with any questions.\n\nBest,\nKent Seevers\nKitchen Guard`;

  return { subject, body };
}

/* ── Stats ──────────────────────────────────────────────────────────────── */
async function loadStats() {
  try {
    state.stats = await apiFetch('GET', '/api/stats');
    document.getElementById('hstat-total').textContent   = state.stats.total;
    document.getElementById('hstat-overdue').textContent = state.stats.overdue;
    document.getElementById('hstat-today').textContent   = state.stats.dueToday;
  } catch(e) { console.error('stats:', e); }
}

/* ── Queue ──────────────────────────────────────────────────────────────── */
async function loadTodos() {
  try {
    state.todos = await apiFetch('GET', '/api/todos');
    const badge = document.getElementById('tasks-badge');
    if (badge) badge.textContent = state.todos.length || '';
  } catch(e) { console.error('todos:', e); }
}

async function loadQueue() {
  state.queue = await apiFetch('GET', '/api/review-queue');
  state.originalQueueLen = state.queue.length;
  state.pos = 0;
  state.skipSet.clear();
  state.sessionUpdated = 0;
  state.sessionSkipped = 0;
}

function isSessionDone() {
  return state.pos >= (state.queue.length - state.skipSet.size);
}

/* ── Router ─────────────────────────────────────────────────────────────── */
function switchView(view) {
  state.view = view;
  document.querySelectorAll('.nbtn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${view}`).classList.add('active');

  if (view === 'dashboard') renderDashboard();
  if (view === 'review')    renderReview();
  if (view === 'prospects') renderProspects();
  if (view === 'routing')   renderRouting();
  if (view === 'tasks')     renderTasks();
}

/* ══════════════════════════════════════════════════════════════════════════
   DASHBOARD HOME
   ══════════════════════════════════════════════════════════════════════════ */
function renderDashboard() {
  const el = document.getElementById('view-dashboard');
  const s  = state.stats;
  const q  = state.queue;
  const today = todayYmd();

  // Active status counts (only statuses that matter for dashboard)
  const activeStatuses = STATUSES.slice(0, 7);
  const maxCount = Math.max(...activeStatuses.map(st => s.byStatus[st] || 0), 1);

  const statusBars = activeStatuses.map(st => {
    const count = s.byStatus[st] || 0;
    const pct   = Math.round((count / maxCount) * 100);
    const cls   = STATUS_CLS[st] || 'badge-gray';
    const color = {
      'badge-blue':    '#3b82f6', 'badge-green':   '#22c55e',
      'badge-teal':    '#14b8a6', 'badge-purple':  '#a855f7',
      'badge-orange':  '#f97316', 'badge-yellow':  '#eab308',
      'badge-dkgreen': '#4ade80', 'badge-gray':    '#6b7280',
    }[cls] || '#6b7280';
    return `
      <div class="status-row">
        <div class="status-name">${esc(st)}</div>
        <div class="status-bar-wrap"><div class="status-bar-fill" style="width:${pct}%;background:${color}"></div></div>
        <div class="status-count">${count}</div>
      </div>`;
  }).join('');

  // Top priority items
  const topItems = q.slice(0, 7).map(p => {
    const dotCls = p.priority === 0 ? 'overdue' : p.priority === 1 ? 'today' : 'other';
    const dtCls  = dueDateCls(p.next_step_date);
    return `
      <div class="dash-priority-item" data-name="${esc(p.name)}">
        <div class="dpi-dot ${dotCls}"></div>
        <div style="flex:1;min-width:0">
          <div class="dpi-name">${esc(p.company || p.name)}</div>
          <div class="dpi-meta">${esc(p.status)} · ${esc(p.city || '')}</div>
        </div>
        <div class="dpi-date ${dtCls}">${p.next_step_date ? fmtDate(p.next_step_date) : '—'}</div>
      </div>`;
  }).join('');

  const activeCount = q.length;

  el.innerHTML = `
    <div class="dash-stat-row">
      <div class="dash-stat danger">
        <div class="dash-stat-n">${s.overdue || 0}</div>
        <div class="dash-stat-l">OVERDUE</div>
      </div>
      <div class="dash-stat warn">
        <div class="dash-stat-n">${s.dueToday || 0}</div>
        <div class="dash-stat-l">DUE TODAY</div>
      </div>
      <div class="dash-stat">
        <div class="dash-stat-n">${activeCount}</div>
        <div class="dash-stat-l">IN QUEUE</div>
      </div>
      <div class="dash-stat">
        <div class="dash-stat-n">${s.total || 0}</div>
        <div class="dash-stat-l">TOTAL PROSPECTS</div>
      </div>
    </div>

    <div class="dash-row">
      <div class="dash-panel" style="flex:1">
        <div class="dash-panel-head">
          <span>TOP PRIORITY</span>
          <span style="color:var(--text-faint)">${activeCount} TOTAL IN QUEUE</span>
        </div>
        <div class="dash-panel-body">
          ${topItems || '<div class="empty-state">ALL CLEAR</div>'}
        </div>
      </div>

      <div class="dash-review-cta">
        <div class="dash-cta-label">READY TO REVIEW</div>
        <div class="dash-cta-title">Pipeline Review</div>
        <div class="dash-cta-stats">
          <div class="dash-cta-stat"><span class="n">${s.overdue || 0}</span> overdue</div>
          <div class="dash-cta-stat"><span class="n">${s.dueToday || 0}</span> due today</div>
          <div class="dash-cta-stat"><span class="n">${activeCount}</span> total in queue</div>
        </div>
        <button class="dash-cta-btn" id="cta-start-review">START REVIEW →</button>
      </div>

      <div class="dash-panel" style="flex:0 0 280px">
        <div class="dash-panel-head"><span>PIPELINE BY STATUS</span></div>
        <div class="dash-panel-body">${statusBars}</div>
      </div>
    </div>
  `;

  document.getElementById('cta-start-review').addEventListener('click', () => switchView('review'));
  document.querySelectorAll('.dash-priority-item[data-name]').forEach(item => {
    item.addEventListener('click', () => {
      const name = item.dataset.name;
      const idx  = state.queue.findIndex(p => p.name === name);
      if (idx !== -1) { state.pos = idx; switchView('review'); }
    });
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   PIPELINE REVIEW
   ══════════════════════════════════════════════════════════════════════════ */
function renderReview() {
  const el = document.getElementById('view-review');
  if (isSessionDone()) { renderSessionDone(el); return; }

  const prospect = state.queue[state.pos];
  const reviewed = state.pos;
  const total    = state.queue.length - state.skipSet.size;
  const pct      = total > 0 ? Math.round((reviewed / total) * 100) : 0;

  el.innerHTML = `
    <div class="progress-wrap">
      <div class="progress-label">
        <span>${reviewed} OF ${total} REVIEWED THIS SESSION</span>
        <span>${pct}%</span>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
    </div>
    <div class="review-body">
      <div class="review-main">
        ${renderCard(prospect)}
        ${renderActionBar(prospect)}
        <div class="key-hint">
          <kbd>→</kbd> next &nbsp; <kbd>←</kbd> prev &nbsp; <kbd>S</kbd> skip &nbsp; <kbd>N</kbd> note &nbsp; <kbd>T</kbd> next step
        </div>
      </div>
      <div class="review-sidebar">${renderSidebar()}</div>
    </div>
  `;
  bindCardEvents(prospect);
}

function renderCard(p) {
  const statusCls = STATUS_CLS[p.status] || 'badge-gray';
  const pMeta     = PRIORITY[p.priority] || PRIORITY[4];
  const today     = todayYmd();
  const nextDtCls = dueDateCls(p.next_step_date);

  const tempPill = p.temperature ? `<span class="badge temp-${p.temperature.toLowerCase()}">${esc(p.temperature.toUpperCase())}</span>` : '';
  const assignCls = (p.assigned_to || '').toLowerCase() === 'vince' ? 'pill-vince' : 'pill-kent';
  const assignPill = p.assigned_to ? `<span class="badge ${assignCls}">${esc(p.assigned_to.toUpperCase())}</span>` : '';

  const notesId = `notes-${p.name}`;
  const atomoId = `atomo-${p.name}`;
  const notesExp  = state.expandedNotes[p.name];
  const atomoExp  = state.expandedAtomo[p.name];

  const nextStepHtml = p.next_step
    ? `<span>${esc(p.next_step)}</span> &nbsp; <span class="${nextDtCls}">${p.next_step_date ? fmtDate(p.next_step_date) : ''}</span>`
    : `<span class="date-none">—</span>`;

  const notesHtml = p.notes
    ? `<div class="notes-section">
        <button class="notes-toggle ${notesExp ? 'open':''}" data-toggle="notes">
          <span class="arrow">▶</span> NOTES
        </button>
        <div id="${esc(notesId)}" class="notes-body ${notesExp ? 'expanded':''}">
          ${esc(p.notes)}
        </div>
        ${!notesExp && p.notes.length > 140 ? `<button class="notes-more" data-toggle="notes">show more</button>` : ''}
      </div>` : '';

  const atomoHtml = p.atomo_notes
    ? `<div class="notes-section">
        <button class="notes-toggle ${atomoExp ? 'open':''}" data-toggle="atomo">
          <span class="arrow">▶</span> ATOMO NOTES
        </button>
        <div id="${esc(atomoId)}" class="notes-body ${atomoExp ? 'expanded':''}">
          ${esc(p.atomo_notes)}
        </div>
        ${!atomoExp && p.atomo_notes.length > 140 ? `<button class="notes-more" data-toggle="atomo">show more</button>` : ''}
      </div>` : '';

  return `
    <div class="pcard">
      <div class="pcard-head">
        <div class="pcard-name">${esc(p.company || p.name)}</div>
        <div class="pcard-loc">${esc([p.city, p.state].filter(Boolean).join(', '))}</div>
        <div class="badge-row">
          ${badge(p.status, statusCls)}
          ${badge(pMeta.label, pMeta.cls)}
          ${tempPill}
          ${assignPill}
        </div>
      </div>
      <div class="pcard-body">
        <div class="field-row">
          <div class="field">
            <span class="field-lbl">CONTACT</span>
            <span class="field-val">${esc(p.contact_person || '—')}</span>
          </div>
          <div class="field">
            <span class="field-lbl">PHONE</span>
            <span class="field-val">
              ${p.phone ? `<a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>` : '—'}
            </span>
          </div>
          <div class="field">
            <span class="field-lbl">EMAIL</span>
            <span class="field-val">
              ${p.email ? `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : '—'}
            </span>
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <span class="field-lbl">NEXT STEP</span>
            <span class="field-val">${nextStepHtml}</span>
          </div>
          <div class="field">
            <span class="field-lbl">LAST ACTIVITY</span>
            <span class="field-val ${dueDateCls(p.last_activity_date) === 'date-overdue' ? '' : ''}">
              ${p.last_activity_date ? `${fmtDate(p.last_activity_date)} (${daysAgo(p.last_activity_date)})` : '—'}
            </span>
          </div>
        </div>
        ${notesHtml}
        ${atomoHtml}
      </div>
    </div>
  `;
}

function renderActionBar(p) {
  const statusOpts = STATUSES.map(s =>
    `<option value="${esc(s)}" ${p.status===s?'selected':''}>${esc(s)}</option>`
  ).join('');

  return `
    <div class="action-bar">
      <div class="action-row">
        <select class="action-select" id="status-select">
          <option value="">UPDATE STATUS…</option>
          ${statusOpts}
        </select>
        <button class="abtn" id="btn-note">ADD NOTE</button>
        <button class="abtn" id="btn-step">SET NEXT STEP</button>
        <button class="abtn abtn-email" id="btn-email">✉ EMAIL</button>
        <button class="abtn abtn-skip" id="btn-skip">SKIP →</button>
        <button class="abtn abtn-primary" id="btn-done">DONE FOR TODAY</button>
      </div>
      <div class="action-panel" id="panel-note">
        <textarea id="note-input" placeholder="Add a note…" rows="3"></textarea>
        <div class="action-row">
          <button class="abtn abtn-primary" id="btn-save-note">SAVE NOTE</button>
          <button class="abtn" id="btn-cancel-note">CANCEL</button>
        </div>
      </div>
      <div class="action-panel" id="panel-step">
        <div class="panel-row">
          <span class="panel-lbl">STEP</span>
          <input type="text" id="step-input" placeholder="What's the next step?" value="${esc(p.next_step||'')}">
        </div>
        <div class="panel-row">
          <span class="panel-lbl">DATE</span>
          <input type="date" id="step-date" value="${esc(p.next_step_date||'')}">
        </div>
        <div class="action-row">
          <button class="abtn abtn-primary" id="btn-save-step">SAVE</button>
          <button class="abtn" id="btn-cancel-step">CANCEL</button>
        </div>
      </div>
      <div class="action-panel" id="panel-email">
        <div class="panel-row">
          <span class="panel-lbl">TO</span>
          <span class="panel-email-to" id="email-to-display">${esc(p.email || '(no email on file)')}</span>
        </div>
        <div class="panel-row">
          <span class="panel-lbl">SUBJECT</span>
          <input type="text" id="email-subject" style="flex:1">
        </div>
        <div class="panel-row" style="align-items:flex-start">
          <span class="panel-lbl" style="padding-top:6px">BODY</span>
          <textarea id="email-body" rows="6" style="flex:1;font-family:inherit;font-size:13px;background:var(--bg);color:var(--text);border:1px solid var(--border);padding:8px;resize:vertical"></textarea>
        </div>
        <div class="action-row">
          <button class="abtn abtn-email" id="btn-send-email"${p.email ? '' : ' disabled title="No email on file"'}>OPEN IN MAIL CLIENT</button>
          <button class="abtn" id="btn-cancel-email">CANCEL</button>
        </div>
      </div>
    </div>
  `;
}

function renderSidebar() {
  const groups = PRIORITY_GROUPS.map(g => {
    const items = state.queue.filter((p, i) => p.priority === g.priority);
    if (!items.length) return '';
    const itemsHtml = items.map((p, _) => {
      const qIdx = state.queue.indexOf(p);
      const isCurrent = qIdx === state.pos;
      const isSkipped = state.skipSet.has(p.name);
      return `<div class="sidebar-item ${isCurrent ? 'current' : ''} ${g.itemCls}"
                   data-qidx="${qIdx}" style="${isSkipped ? 'opacity:.4' : ''}">
        ${esc((p.company || p.name).slice(0, 26))}
      </div>`;
    }).join('');
    return `<div class="sidebar-group">
      <div class="sidebar-group-label">${g.label} (${items.length})</div>
      ${itemsHtml}
    </div>`;
  }).join('');

  return groups || '<div class="empty-state">QUEUE EMPTY</div>';
}

function renderSessionDone(el) {
  el.innerHTML = `
    <div class="session-done">
      <div class="done-icon">✦</div>
      <div class="done-title">SESSION COMPLETE</div>
      <div class="done-stats">
        <div class="done-stat"><div class="n">${state.sessionUpdated}</div><div class="l">UPDATED</div></div>
        <div class="done-stat"><div class="n">${state.sessionSkipped}</div><div class="l">SKIPPED</div></div>
      </div>
      <button class="abtn abtn-primary" id="btn-restart">START OVER</button>
    </div>
  `;
  document.getElementById('btn-restart').addEventListener('click', async () => {
    await loadQueue();
    await loadStats();
    renderReview();
  });
}

/* ── Card event binding ─────────────────────────────────────────────────── */
function bindCardEvents(p) {
  // Notes toggles
  document.querySelectorAll('[data-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.toggle;
      if (key === 'notes') {
        state.expandedNotes[p.name] = !state.expandedNotes[p.name];
      } else {
        state.expandedAtomo[p.name] = !state.expandedAtomo[p.name];
      }
      renderReview();
    });
  });

  // Status select
  document.getElementById('status-select').addEventListener('change', async e => {
    const status = e.target.value;
    if (!status) return;
    await doUpdateStatus(p.name, { status });
  });

  // Panel buttons
  document.getElementById('btn-note').addEventListener('click', () => togglePanel('note'));
  document.getElementById('btn-step').addEventListener('click', () => togglePanel('step'));
  document.getElementById('btn-cancel-note').addEventListener('click', () => togglePanel(null));
  document.getElementById('btn-cancel-step').addEventListener('click', () => togglePanel(null));

  document.getElementById('btn-save-note').addEventListener('click', async () => {
    const val = document.getElementById('note-input').value.trim();
    if (!val) return;
    await doUpdateStatus(p.name, { atomo_notes: val }, false);
  });

  document.getElementById('btn-save-step').addEventListener('click', async () => {
    const step = document.getElementById('step-input').value.trim();
    const date = document.getElementById('step-date').value;
    if (!step && !date) return;
    await doUpdateStatus(p.name, { next_step: step, next_step_date: date }, false);
  });

  document.getElementById('btn-email').addEventListener('click', () => {
    if (state.openPanel !== 'email') {
      const { subject, body } = buildEmailTemplate(p);
      document.getElementById('email-subject').value = subject;
      document.getElementById('email-body').value = body;
    }
    togglePanel('email');
  });

  document.getElementById('btn-cancel-email').addEventListener('click', () => togglePanel(null));

  document.getElementById('btn-send-email').addEventListener('click', () => {
    const to = p.email || '';
    const subject = document.getElementById('email-subject').value;
    const body = document.getElementById('email-body').value;
    if (!to) { toast('No email address on file', 'error'); return; }
    const mailto = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.open(mailto, '_blank');
    toast('Opened in mail client');
    togglePanel(null);
  });

  document.getElementById('btn-skip').addEventListener('click', doSkip);
  document.getElementById('btn-done').addEventListener('click', () => doDoneForToday(p.name));

  // Sidebar clicks
  document.querySelectorAll('.sidebar-item[data-qidx]').forEach(item => {
    item.addEventListener('click', () => {
      const idx = parseInt(item.dataset.qidx);
      state.pos = idx;
      state.openPanel = null;
      renderReview();
    });
  });
}

function togglePanel(which) {
  state.openPanel = state.openPanel === which ? null : which;
  const notePanel  = document.getElementById('panel-note');
  const stepPanel  = document.getElementById('panel-step');
  const emailPanel = document.getElementById('panel-email');
  if (notePanel)  notePanel.classList.toggle('open',  state.openPanel === 'note');
  if (stepPanel)  stepPanel.classList.toggle('open',  state.openPanel === 'step');
  if (emailPanel) emailPanel.classList.toggle('open', state.openPanel === 'email');
}

/* ── Session autosave ───────────────────────────────────────────────────── */
async function saveSession() {
  try {
    await apiFetch('POST', '/api/review-session', {
      pos: state.pos,
      skipped: [...state.skipSet],
    });
  } catch(e) { /* silent — don't interrupt the review */ }
}

/* ── Actions ────────────────────────────────────────────────────────────── */
async function doUpdateStatus(name, updates, advance = true) {
  try {
    await apiFetch('PATCH', `/api/prospects/${encodeURIComponent(name)}`, updates);
    if (updates.status) toast(`STATUS → ${updates.status}`);
    else if (updates.atomo_notes) toast('NOTE SAVED');
    else toast('UPDATED');
    state.sessionUpdated++;
    state.skipSet.delete(name);
    const qIdx = state.queue.findIndex(q => q.name === name);
    if (qIdx >= 0) Object.assign(state.queue[qIdx], updates);
    if (advance) {
      state.pos++;
      state.openPanel = null;
    }
    saveSession();
    await loadStats();
    renderReview();
  } catch(e) {
    toast('Update failed', 'error');
  }
}

function doSkip() {
  const item = state.queue.splice(state.pos, 1)[0];
  state.skipSet.add(item.name);
  state.queue.push(item);
  state.sessionSkipped++;
  state.openPanel = null;
  saveSession();
  renderReview();
}

async function doDoneForToday(name) {
  await doUpdateStatus(name, { next_step: 'Follow up', next_step_date: tomorrowYmd() });
}

/* ══════════════════════════════════════════════════════════════════════════
   PROSPECTS LIST
   ══════════════════════════════════════════════════════════════════════════ */
async function loadProspects() {
  const { q, status, assigned } = state.prospectsFilter;
  const params = new URLSearchParams();
  if (q)        params.set('q', q);
  if (status)   params.set('status', status);
  if (assigned) params.set('assigned_to', assigned);
  state.prospects = await apiFetch('GET', `/api/prospects?${params}`);
}

async function renderProspects() {
  const el = document.getElementById('view-prospects');
  el.innerHTML = '<div class="empty-state">LOADING…</div>';
  try {
    await loadProspects();
  } catch(e) {
    el.innerHTML = '<div class="empty-state">LOAD FAILED</div>';
    return;
  }

  const today = todayYmd();
  const { q, status, assigned } = state.prospectsFilter;

  const statusOpts = ['', ...STATUSES].map(s =>
    `<option value="${esc(s)}" ${status===s?'selected':''}>${s || 'ALL STATUSES'}</option>`
  ).join('');

  const rows = state.prospects.map(p => {
    const isOverdue = p.next_step_date && p.next_step_date < today && STATUSES.slice(0,7).includes(p.status);
    const dtCls     = dueDateCls(p.next_step_date);
    const isExp     = state.expandedRows.has(p.name);
    const sCls      = STATUS_CLS[p.status] || 'badge-gray';

    const detail = isExp ? `
      <tr class="expanded"><td colspan="8">
        <div class="expand-detail">
          <div class="field-row">
            <div class="field"><span class="field-lbl">PHONE</span>
              <span class="field-val">${p.phone ? `<a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>` : '—'}</span>
            </div>
            <div class="field"><span class="field-lbl">EMAIL</span>
              <span class="field-val">${p.email ? `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : '—'}</span>
            </div>
            <div class="field"><span class="field-lbl">ASSIGNED</span>
              <span class="field-val">${esc(p.assigned_to||'—')}</span>
            </div>
            <div class="field"><span class="field-lbl">TEMP</span>
              <span class="field-val">${p.temperature ? `<span class="badge temp-${p.temperature.toLowerCase()}">${esc(p.temperature)}</span>` : '—'}</span>
            </div>
          </div>
          ${p.notes ? `<div class="field"><span class="field-lbl">NOTES</span><span class="field-val" style="font-size:12px;color:var(--text-dim)">${esc(p.notes.slice(0,300))}${p.notes.length>300?'…':''}</span></div>` : ''}
          ${p.atomo_notes ? `<div class="field"><span class="field-lbl">ATOMO</span><span class="field-val" style="font-size:12px;color:var(--text-dim)">${esc(p.atomo_notes.slice(0,300))}${p.atomo_notes.length>300?'…':''}</span></div>` : ''}
        </div>
      </td></tr>` : '';

    return `
      <tr class="${isOverdue ? 'overdue-row':''} ${isExp ? 'expanded':''}" data-name="${esc(p.name)}">
        <td><div class="td-name">${esc(p.company||p.name)}</div></td>
        <td><div class="td-city">${esc(p.city||'')}</div></td>
        <td>${badge(p.status, sCls)}</td>
        <td><div>${esc(p.contact_person||'—')}</div></td>
        <td><div class="td-step">${esc(p.next_step||'—')}</div></td>
        <td><div class="td-date ${dtCls}">${p.next_step_date ? fmtDate(p.next_step_date) : '—'}</div></td>
        <td><div class="td-activity">${p.last_activity_date ? fmtDate(p.last_activity_date) : '—'}</div></td>
        <td><div style="font-size:11px;color:var(--text-dim)">${esc(p.assigned_to||'')}</div></td>
      </tr>
      ${detail}
    `;
  }).join('');

  el.innerHTML = `
    <div class="filter-bar">
      <input class="search-input" id="search-q" type="text" placeholder="SEARCH NAME, CITY, CONTACT…" value="${esc(q)}">
      <button class="filter-chip ${!status&&!assigned?'active':''}" data-filter="all">ALL</button>
      <button class="filter-chip ${status==='__active'?'active':''}" data-filter="active">ACTIVE</button>
      <button class="filter-chip ${status==='__overdue'?'active':''}" data-filter="overdue">OVERDUE</button>
      <select class="filter-select" id="filter-status">${statusOpts}</select>
      <select class="filter-select" id="filter-assigned">
        <option value="" ${!assigned?'selected':''}>ALL REPS</option>
        <option value="Kent" ${assigned==='Kent'?'selected':''}>KENT</option>
        <option value="Vince" ${assigned==='Vince'?'selected':''}>VINCE</option>
      </select>
      <span style="margin-left:auto;font-size:10px;color:var(--text-dim);letter-spacing:1px">${state.prospects.length} RESULTS</span>
    </div>
    <div style="overflow-x:auto;flex:1">
      <table class="prospects-table" id="prospects-tbl">
        <thead>
          <tr>
            <th>NAME / COMPANY</th><th>CITY</th><th>STATUS</th>
            <th>CONTACT</th><th>NEXT STEP</th><th>DUE DATE</th>
            <th>LAST ACTIVITY</th><th>REP</th>
          </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="8"><div class="empty-state">NO RESULTS</div></td></tr>'}</tbody>
      </table>
    </div>
  `;

  bindProspectsEvents();
}

function bindProspectsEvents() {
  const searchEl = document.getElementById('search-q');
  let searchTimer;
  searchEl.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.prospectsFilter.q = searchEl.value;
      renderProspects();
    }, 300);
  });

  document.querySelectorAll('[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      const f = btn.dataset.filter;
      if (f === 'all')     { state.prospectsFilter.status = ''; state.prospectsFilter.assigned = ''; }
      if (f === 'active')  state.prospectsFilter.status = '__active';
      if (f === 'overdue') state.prospectsFilter.status = '__overdue';
      renderProspects();
    });
  });

  document.getElementById('filter-status').addEventListener('change', e => {
    state.prospectsFilter.status = e.target.value;
    renderProspects();
  });
  document.getElementById('filter-assigned').addEventListener('change', e => {
    state.prospectsFilter.assigned = e.target.value;
    renderProspects();
  });

  document.getElementById('prospects-tbl').querySelector('tbody').addEventListener('click', e => {
    const row = e.target.closest('tr[data-name]');
    if (!row) return;
    const name = row.dataset.name;
    if (state.expandedRows.has(name)) state.expandedRows.delete(name);
    else state.expandedRows.add(name);
    renderProspects();
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   LEAD ROUTING
   ══════════════════════════════════════════════════════════════════════════ */
async function loadRotation() {
  try {
    state.rotation = await apiFetch('GET', '/api/lead-rotation');
  } catch(e) { console.error('rotation:', e); }
}

function renderRouting() {
  const el = document.getElementById('view-routing');
  const cur = state.rotation.next || 'Kent';
  el.innerHTML = `
    <div class="routing-card">
      <div class="routing-title">LEAD ROUTING</div>
      <div class="routing-label">Next new lead goes to:</div>
      <div class="routing-btns">
        <button class="routing-btn ${cur==='Kent'?'active':''}" data-assign="Kent">KENT</button>
        <button class="routing-btn ${cur==='Vince'?'active':''}" data-assign="Vince">VINCE</button>
      </div>
    </div>
  `;
  el.querySelectorAll('.routing-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const next = btn.dataset.assign;
      try {
        await apiFetch('PUT', '/api/lead-rotation', { next });
        state.rotation.next = next;
        toast(`NEXT LEAD → ${next}`);
        renderRouting();
      } catch(e) { toast('Update failed', 'error'); }
    });
  });
}

/* ── Keyboard shortcuts ─────────────────────────────────────────────────── */
function setupKeyboard() {
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (state.view !== 'review') return;
    if (e.key === 'ArrowRight' || e.key === ' ') {
      e.preventDefault();
      if (!isSessionDone()) { state.pos++; state.openPanel = null; renderReview(); }
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (state.pos > 0) { state.pos--; state.openPanel = null; renderReview(); }
    }
    if (e.key === 's' || e.key === 'S') { e.preventDefault(); doSkip(); }
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); togglePanel('note'); }
    if (e.key === 't' || e.key === 'T') { e.preventDefault(); togglePanel('step'); }
  });
}

/* ── Nav ────────────────────────────────────────────────────────────────── */
document.querySelectorAll('.nbtn, [data-view]').forEach(btn => {
  btn.addEventListener('click', () => { if (btn.dataset.view) switchView(btn.dataset.view); });
});

/* ── Init ───────────────────────────────────────────────────────────────── */

/* ══════════════════════════════════════════════════════════════════════════
   TASKS
   ══════════════════════════════════════════════════════════════════════════ */
function renderTasks() {
  const el = document.getElementById('view-tasks');
  const todos = state.todos;

  // Group by prospect
  const byProspect = {};
  for (const t of todos) {
    if (!byProspect[t.prospect]) byProspect[t.prospect] = { company: t.company, items: [] };
    byProspect[t.prospect].items.push(t);
  }

  const addForm = `
    <div class="tasks-add-row">
      <select id="todo-prospect-select" class="action-select" style="flex:1">
        <option value="">Select account...</option>
      </select>
      <input id="todo-text-input" class="todo-text-input" placeholder="Task description..." style="flex:2">
      <button class="abtn abtn-primary" id="btn-add-todo">+ ADD TASK</button>
    </div>`;

  const groups = Object.entries(byProspect).map(([name, g]) => {
    const items = g.items.map(t => `
      <div class="todo-item" data-id="${esc(t.id)}" data-prospect="${esc(t.prospect)}">
        <button class="todo-check" data-id="${esc(t.id)}" data-prospect="${esc(t.prospect)}">&#x25A1;</button>
        <span class="todo-text">${esc(t.text)}</span>
      </div>`).join('');
    return `
      <div class="todo-group">
        <div class="todo-group-name">${esc(g.company)}</div>
        ${items}
      </div>`;
  }).join('');

  el.innerHTML = `
    <div class="view-header">
      <div class="view-title">TASKS <span class="badge badge-gray">${todos.length} open</span></div>
    </div>
    <div class="tasks-body">
      ${addForm}
      ${groups || '<div class="empty-state">No open tasks.</div>'}
    </div>`;

  // Populate prospect select
  const sel = document.getElementById('todo-prospect-select');
  if (sel) {
    apiFetch('GET', '/api/prospects').then(all => {
      all.filter(p => p.status === 'Closed Won' || (p.todos && p.todos.length))
         .sort((a,b) => (a.company||a.name).localeCompare(b.company||b.name))
         .forEach(p => {
           const o = document.createElement('option');
           o.value = p.name; o.textContent = p.company || p.name;
           sel.appendChild(o);
         });
    }).catch(()=>{});
  }

  // Check off
  el.querySelectorAll('.todo-check').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { id, prospect } = btn.dataset;
      await apiFetch('PATCH', `/api/prospects/${encodeURIComponent(prospect)}/todos/${id}`, { done: true });
      await loadTodos();
      renderTasks();
    });
  });

  // Add task
  const addBtn = document.getElementById('btn-add-todo');
  if (addBtn) {
    addBtn.addEventListener('click', async () => {
      const prospect = document.getElementById('todo-prospect-select').value;
      const text = document.getElementById('todo-text-input').value.trim();
      if (!prospect || !text) return;
      await apiFetch('POST', `/api/prospects/${encodeURIComponent(prospect)}/todos`, { text });
      await loadTodos();
      renderTasks();
    });
  }
}

async function init() {
  try {
    await Promise.all([loadStats(), loadQueue(), loadRotation(), loadTodos()]);

    // Restore session position if one was saved today
    try {
      const session = await apiFetch('GET', '/api/review-session');
      if (session && session.pos > 0) {
        state.pos = Math.min(session.pos, Math.max(0, state.queue.length - 1));
        state.skipSet = new Set(session.skipped || []);
        toast(`RESUMED — ${state.pos} of ${state.queue.length} reviewed`, 'info');
      }
    } catch(e) { /* no saved session, start fresh */ }

    setupKeyboard();
    renderDashboard();
  } catch(e) {
    document.getElementById('view-dashboard').innerHTML =
      `<div class="empty-state">FAILED TO CONNECT — IS THE SERVER RUNNING?<br>${esc(e.message)}</div>`;
    console.error('init:', e);
  }
}

init();
