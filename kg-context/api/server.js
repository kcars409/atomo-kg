const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const app = express();
const PORT = 3100;
const PROSPECTS_PATH = path.join(__dirname, '..', 'prospects.json');
const CC_SCRIPT = '/home/kent/scripts/kg-cc-inspection.js';

app.use(cors());
app.use(express.json());

const CLOSED_STATUSES = new Set(['closed won', 'closed lost']);

function loadProspects() {
  return JSON.parse(fs.readFileSync(PROSPECTS_PATH, 'utf8'));
}

function saveProspects(prospects) {
  const bak = PROSPECTS_PATH + '.bak';
  const bak2 = PROSPECTS_PATH + '.bak2';
  const bak3 = PROSPECTS_PATH + '.bak3';
  try {
    if (fs.existsSync(bak2)) fs.renameSync(bak2, bak3);
    if (fs.existsSync(bak)) fs.renameSync(bak, bak2);
    if (fs.existsSync(PROSPECTS_PATH)) fs.copyFileSync(PROSPECTS_PATH, bak);
  } catch (_) {}
  fs.writeFileSync(PROSPECTS_PATH, JSON.stringify(prospects, null, 2));
}

// GET /api/prospects
// Query params:
//   ?owner=Kent         filter by owner (partial, case-insensitive)
//   ?status=Active      filter by status (partial, case-insensitive)
//   ?active=true        exclude closed won/lost (default: true)
//   ?overdue=true       only records where next_step_date <= today
//   ?q=search           search name/company/contact_person
app.get('/api/prospects', (req, res) => {
  try {
    let data = loadProspects();
    const today = new Date().toISOString().slice(0, 10);

    const activeOnly = req.query.active !== 'false';
    if (activeOnly) {
      data = data.filter(p => !CLOSED_STATUSES.has((p.status || '').toLowerCase()));
    }

    if (req.query.owner) {
      const ownerQ = req.query.owner.toLowerCase();
      data = data.filter(p => (p.owner || '').toLowerCase().includes(ownerQ));
    }

    if (req.query.status) {
      const statusQ = req.query.status.toLowerCase();
      data = data.filter(p => (p.status || '').toLowerCase().includes(statusQ));
    }

    if (req.query.overdue === 'true') {
      data = data.filter(p => p.next_step_date && p.next_step_date <= today);
    }

    if (req.query.q) {
      const q = req.query.q.toLowerCase();
      data = data.filter(p =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.company || '').toLowerCase().includes(q) ||
        (p.contact_person || '').toLowerCase().includes(q)
      );
    }

    res.json({ count: data.length, prospects: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prospects/:name  (URL-encoded name)
app.get('/api/prospects/:name', (req, res) => {
  try {
    const data = loadProspects();
    const target = decodeURIComponent(req.params.name).toLowerCase();
    const match = data.find(p => (p.name || '').toLowerCase() === target);
    if (!match) return res.status(404).json({ error: 'Not found' });
    res.json(match);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/prospects/:name/inspection/complete
// Marks inspection_complete=true and pulls CompanyCam data.
app.post('/api/prospects/:name/inspection/complete', (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const prospects = loadProspects();
    const idx = prospects.findIndex(p =>
      (p.name || '').toLowerCase() === name.toLowerCase() ||
      (p.company || '').toLowerCase() === name.toLowerCase()
    );
    if (idx === -1) return res.status(404).json({ error: 'Prospect not found' });

    const now = new Date().toISOString();
    prospects[idx].inspection_complete = true;
    prospects[idx].inspection_completed_at = now;
    if (prospects[idx].inspection_meeting && !prospects[idx].inspection_meeting.completed_at) {
      prospects[idx].inspection_meeting.completed_at = now;
      prospects[idx].inspection_meeting.outcome = prospects[idx].inspection_meeting.outcome || 'completed';
    }
    prospects[idx].last_updated = now;
    saveProspects(prospects);

    // CC pull - synchronous but non-fatal
    let ccResult = null;
    const cc = spawnSync('node', [CC_SCRIPT, name], { encoding: 'utf8', timeout: 30000 });
    if (!cc.error) {
      try {
        const ccData = JSON.parse(cc.stdout);
        if (ccData.found) {
          const fresh = loadProspects();
          const i = fresh.findIndex(p =>
            (p.name || '').toLowerCase() === name.toLowerCase() ||
            (p.company || '').toLowerCase() === name.toLowerCase()
          );
          if (i >= 0) {
            fresh[i].companycam_data = ccData;
            fresh[i].last_updated = new Date().toISOString();
            saveProspects(fresh);
          }
          ccResult = { found: true, project: ccData.project_name };
        } else {
          ccResult = { found: false, reason: ccData.reason };
        }
      } catch (_) {}
    }

    res.json({ ok: true, inspection_complete: true, companycam: ccResult });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/health
app.get('/api/health', (req, res) => {
  const data = loadProspects();
  res.json({ ok: true, prospects_total: data.length, as_of: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`KG API running on port ${PORT}`);
});
