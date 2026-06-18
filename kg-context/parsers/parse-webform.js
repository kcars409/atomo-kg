#!/usr/bin/env node
'use strict';
// Web Form lead parser — accepts a forwarded .eml from Kyra
require('dotenv').config({ path: '/home/kent/.env-atomo' });
const fs = require('fs');
const {
  geoCheck, sendKgTelegram, waitForYesNo,
  generateSmCsv,
  addOrUpdateProspect, findProspectByEmail, loadRotation, setRotation, queueToSalesTracker,
  getMimePart, formatPhone, todayYmd,
} = require('./lib/shared');

// ── form field parsing ────────────────────────────────────────────────────────

function parseFormFields(plainText) {
  const fields = {};
  const lines = plainText.split(/\r?\n/);
  let label = null;

  for (const line of lines) {
    // Value lines are indented with spaces or tabs
    if (/^[ \t]{2,}/.test(line)) {
      if (!label) continue;
      const val = line.trim()
        .replace(/<mailto:[^>]+>/gi, '')
        .replace(/<https?:[^>]+>/gi, '')
        .trim();
      // Skip the "Map It" tracker lines
      if (/^Map It$/i.test(val) || val === '') continue;
      // Append to existing value (multi-line fields)
      fields[label] = fields[label] ? fields[label] + '\n' + val : val;
    } else if (line.trim()) {
      label = line.trim();
    }
  }
  return fields;
}

function detectSisterProperty(text) {
  return /\b(\d+|two|three|four|five|multiple|several)\s+location/i.test(text || '');
}

// ── main ──────────────────────────────────────────────────────────────────────

async function parse(emlPath, opts = {}) {
  const dryRun = opts.dryRun || false;
  const raw = fs.readFileSync(emlPath, 'utf8');
  const plainText = getMimePart(raw, 'text/plain') || '';

  const f = parseFormFields(plainText);

  const firstName  = f['First Name'] || '';
  const lastName   = f['Last Name'] || '';
  const company    = f['Company Name'] || '';
  const title      = f['Title'] || '';
  const address1   = f['Address'] || '';
  const city       = f['City'] || '';
  const stateRaw   = f['State'] || '';
  const state      = stateRaw.length === 2 ? stateRaw : stateToAbbrev(stateRaw);
  const zip        = f['Zip Code'] || f['Zip'] || '';
  const phone      = formatPhone(f['Phone'] || '');
  const email      = (f['Email'] || '').replace(/<mailto:[^>]+>/gi, '').trim();
  const hearAbout  = f['How Did You Hear About Us?'] || '';
  const tellMore   = f['Tell Us More'] || '';

  const sisterFlag = detectSisterProperty(tellMore);

  // Deduplication — skip if already in prospects.json
  if (email) {
    const existing = findProspectByEmail(email);
    if (existing) {
      console.log(`[WebForm] Duplicate — ${email} already in prospects.json (${existing.company}). Skipping.`);
      return { duplicate: true, action: 'skip', email };
    }
  }

  const lead = {
    name: company,
    company,
    title,
    first_name: firstName,
    last_name: lastName,
    email,
    phone,
    address1,
    city,
    state,
    zip,
    lead_source: 'KG Website',
    next_service_name: 'Inspection',
    next_service_date: '',
    contact_person: [firstName, lastName].filter(Boolean).join(' '),
    contact_person_email: email,
    notes: tellMore,
    how_did_you_find_out: hearAbout,
    are_you_a_new_customer: 'Yes',
    // Atomo-specific (owner/assigned set after Telegram response)
    lead_source_type: 'WebForm',
    sister_property: sisterFlag ? { flagged: true, notes: tellMore } : false,
    timetap_id: null,
    cohesive_campaign_url: null,
    temperature: null,
    atomo_notes: '',
  };

  // Validate required fields
  const missing = ['first_name', 'last_name', 'company', 'email', 'phone', 'city', 'state']
    .filter(f => !lead[f]);

  // Geo check
  const geoAddr = [city, state].filter(Boolean).join(', ');
  let geo = { withinRadius: true, display: 'unknown' };
  if (geoAddr) {
    try { geo = await geoCheck(geoAddr); }
    catch (e) { geo = { withinRadius: true, display: 'error', error: e.message }; }
  }

  const rotation = loadRotation();
  const nextUp = rotation.next;

  // Build Telegram question
  let tgMsg = `🏠 New Web Form lead: ${lead.contact_person}, ${company}, ${city} ${state}.`;
  if (geo.tripFee) tgMsg += ` ⚠️ Outside 1.5hr radius (${geo.display}) — trip fee applies.`;
  if (sisterFlag) tgMsg += ` 🏢 Sister property mention ("${tellMore.slice(0, 60).trim()}...").`;
  tgMsg += `\nNext up: ${nextUp}. Is this your prospect? Yes/No`;

  // Report
  console.log('\n=== Web Form Lead: parse-webform.js ===');
  console.log('Name         :', lead.contact_person);
  console.log('Company      :', company);
  console.log('Title        :', title);
  console.log('Email        :', email);
  console.log('Phone        :', phone);
  console.log('Address      :', [address1, city, state, zip].filter(Boolean).join(', '));
  console.log('Hear about   :', hearAbout);
  console.log('Tell us more :', tellMore);
  console.log('Sister prop  :', sisterFlag ? 'Yes — ' + tellMore.slice(0, 80) : 'No');
  console.log('Geo          :', geo.tripFee ? `⚠️ Outside radius (${geo.display})` : `✅ Within radius (${geo.display})`);
  console.log('Rotation     :', `Next up: ${nextUp}`);
  if (missing.length) console.log('⚠️  Missing   :', missing.join(', '));

  if (dryRun) {
    console.log('\n[DRY RUN] Would send Telegram:', tgMsg);
    return { lead, geo, missing };
  }

  // Write the lead before waiting on Telegram — a timeout/crash on the
  // rotation question must never drop a lead. assigned_to/owner get filled
  // in below once (if) we get an answer; this record is the safety net.
  lead.status = 'Not Contacted';
  lead.assigned_to = null;
  lead.owner = '';
  addOrUpdateProspect(lead);

  // Telegram round-robin
  await sendKgTelegram(tgMsg);
  let answer;
  try { answer = await waitForYesNo(); }
  catch (e) {
    console.error('Telegram timeout:', e.message);
    console.error('Lead already written to prospects.json as unassigned — not lost, just needs manual rotation.');
    process.exit(1);
  }

  const isKent = answer === 'yes';
  const wasOverride = isKent && nextUp === 'Vincent';
  lead.assigned_to = isKent ? 'Kent' : 'Vincent';
  lead.rotation_override = wasOverride;
  lead.owner = isKent ? 'Kent Seevers' : '';

  // Flip rotation: Yes → next=Vincent, No → next=Kent
  setRotation(isKent ? 'Vincent' : 'Kent');

  // Update the record written above with the rotation decision
  addOrUpdateProspect(lead);

  if (isKent) {
    const csvPath = generateSmCsv(lead);
    console.log('SM CSV       :', csvPath);
    queueToSalesTracker(lead);

    if (lead.sister_property && lead.sister_property.flagged) {
      const sisterLead = { ...lead, notes: `INCOMPLETE — sister property, needs manual review before upload. ${lead.notes}` };
      console.log('Sister CSV   :', generateSmCsv(sisterLead, 'sister'));
    }

    const confirmMsg = `✅ Assigned to Kent. Rotation flipped → next: Vincent.\nSM CSV generated`;
    await sendKgTelegram(confirmMsg);
    console.log(confirmMsg);
  } else {
    const confirmMsg = `✅ Assigned to Vincent (honor system). Rotation flipped → next: Kent.\nLogged in prospects.json — no SM CSV or tasks generated (Vincent's responsibility).`;
    await sendKgTelegram(confirmMsg);
    console.log(confirmMsg);
  }

  return { lead, geo, missing };
}

function stateToAbbrev(name) {
  const map = { nebraska: 'NE', iowa: 'IA', kansas: 'KS', missouri: 'MO', 'south dakota': 'SD', wyoming: 'WY', colorado: 'CO' };
  return map[name.toLowerCase()] || name.slice(0, 2).toUpperCase();
}

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2).filter(a => a !== '--dry-run');
  const dryRun = process.argv.includes('--dry-run');
  if (!args[0]) {
    console.error('Usage: node parse-webform.js <path/to/email.eml> [--dry-run]');
    process.exit(1);
  }
  parse(args[0], { dryRun }).catch(err => { console.error('Error:', err.message); process.exit(1); });
}

module.exports = { parse };
