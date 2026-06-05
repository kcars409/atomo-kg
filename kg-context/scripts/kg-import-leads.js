require('dotenv').config({ path: '/home/kent/.env-atomo' });
const xlsx = require('/home/kent/node_modules/xlsx');
const fs = require('fs');
const path = require('path');
const https = require('https');
const readline = require('readline');

const IMPORT_DIR = '/home/kent/contexts/KG/import/extracted/Commercial Kitchen Data';
const RAR_DIR = path.join(IMPORT_DIR, 'Restaurant Activity Report - New Leads Data Pulls');
const COSTAR_FILE = path.join(IMPORT_DIR, 'Nebraska CostarExport .xlsx');
const ZOOMINFO_FILE = path.join(IMPORT_DIR, 'Zoom Info Nebraska List.csv');
const PROSPECTS_PATH = '/home/kent/contexts/KG/prospects.json';
const STAGING_ROOT = '/home/kent/contexts/KG/import';

const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

// --- Normalize helpers ---

function normKey(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

function normPhone(str) {
  if (!str) return '';
  const digits = String(str).replace(/\D/g, '');
  const core = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
  if (core.length === 10) return `(${core.slice(0,3)}) ${core.slice(3,6)}-${core.slice(6)}`;
  return String(str).trim();
}

// --- Dedup key ---

function dedupKey(lead) {
  return normKey(lead.company) + '|' + (lead.zip || '').replace(/\D/g, '').slice(0, 5);
}

// --- Base prospect template ---

function baseLead(overrides) {
  return {
    name: '',
    company: '',
    title: '',
    first_name: '',
    last_name: '',
    email: '',
    phone: '',
    address1: '',
    address2: '',
    city: '',
    state: '',
    zip: '',
    lead_source: 'Industry Reports & Directories',
    next_service_name: '',
    next_service_date: null,
    contact_person: '',
    contact_person_email: '',
    notes: '',
    how_did_you_find_out: '',
    are_you_a_new_customer: 'Yes',
    lead_source_type: '',
    sister_property: false,
    timetap_id: null,
    cohesive_campaign_url: null,
    temperature: 'Cold',
    atomo_notes: '',
    assigned_to: null,
    rotation_override: false,
    owner: null,
    status: 'Not Contacted',
    next_step_date: null,
    last_activity_date: null,
    last_updated: TODAY,
    ...overrides
  };
}

// --- RAR xlsx parser ---

function parseRarFile(filePath) {
  const filename = path.basename(filePath);
  const wb = xlsx.readFile(filePath);
  const ws = wb.Sheets['Leads'];
  if (!ws) return [];
  const rows = xlsx.utils.sheet_to_json(ws, { defval: '' });

  return rows
    .filter(r => r.State === 'NE' && (r.Company || r.Lead))
    .map(r => {
      const noteParts = [];
      if (r['Menu Type']) noteParts.push(`Menu: ${r['Menu Type']}`);
      if (r['Average Check']) noteParts.push(`Avg check: $${r['Average Check']}`);
      if (r['LocationType']) noteParts.push(`Type: ${r['LocationType']}`);
      if (r['Summary']) noteParts.push(r['Summary']);

      const contactParts = [];
      if (r['Other Contact']) contactParts.push(r['Other Contact']);
      if (r['Other Contact Phone']) contactParts.push(normPhone(r['Other Contact Phone']));

      return baseLead({
        name: String(r.Lead || r.Company).trim(),
        company: String(r.Company || r.Lead).trim(),
        first_name: String(r['First Name'] || '').trim(),
        last_name: String(r['Last Name'] || '').trim(),
        title: String(r.Title || '').trim(),
        phone: normPhone(r.Phone || r['Cell Phone']),
        email: String(r.Email || r['Alternate Email'] || '').trim(),
        address1: String(r.Address || '').trim(),
        address2: String(r.Address2 || '').trim(),
        city: String(r.City || '').trim(),
        state: 'NE',
        zip: String(r.Zip || '').trim(),
        notes: noteParts.join(' | '),
        atomo_notes: `RAR import: ${filename}` + (contactParts.length ? ` | Alt contact: ${contactParts.join(', ')}` : ''),
        website: String(r.Website || '').trim(),
      });
    });
}

// --- CoStar xlsx parser ---

function parseCoStar() {
  const wb = xlsx.readFile(COSTAR_FILE);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(ws, { defval: '' });

  return rows
    .filter(r => r['Property Name'])
    .map(r => {
      const mgr = [r['Property Manager Name'], r['Property Manager Contact']].filter(Boolean).join(' / ');
      const owner = [r['True Owner Name'], r['True Owner Contact']].filter(Boolean).join(' / ');
      const noteParts = [];
      if (mgr) noteParts.push(`Manager: ${mgr}`);
      if (owner) noteParts.push(`Owner: ${owner}`);
      if (r['Rentable Building Area']) noteParts.push(`Bldg area: ${r['Rentable Building Area']}`);

      const phone = normPhone(r['Property Manager Phone'] || r['True Owner Phone']);
      const contact = r['Property Manager Contact'] || r['True Owner Contact'] || '';

      // CoStar gives "Property Address" but city/state/zip are embedded — parse from Property Location
      // "Property Location" format: "City, ST XXXXX"
      let city = '', state = '', zip = '';
      const loc = String(r['Property Location'] || '').trim();
      const locMatch = loc.match(/^(.+),\s*([A-Z]{2})\s*(\d{5})?/);
      if (locMatch) {
        city = locMatch[1].trim();
        state = locMatch[2];
        zip = locMatch[3] || String(r.Zip || '').trim();
      }

      return baseLead({
        name: String(r['Property Name']).trim(),
        company: String(r['Property Name']).trim(),
        phone,
        contact_person: contact,
        address1: String(r['Property Address'] || '').trim(),
        city,
        state: state || 'NE',
        zip,
        notes: noteParts.join(' | '),
        atomo_notes: 'CoStar import',
      });
    });
}

// --- ZoomInfo CSV parser ---

function parseZoomInfo() {
  const raw = fs.readFileSync(ZOOMINFO_FILE, 'utf8');
  const lines = raw.split('\n');
  if (lines.length < 2) return [];

  // Parse header
  const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim());

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    // Simple CSV parse (handles quoted fields with commas)
    const vals = [];
    let cur = '', inQ = false;
    for (const ch of lines[i]) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { vals.push(cur); cur = ''; }
      else { cur += ch; }
    }
    vals.push(cur);
    const row = {};
    headers.forEach((h, idx) => { row[h] = (vals[idx] || '').trim(); });
    rows.push(row);
  }

  return rows
    .filter(r => r['Company State'] === 'Nebraska' || r['Company State'] === 'NE')
    .filter(r => r['Company Name'])
    .map(r => {
      const fullName = [r['First Name'], r['Last Name']].filter(Boolean).join(' ');
      return baseLead({
        name: String(r['Company Name']).trim(),
        company: String(r['Company Name']).trim(),
        first_name: String(r['First Name'] || '').trim(),
        last_name: String(r['Last Name'] || '').trim(),
        title: String(r['Job Title'] || '').trim(),
        phone: normPhone(r['Direct Phone Number'] || r['Mobile phone']),
        email: String(r['Email Address'] || '').trim(),
        address1: String(r['Company Street Address'] || '').trim(),
        city: String(r['Company City'] || '').trim(),
        state: 'NE',
        zip: String(r['Company Zip Code'] || '').trim(),
        contact_person: fullName,
        contact_person_email: String(r['Email Address'] || '').trim(),
        notes: r['Number of Locations'] > 1 ? `${r['Number of Locations']} locations` : '',
        atomo_notes: `ZoomInfo import` + (r['Query Name'] ? ` | Query: ${r['Query Name']}` : ''),
      });
    });
}

// --- Merge & dedup ---

function mergeLeads(existing, incoming) {
  const existingKeys = new Set(existing.map(dedupKey));
  const emailIndex = new Set(existing.map(p => p.email).filter(Boolean).map(e => e.toLowerCase()));

  const added = [];
  const skipped = [];
  const seenKeys = new Set();

  for (const lead of incoming) {
    const key = dedupKey(lead);
    const emailMatch = lead.email && emailIndex.has(lead.email.toLowerCase());

    if (existingKeys.has(key) || emailMatch) {
      skipped.push(lead);
      continue;
    }
    if (seenKeys.has(key)) {
      skipped.push(lead);
      continue;
    }
    seenKeys.add(key);
    added.push(lead);
  }

  return { added, skipped };
}

// --- Main ---

async function main() {
  console.log('\nKG Lead Importer\n');

  // Load existing prospects
  const existing = JSON.parse(fs.readFileSync(PROSPECTS_PATH, 'utf8'));
  console.log(`Existing prospects: ${existing.length}`);

  // Parse all sources
  console.log('\nParsing RAR files...');
  const rarFiles = fs.readdirSync(RAR_DIR).filter(f => f.endsWith('.xlsx'));
  let rarLeads = [];
  for (const f of rarFiles) {
    const leads = parseRarFile(path.join(RAR_DIR, f));
    rarLeads = rarLeads.concat(leads);
  }
  console.log(`  ${rarFiles.length} files → ${rarLeads.length} NE leads`);

  console.log('Parsing CoStar...');
  const costarLeads = parseCoStar();
  console.log(`  ${costarLeads.length} leads`);

  console.log('Parsing ZoomInfo...');
  const zoomLeads = parseZoomInfo();
  console.log(`  ${zoomLeads.length} NE leads`);

  const allIncoming = [...rarLeads, ...costarLeads, ...zoomLeads];
  console.log(`\nTotal incoming: ${allIncoming.length}`);

  // Dedup
  const { added, skipped } = mergeLeads(existing, allIncoming);
  console.log(`New (not in prospects.json): ${added.length}`);
  console.log(`Skipped (duplicates): ${skipped.length}`);

  // Sample preview
  console.log('\n--- Sample of new leads (first 10) ---');
  added.slice(0, 10).forEach(l => {
    console.log(`  ${l.company} | ${l.city}, ${l.state} | ${l.phone || 'no phone'} | ${l.atomo_notes}`);
  });

  if (added.length === 0) {
    console.log('\nNothing new to import. Exiting.');
    return;
  }

  // Prompt
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(`\nImport ${added.length} new leads into prospects.json? (yes/no): `, (ans) => {
    rl.close();
    if (ans.trim().toLowerCase() !== 'yes') {
      console.log('Aborted.');
      return;
    }

    // Write
    const merged = [...existing, ...added];
    fs.writeFileSync(PROSPECTS_PATH, JSON.stringify(merged, null, 2));
    console.log(`\nWrote ${merged.length} prospects to ${PROSPECTS_PATH}`);

    // Delete staging
    fs.rmSync(STAGING_ROOT, { recursive: true, force: true });
    console.log(`Deleted staging folder: ${STAGING_ROOT}`);
    console.log('\nDone.');
  });
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
