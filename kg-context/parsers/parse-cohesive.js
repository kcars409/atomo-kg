#!/usr/bin/env node
'use strict';
// Cohesive AI lead parser — accepts the notification .eml
require('dotenv').config({ path: '/home/kent/.env-atomo' });
const fs = require('fs');
const {
  geoCheck, sendKgTelegram, waitForYesNo,
  generateSmCsv,
  addOrUpdateProspect, findProspectByEmail, queueToSalesTracker,
  loadRotation, setRotation,
  getMimePart, formatPhone, companyFromDomain, todayYmd,
} = require('./lib/shared');

// ── HTML parsing helpers ──────────────────────────────────────────────────────

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s{2,}/g, ' ').trim();
}

function extractLeadInfo(html) {
  const fields = {};

  // Lead Information block — each field: <strong>Label:</strong> value</div>
  const leadInfoMatch = html.match(/Lead Information[\s\S]{0,200}?<\/p>([\s\S]+?)<div style[^>]*height:1px/i)
    || html.match(/Lead Information[\s\S]{0,200}?<\/p>([\s\S]+?)User Reply/i);
  const infoHtml = leadInfoMatch ? leadInfoMatch[1] : html;

  const fieldPattern = /<strong>([^<]+):<\/strong>\s*([^<\n]+)/gi;
  let m;
  while ((m = fieldPattern.exec(infoHtml)) !== null) {
    const key = m[1].trim().toLowerCase();
    const val = m[2].trim();
    if (key === 'email')   fields.email = val;
    if (key === 'phone')   fields.phone = val;
    if (key === 'website') fields.website = val;
    if (key === 'address') fields.address = val;
  }

  // User Reply — inside the bordered div after "User Reply"
  const replyMatch = html.match(/User Reply[\s\S]{0,300}?border-left[^>]+>([\s\S]+?)<\/div>/i);
  if (replyMatch) {
    fields.user_reply = stripHtml(replyMatch[1]).trim();
  }

  // Cohesive campaign link
  const linkMatch = html.match(/href=["']?(https:\/\/extension\.cohesiveapp\.com\/inbox[^"'\s>]+)/i);
  fields.campaign_url = linkMatch ? linkMatch[1].replace(/=3D/g, '=').replace(/&amp;/g, '&') : '';

  return fields;
}

function parseAddress(raw) {
  // "17111 S 138th St, Springfield, NE 68059"
  const m = raw.match(/^([\d\s\w.]+?),\s*([^,]+),\s*([A-Z]{2})\s+(\d{5})/);
  if (m) return { address1: m[1].trim(), city: m[2].trim(), state: m[3], zip: m[4] };
  // Fallback: no comma before city
  const m2 = raw.match(/^(.+?)\s+([A-Za-z]+),?\s+([A-Z]{2})\s+(\d{5})/);
  if (m2) return { address1: m2[1].trim(), city: m2[2].trim(), state: m2[3], zip: m2[4] };
  return { address1: raw, city: '', state: '', zip: '' };
}

function extractNameFromReply(text) {
  // Signature: "Thanks,\nFirst Last" or "Regards,\nFirst Last"
  const m = text.match(/(?:thanks|regards|best|sincerely|cheers),?\s*\n+([A-Z][a-zA-Z]+ [A-Z][a-zA-Z]+)/i);
  return m ? m[1].trim() : null;
}

function assessTemperature(replyText) {
  const hot = /call me|meet|schedule|happy to chat|give me a call|love to chat|let's talk|visit|quote|stop by|come by|walk.?through/i;
  return hot.test(replyText) ? 'Hot' : 'Contacted - Responded';
}

// ── main ──────────────────────────────────────────────────────────────────────

async function parse(emlPath, opts = {}) {
  const dryRun = opts.dryRun || false;
  const raw = fs.readFileSync(emlPath, 'utf8');

  // Extract subject for email address + dedup key
  const subjectMatch = raw.match(/^Subject:\s*(.+)/im);
  const subject = subjectMatch ? subjectMatch[1].trim() : '';
  const subjectEmailMatch = subject.match(/Reply from\s+([^\s(]+)/i);
  const subjectEmail = subjectEmailMatch ? subjectEmailMatch[1] : '';

  // Parse HTML body (single-part QP or multipart)
  const html = getMimePart(raw, 'text/html') || '';
  const info = extractLeadInfo(html);

  const email = info.email || subjectEmail;

  // ── Deduplication ──────────────────────────────────────────────────────────
  if (email) {
    const existing = findProspectByEmail(email);
    if (existing) {
      const newReply = info.user_reply || '';
      const oldReply = existing.notes || '';
      if (newReply && newReply === oldReply) {
        console.log(`[Cohesive] Duplicate — identical reply body for ${email}. Discarding silently.`);
        return { duplicate: true, action: 'discard' };
      }
      if (newReply && newReply !== oldReply) {
        if (!dryRun) {
          addOrUpdateProspect({ ...existing, notes: newReply, atomo_notes: `Reply updated ${todayYmd()}` });
        }
        const msg = `🔁 Duplicate Cohesive lead: ${email} — record updated with new reply info.`;
        console.log(msg);
        if (!dryRun) await sendKgTelegram(msg);
        return { duplicate: true, action: 'updated', email };
      }
      // Exists with same or no new info — do nothing
      console.log(`[Cohesive] Duplicate — no new information for ${email}. Stopping.`);
      return { duplicate: true, action: 'no-op' };
    }
  }

  // ── Extract fields ─────────────────────────────────────────────────────────
  const phone    = formatPhone(info.phone || '');
  const website  = info.website || '';
  const company  = companyFromDomain(website) || '';
  const addrParsed = parseAddress(info.address || '');
  const userReply  = info.user_reply || '';
  const temp       = assessTemperature(userReply);
  const campaignUrl = info.campaign_url || '';

  // Try to extract contact name from reply signature
  const fullName   = extractNameFromReply(userReply);
  const firstName  = fullName ? fullName.split(' ')[0] : (email.split('@')[0] || '');
  const lastName   = fullName ? fullName.split(' ').slice(1).join(' ') : '';

  const lead = {
    name: company,
    company,
    first_name: firstName,
    last_name: lastName,
    email,
    phone,
    address1: addrParsed.address1,
    city: addrParsed.city,
    state: addrParsed.state,
    zip: addrParsed.zip,
    lead_source: 'Cohesive',
    next_service_name: '',
    next_service_date: '',
    contact_person: fullName || firstName,
    contact_person_email: email,
    notes: userReply,
    how_did_you_find_out: 'Cohesive outreach',
    are_you_a_new_customer: 'Yes',
    // Atomo-specific
    lead_source_type: 'Cohesive',
    sister_property: false,
    timetap_id: null,
    cohesive_campaign_url: campaignUrl,
    temperature: temp,
    atomo_notes: '',
  };

  const missing = ['email', 'phone', 'company', 'city', 'state']
    .filter(f => !lead[f]);

  // Geo check
  const geoAddr = [lead.city, lead.state].filter(Boolean).join(', ');
  let geo = { withinRadius: true, display: 'unknown' };
  if (geoAddr) {
    try { geo = await geoCheck(geoAddr); }
    catch (e) { geo = { withinRadius: true, display: 'error', error: e.message }; }
  }

  const rotation = loadRotation();
  const nextUp = rotation.next;
  const tempLabel = temp === 'Hot' ? '🔥 Hot' : 'Contacted — Responded';
  const radiusLabel = geo.tripFee
    ? `outside radius — trip fee applies (${geo.display})`
    : `within radius (${geo.display})`;

  // Build Telegram question
  let tgMsg = `📧 New Cohesive lead: ${lead.contact_person || email}, ${company} (${lead.city || 'unknown'} — ${radiusLabel}).`;
  if (temp === 'Hot') tgMsg += ` 🔥 Hot — wants a call/meeting.`;
  tgMsg += `\nNext up: ${nextUp}. Is this your prospect? Yes/No`;

  // Report
  console.log('\n=== Cohesive Lead: parse-cohesive.js ===');
  console.log('Email        :', email);
  console.log('Phone        :', phone);
  console.log('Website      :', website);
  console.log('Company      :', company);
  console.log('Name         :', lead.contact_person);
  console.log('Address      :', [addrParsed.address1, addrParsed.city, addrParsed.state, addrParsed.zip].filter(Boolean).join(', '));
  console.log('Temperature  :', `${tempLabel}`);
  console.log('Geo          :', geo.tripFee ? `⚠️ Outside radius (${geo.display})` : `✅ Within radius (${geo.display})`);
  console.log('User Reply   :', userReply.slice(0, 120) + (userReply.length > 120 ? '...' : ''));
  console.log('Campaign URL :', campaignUrl.slice(0, 80) || 'not found');
  console.log('Rotation     :', `Next up: ${nextUp}`);
  if (missing.length) console.log('⚠️  Missing   :', missing.join(', '));

  if (dryRun) {
    console.log('\n[DRY RUN] Would send Telegram:', tgMsg);
    return { lead, geo, missing };
  }

  // Telegram round-robin
  await sendKgTelegram(tgMsg);
  let answer;
  try { answer = await waitForYesNo(); }
  catch (e) {
    console.error('Telegram timeout:', e.message);
    process.exit(1);
  }

  const isKent = answer === 'yes';
  const wasOverride = isKent && nextUp === 'Vincent';
  lead.assigned_to = isKent ? 'Kent' : 'Vincent';
  lead.rotation_override = wasOverride;
  lead.owner = isKent ? 'Kent Seevers' : '';

  setRotation(isKent ? 'Vincent' : 'Kent');
  addOrUpdateProspect(lead);

  if (isKent) {
    const csvPath = generateSmCsv(lead);
    console.log('SM CSV       :', csvPath);
    queueToSalesTracker(lead);

    const confirmMsg = `✅ Cohesive lead assigned to Kent. Rotation → next: Vincent.\nSM CSV generated`;
    await sendKgTelegram(confirmMsg);
    console.log(confirmMsg);
  } else {
    const confirmMsg = `✅ Cohesive lead assigned to Vincent (honor system). Rotation → next: Kent.\nLogged in prospects.json.`;
    await sendKgTelegram(confirmMsg);
    console.log(confirmMsg);
  }

  return { lead, geo, missing };
}

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2).filter(a => a !== '--dry-run');
  const dryRun = process.argv.includes('--dry-run');
  if (!args[0]) {
    console.error('Usage: node parse-cohesive.js <path/to/email.eml> [--dry-run]');
    process.exit(1);
  }
  parse(args[0], { dryRun }).catch(err => { console.error('Error:', err.message); process.exit(1); });
}

module.exports = { parse };
