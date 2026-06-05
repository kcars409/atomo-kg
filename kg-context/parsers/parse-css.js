#!/usr/bin/env node
'use strict';
// CSS lead parser — accepts an invite.ics file (or .eml with ics attachment)
require('dotenv').config({ path: '/home/kent/.env-atomo' });
const fs = require('fs');
const path = require('path');
const {
  geoCheck, sendKgTelegram, generateSmCsv,
  addOrUpdateProspect, loadProspects, formatPhone, todayYmd,
  normalizeAddress, findSiblingLocations,
} = require('./lib/shared');
const { createCalendarEvent } = require('./lib/graph-client');

// ── ICS parsing ───────────────────────────────────────────────────────────────

function parseIcs(content) {
  // Unfold continuation lines (RFC 5545: lines starting with whitespace)
  const unfolded = content.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  const props = {};
  let inVevent = false, inValarm = false;
  for (const line of unfolded.split(/\r?\n/)) {
    if (line === 'BEGIN:VEVENT') { inVevent = true; continue; }
    if (line === 'END:VEVENT')   { inVevent = false; continue; }
    if (line === 'BEGIN:VALARM') { inValarm = true; continue; }
    if (line === 'END:VALARM')   { inValarm = false; continue; }
    // Only parse VEVENT fields; skip VALARM to avoid overwriting DESCRIPTION
    if (!inVevent || inValarm) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).split(';')[0].trim();
    const val = line.slice(colon + 1)
      .replace(/\\n/g, '\n')
      .replace(/\\,/g, ',')
      .replace(/\\\\/g, '\\');
    if (!(key in props)) props[key] = val; // keep first occurrence
  }
  return props;
}

function icsUtcToLocalDate(dtstart) {
  const m = dtstart.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?/);
  if (!m) return '';
  const [, y, mo, d, h, mi] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, 0)).toISOString().slice(0, 10);
}

// ── field extraction ──────────────────────────────────────────────────────────

function extractFromDescription(desc) {
  const fields = {};

  // Contact name
  const nameMatch = desc.match(/appointment with (.+?) for Kitchen Guard/);
  fields.contact_person = nameMatch ? nameMatch[1].trim() : '';
  if (fields.contact_person) {
    const parts = fields.contact_person.split(' ');
    fields.first_name = parts[0] || '';
    fields.last_name = parts.slice(1).join(' ') || '';
  }

  // Date/time string (local, from description)
  const dateMatch = desc.match(/on ((?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday),\s+\w+\s+\d+,\s+\d{4}\s+at\s+\d+:\d+\s+[AP]M\s+\w+)/i);
  fields.inspection_datetime_str = dateMatch ? dateMatch[1].trim() : '';

  // Client address block: from "Client Address:" to "Notes :"
  const addrBlockMatch = desc.match(/Client Address:\s*([\s\S]+?)\s+Notes\s*:/i);
  const addrBlock = addrBlockMatch ? addrBlockMatch[1] : '';

  // Find street number — also handles ordinal street names like "3rd Ave", "1st St"
  const streetPos = addrBlock.search(/\d{2,5}\s+(?:[A-Za-z]|\d+(?:st|nd|rd|th))/i);
  if (streetPos >= 0) {
    const companyRaw = addrBlock.slice(0, streetPos).trim();
    fields.company = deduplicateCompany(companyRaw) || companyRaw;
    fields.name = fields.company;

    const remainder = addrBlock.slice(streetPos);
    // ICS address block repeats city/state/zip twice — trailing copy may be all-caps
    const trailing = remainder.match(/([A-Za-z][A-Za-z]+(?:\s+[A-Za-z][A-Za-z]+)?)\s+([A-Za-z]{2})\s+(\d{5})\s*$/i);
    if (trailing) {
      const city = trailing[1].trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
      const state = trailing[2].toUpperCase();
      const zip = trailing[3];
      // Locate the FIRST occurrence of "city,? state zip" to find where the street ends
      const cityRe = new RegExp(city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ',?\\s+' + state + '\\s+' + zip);
      const firstOcc = remainder.match(cityRe);
      fields.address1 = firstOcc ? remainder.slice(0, firstOcc.index).trim().replace(/[,\s]+$/, '') : remainder.trim();
      fields.city = city;
      fields.state = state;
      fields.zip = zip;
    } else {
      fields.address1 = remainder.trim();
    }
  } else {
    fields.company = addrBlock.trim();
    fields.name = fields.company;
  }

  // Notes: between "Notes :" and "Sales Person :"
  const notesMatch = desc.match(/Notes\s*:\s*([\s\S]+?)\s*Sales\s*Person\s*:/i);
  fields.notes = notesMatch ? notesMatch[1].trim() : '';

  // Client email
  const emailMatch = desc.match(/contact the client at\s+(\S+@\S+)/i);
  fields.email = emailMatch ? emailMatch[1].replace(/[.,;>]$/, '') : '';
  fields.contact_person_email = fields.email;

  // Client phone (W) only — not the Sales Phone
  const phoneMatch = desc.match(/Ph:\s*\(W\)\s*([\d()\s\-+.]+?)(?:\s+If\s|\s*$)/i);
  fields.phone = phoneMatch ? formatPhone(phoneMatch[1].trim()) : '';

  // TimeTap appointment ID
  const idMatch = desc.match(/Appointment\s+ID:\s*(\d+)/i);
  fields.timetap_id = idMatch ? idMatch[1] : '';

  // Sister property: any address in notes that isn't the primary
  fields.sister_property = detectSisterProperty(fields.notes, fields.address1);

  return fields;
}

function deduplicateCompany(raw) {
  const s = raw.trim();
  // Try every split length from 1..half — if first half equals second half, return first
  for (let len = 1; len <= Math.floor(s.length / 2); len++) {
    if (s.slice(0, len) === s.slice(len, len * 2) && s.slice(len * 2).trim() === '') {
      return s.slice(0, len).trim();
    }
  }
  return s;
}

function detectSisterProperty(text, primaryAddress) {
  // Look for a second street address in the text (different from primary)
  const addrPattern = /\b\d+\s+[A-Za-z][^.\n]{3,40}(?:St|Ave|Blvd|Rd|Dr|Ln|Way|Ct|Pl|Cir|Pkwy)\.?/gi;
  const found = [];
  let m;
  while ((m = addrPattern.exec(text)) !== null) {
    const addr = m[0].trim();
    if (addr.toLowerCase() !== (primaryAddress || '').toLowerCase()) found.push(addr);
  }
  return found.length > 0 ? { flagged: true, addresses: found } : false;
}

// ── main ──────────────────────────────────────────────────────────────────────


// ── reschedule handler ────────────────────────────────────────────────────────

async function handleReschedule(icsProps, dryRun) {
  const desc    = icsProps['DESCRIPTION'] || '';
  const summary = icsProps['SUMMARY'] || '';
  const dtstart = icsProps['DTSTART'] || '';
  const dtend   = icsProps['DTEND'] || '';

  // Extract timetap_id
  const idMatch = desc.match(/Appointment\s+ID:\s*(\d+)/i);
  const timetapId = idMatch ? idMatch[1] : '';
  if (!timetapId) throw new Error('Appointment Changed ICS missing Appointment ID');

  // New date string from SUMMARY: "[Appointment Changed] Name on Day, Mon D, YYYY at H:MM AM/PM TZ"
  const dateMatch = summary.match(/\] .+? on (.+)$/);
  const newDateStr = dateMatch ? dateMatch[1].replace(/\\,/g, ',').trim() : icsUtcToLocalDate(dtstart);

  const newDate = icsUtcToLocalDate(dtstart);

  function dtToIso(dt) {
    const m = dt.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?/);
    if (!m) return null;
    return new Date(Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], 0)).toISOString();
  }
  const newIso = dtToIso(dtstart);

  // Find prospect by timetap_id
  const prospects = loadProspects();
  const idx = prospects.findIndex(p => p.timetap_id === timetapId);
  if (idx === -1) throw new Error(`Appointment Changed: no prospect with timetap_id ${timetapId}`);
  const existing = prospects[idx];

  console.log(`Reschedule: ${existing.name} | ${existing.next_service_date || '?'} -> ${newDate}`);

  if (dryRun) {
    console.log('[DRY RUN] Would update prospects.json and create calendar event.');
    return { rescheduled: true, name: existing.name, newDate };
  }

  const today = new Date().toISOString().slice(0, 10);
  const update = {
    next_step_date:    newDate,
    next_service_date: newDate,
    last_activity_date: today,
    last_updated: new Date().toISOString(),
  };

  // Update inspection_meeting.datetime if not yet completed
  if (existing.inspection_meeting && !existing.inspection_meeting.completed_at && newIso) {
    update.inspection_meeting = { ...existing.inspection_meeting, datetime: newIso };
  }

  // Append reschedule note
  const prevNotes = Array.isArray(existing.atomo_notes) ? existing.atomo_notes : [];
  update.atomo_notes = [...prevNotes, `${today}: Rescheduled via CSS — inspection now ${newDateStr}`];

  const { saveProspects } = require('./lib/shared');
  prospects[idx] = { ...existing, ...update };
  saveProspects(prospects);

  // New Outlook calendar event with updated time
  const locationStr = [existing.address1, existing.city, existing.state].filter(Boolean).join(', ');
  let calendarNote = '';
  try {
    await createCalendarEvent({
      subject: `KG Inspection — ${existing.name}`,
      dtstart,
      dtend,
      location: locationStr,
      body: [
        'RESCHEDULED from previous date',
        `Contact: ${existing.contact_person}`,
        `Phone: ${existing.phone}`,
        `Email: ${existing.email}`,
        `TimeTap ID: ${timetapId}`,
        existing.notes ? `Notes: ${existing.notes.slice(0, 300)}` : '',
      ].filter(Boolean).join('\n'),
    });
    calendarNote = ' New calendar event created (delete the old one).';
  } catch (err) {
    calendarNote = ` Calendar error: ${err.message}`;
    console.error('Calendar error:', err.message);
  }

  await sendKgTelegram(
    `📅 Inspection rescheduled: ${existing.name} — now ${newDateStr}.${calendarNote}\nTimeTap ID: ${timetapId}`
  );

  console.log(`Reschedule handled: ${existing.name} -> ${newDate}`);
  return { rescheduled: true, name: existing.name, newDate };
}

async function parse(icsPath, opts = {}) {
  const dryRun = opts.dryRun || false;
  const content = fs.readFileSync(icsPath, 'utf8');
  const icsProps = parseIcs(content);


  // Route reschedule ICS to dedicated handler
  const summary = icsProps['SUMMARY'] || '';
  if (summary.toLowerCase().includes('appointment changed')) {
    return await handleReschedule(icsProps, dryRun);
  }

  const desc = icsProps['DESCRIPTION'] || '';
  const dtstart = icsProps['DTSTART'] || '';
  const dtend = icsProps['DTEND'] || '';
  const fields = extractFromDescription(desc);

  // Use DTSTART as the inspection date if description parse missed it
  if (!fields.next_service_date) {
    fields.next_service_date = icsUtcToLocalDate(dtstart);
  } else {
    fields.next_service_date = icsUtcToLocalDate(dtstart);
  }

  const lead = {
    name: fields.name || '',
    company: fields.company || '',
    first_name: fields.first_name || '',
    last_name: fields.last_name || '',
    email: fields.email || '',
    phone: fields.phone || '',
    address1: fields.address1 || '',
    city: fields.city || '',
    state: fields.state || '',
    zip: fields.zip || '',
    owner: 'Kent Seevers',
    lead_source: 'CSS',
    status: 'Inspection Scheduled',
    next_step: 'CSS Inspection',
    next_step_date: fields.next_service_date || '',
    next_service_name: 'Inspection',
    next_service_date: fields.next_service_date || '',
    contact_person: fields.contact_person || '',
    contact_person_email: fields.contact_person_email || '',
    notes: fields.notes || '',
    are_you_a_new_customer: 'Yes',
    // Atomo-specific
    lead_source_type: 'CSS',
    assigned_to: 'Kent',
    rotation_override: false,
    sister_property: fields.sister_property || false,
    timetap_id: fields.timetap_id || '',
    cohesive_campaign_url: null,
    temperature: null,
    atomo_notes: '',
  };

  // Validate required fields
  const missing = ['name', 'contact_person', 'email', 'phone', 'address1', 'city', 'state', 'zip', 'next_service_date', 'timetap_id']
    .filter(f => !lead[f]);

  // Guard: if the ICS description yielded nothing parseable, throw so the watcher's
  // catch block sends the proper error alert instead of creating junk records.
  if (!lead.name && !lead.contact_person && !lead.address1) {
    throw new Error(`ICS parse yielded no usable fields — likely malformed DESCRIPTION. Missing: ${missing.join(', ')}`);
  }

  // Geo check
  const geoAddr = [lead.city, lead.state].filter(Boolean).join(', ');
  let geo = { withinRadius: true, display: 'unknown', error: 'no address' };
  if (geoAddr) {
    try { geo = await geoCheck(geoAddr); }
    catch (e) { geo = { withinRadius: true, display: 'error', error: e.message }; }
  }

  const geoLabel = geo.tripFee ? `⚠️ Outside 1.5hr radius (${geo.display}) — trip fee applies` : `✅ Within radius (${geo.display})`;

  // Report
  console.log('\n=== CSS Lead: parse-css.js ===');
  console.log('Company/Name :', lead.name);
  console.log('Contact      :', lead.contact_person);
  console.log('Email        :', lead.email);
  console.log('Phone        :', lead.phone);
  console.log('Address      :', [lead.address1, lead.city, lead.state, lead.zip].filter(Boolean).join(', '));
  console.log('Inspection   :', fields.inspection_datetime_str || lead.next_service_date);
  console.log('TimeTap ID   :', lead.timetap_id);
  console.log('Notes        :', lead.notes.slice(0, 120) + (lead.notes.length > 120 ? '...' : ''));
  console.log('Sister prop  :', lead.sister_property ? JSON.stringify(lead.sister_property) : 'none');
  console.log('Geo          :', geoLabel);
  if (missing.length) console.log('⚠️  Missing   :', missing.join(', '));

  if (dryRun) {
    console.log('\n[DRY RUN] Would generate SM CSV, create Todoist tasks, send Telegram, write prospects.json');
    return { lead, geo, missing };
  }

  // Generate SM CSV
  const csvPath = generateSmCsv(lead);
  console.log('SM CSV       :', csvPath);

  // Sister property SM CSV
  if (lead.sister_property && lead.sister_property.flagged) {
    const sisterLead = {
      ...lead,
      notes: `INCOMPLETE — sister property, needs manual review before upload. ${lead.notes}`,
    };
    const sisterCsvPath = generateSmCsv(sisterLead, 'sister');
    console.log('Sister CSV   :', sisterCsvPath);
  }

  // De-dup check: same company name = possible duplicate or new location
  const existingProspects = loadProspects();
  const siblings = findSiblingLocations(lead, existingProspects);
  if (siblings.length > 0) {
    const normNewAddr = normalizeAddress(lead.address1);
    const trueMatch = normNewAddr
      ? siblings.find(s => normalizeAddress(s.address1) === normNewAddr)
      : null;

    if (trueMatch) {
      const msg = `⛔ De-dup blocked: CSS lead "${lead.name}" (${lead.address1 || 'no address'}) matches existing record "${trueMatch.name}" (${trueMatch.status}). TimeTap ID: ${lead.timetap_id}. Record NOT created.`;
      console.log('DEDUP BLOCKED:', msg);
      await sendKgTelegram(msg);
      return { lead, geo, missing, blocked: 'duplicate' };
    } else {
      // New location under an existing company — create the record but flag it
      const siblingList = siblings.map(s => `"${s.name}" (${s.city || 'no city'})`).join(', ');
      const msg = `📍 New location: CSS lead "${lead.name}" (${lead.address1 || 'no address'}) is a new location for existing company. Related records: ${siblingList}. Creating record.`;
      console.log('DEDUP INFO:', msg);
      await sendKgTelegram(msg);
    }
  }

  // Write to prospects.json
  addOrUpdateProspect(lead);

  // Auto-create calendar event for inspection
  const dateStr = lead.next_service_date || 'upcoming';
  const locationStr = [lead.address1, lead.city, lead.state].filter(Boolean).join(', ');
  const inspectionStr = fields.inspection_datetime_str || dateStr;
  let calendarLink = '';

  try {
    const event = await createCalendarEvent({
      subject: `KG Inspection — ${lead.name}`,
      dtstart,
      dtend,
      location: locationStr,
      body: [
        `Contact: ${lead.contact_person}`,
        `Phone: ${lead.phone}`,
        `Email: ${lead.email}`,
        `TimeTap ID: ${lead.timetap_id}`,
        lead.notes ? `Notes: ${lead.notes}` : '',
      ].filter(Boolean).join('\n'),
    });
    calendarLink = event.webLink || '';
    console.log('Calendar     : Event created', calendarLink ? `(${calendarLink})` : '');
  } catch (err) {
    console.error('Calendar error:', err.message);
  }

  // Telegram alert
  let alertMsg = `🔧 New CSS lead: ${lead.name} (${lead.city}) — ${lead.contact_person}, inspection ${inspectionStr}.`;
  if (geo.tripFee) alertMsg += ` ⚠️ Outside radius — trip fee applies.`;
  if (lead.sister_property && lead.sister_property.flagged) {
    alertMsg += ` 🏢 Sister property flagged — second SM CSV generated (INCOMPLETE).`;
  }
  if (missing.length) alertMsg += `\n⚠️ Missing fields: ${missing.join(', ')} — manual review needed.`;
  alertMsg += `\nTimeTap ID: ${lead.timetap_id}`;
  alertMsg += calendarLink ? `\n📅 Calendar event created` : '';
  await sendKgTelegram(alertMsg);

  console.log('✅ Done — calendar event created, Telegram sent, Todoist task created, prospects.json updated');
  return { lead, geo, missing };
}

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2).filter(a => a !== '--dry-run');
  const dryRun = process.argv.includes('--dry-run');
  if (!args[0]) {
    console.error('Usage: node parse-css.js <path/to/invite.ics> [--dry-run]');
    process.exit(1);
  }
  parse(args[0], { dryRun }).catch(err => { console.error('Error:', err.message); process.exit(1); });
}

module.exports = { parse };
