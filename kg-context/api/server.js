const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3100;
const PROSPECTS_PATH = path.join(__dirname, '..', 'prospects.json');

app.use(cors());
app.use(express.json());

const CLOSED_STATUSES = new Set(['closed won', 'closed lost']);

function loadProspects() {
  return JSON.parse(fs.readFileSync(PROSPECTS_PATH, 'utf8'));
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

// GET /api/health
app.get('/api/health', (req, res) => {
  const data = loadProspects();
  res.json({ ok: true, prospects_total: data.length, as_of: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`KG API running on port ${PORT}`);
});
