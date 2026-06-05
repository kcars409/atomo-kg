#!/usr/bin/env node
'use strict';
// Test runner — dry-runs all three parsers against sample .eml files
// Usage: node test-parsers.js [css|webform|cohesive]
require('dotenv').config({ path: '/home/kent/.env-atomo' });
const path = require('path');

const KG = path.join(__dirname);
const SAMPLES = {
  css:      path.join(KG, 'invite.ics'),
  webform:  path.join(KG, 'FW_ New Form Submission From Contact Kitchen Guard of Nebraska.eml'),
  cohesive: path.join(KG, 'Cohesive AI - Reply from pat@soaringwings.com (Kitchen Guard (Kyra & Tom Dornish) - Nebraska).eml'),
};

const PARSERS = {
  css:      require('./parsers/parse-css'),
  webform:  require('./parsers/parse-webform'),
  cohesive: require('./parsers/parse-cohesive'),
};

// Required fields per parser type
const REQUIRED = {
  css: [
    'name', 'contact_person', 'email', 'phone',
    'address1', 'city', 'state', 'zip',
    'next_service_date', 'timetap_id',
  ],
  webform: [
    'first_name', 'last_name', 'company',
    'email', 'phone', 'city', 'state',
  ],
  cohesive: [
    'email', 'phone', 'company', 'city', 'state',
    'cohesive_campaign_url', 'temperature',
  ],
};

async function runOne(type) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Running: ${type.toUpperCase()} parser`);
  console.log(`Sample : ${SAMPLES[type]}`);
  console.log('─'.repeat(60));

  let result;
  try {
    result = await PARSERS[type].parse(SAMPLES[type], { dryRun: true });
  } catch (err) {
    console.error(`\n❌ PARSER THREW: ${err.message}`);
    console.error(err.stack);
    return { type, error: err.message };
  }

  if (result.duplicate) {
    console.log(`\nℹ️  Duplicate detected — action: ${result.action}`);
    return { type, duplicate: true };
  }

  const { lead = {}, geo = {}, missing: parserMissing = [] } = result;

  // Cross-check required fields
  const required = REQUIRED[type] || [];
  const actualMissing = required.filter(f => !lead[f] && lead[f] !== false);

  console.log('\n── Field Check ──────────────────────────────────────────────');
  let allOk = true;
  for (const f of required) {
    const val = lead[f];
    const ok = val !== undefined && val !== null && val !== '';
    const icon = ok ? '✅' : '❌';
    console.log(`  ${icon} ${f}: ${ok ? String(val).slice(0, 60) : 'MISSING'}`);
    if (!ok) allOk = false;
  }

  console.log('\n── Geo Result ───────────────────────────────────────────────');
  if (geo.error) console.log(`  ⚠️  Geo error: ${geo.error}`);
  else console.log(`  ${geo.tripFee ? '⚠️ ' : '✅'} ${geo.tripFee ? 'Outside radius' : 'Within radius'} — ${geo.display}`);

  console.log('\n── Summary ──────────────────────────────────────────────────');
  if (parserMissing.length) console.log(`  Parser flagged missing: ${parserMissing.join(', ')}`);
  if (actualMissing.length) console.log(`  Test runner missing   : ${actualMissing.join(', ')}`);
  if (allOk && !parserMissing.length) console.log('  ✅ All required fields present');

  return { type, lead, geo, missing: actualMissing, ok: allOk };
}

async function main() {
  const filter = process.argv[2];
  const types = filter ? [filter] : ['css', 'webform', 'cohesive'];
  const invalid = types.filter(t => !PARSERS[t]);
  if (invalid.length) {
    console.error(`Unknown parser(s): ${invalid.join(', ')}. Use: css | webform | cohesive`);
    process.exit(1);
  }

  const results = [];
  for (const t of types) {
    results.push(await runOne(t));
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('TEST SUMMARY');
  console.log('═'.repeat(60));
  for (const r of results) {
    if (r.error)     { console.log(`  ❌ ${r.type.toUpperCase().padEnd(10)} ERROR: ${r.error}`); continue; }
    if (r.duplicate) { console.log(`  ℹ️  ${r.type.toUpperCase().padEnd(10)} duplicate detected`); continue; }
    const icon = r.ok ? '✅' : '⚠️ ';
    const detail = r.missing.length ? `missing: ${r.missing.join(', ')}` : 'all fields OK';
    console.log(`  ${icon} ${r.type.toUpperCase().padEnd(10)} ${detail}`);
  }
  console.log();
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
