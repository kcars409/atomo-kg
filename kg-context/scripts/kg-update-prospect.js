#!/usr/bin/env node
// Applies buffered prospect updates to prospects.json without loading the full
// file into Claude context. Accepts a JSON array via stdin.
//
// Each item must have a `name` field matching the prospect record.
// All other fields are merged onto the record.
//
// Usage (pipeline review wrap-up):
//   echo '[{"name":"El Tejano","status":"Closed Lost",...}]' | node kg-update-prospect.js

const readline = require('readline');
const { spawnSync } = require('child_process');
const { loadProspectsFlat, saveProspectsFlat } = require('../parsers/lib/shared');

const CC_SCRIPT = '/home/kent/scripts/kg-cc-inspection.js';

async function main() {
  let input = '';

  if (process.stdin.isTTY) {
    console.error('Usage: echo \'[{...}]\' | node kg-update-prospect.js');
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) input += line;

  let updates;
  try {
    updates = JSON.parse(input);
  } catch (e) {
    console.error('Invalid JSON input:', e.message);
    process.exit(1);
  }

  if (!Array.isArray(updates) || updates.length === 0) {
    console.error('Input must be a non-empty JSON array.');
    process.exit(1);
  }

  const data = loadProspectsFlat();
  const now = new Date().toISOString();
  const results = [];
  const ccNames = [];

  for (const update of updates) {
    const { name, ...fields } = update;
    if (!name) { results.push(`SKIP: missing name field`); continue; }

    const idx = data.findIndex(p =>
      (p.name || '').toLowerCase() === name.toLowerCase() ||
      (p.company || '').toLowerCase() === name.toLowerCase()
    );

    if (idx === -1) {
      results.push(`NOT FOUND: ${name}`);
      continue;
    }

    Object.assign(data[idx], fields, { last_updated: now });
    results.push(`UPDATED: ${data[idx].name}`);

    if (fields.inspection_complete === true) ccNames.push(data[idx].name);
  }

  saveProspectsFlat(data);

  results.forEach(r => console.log(r));
  console.error(`\nkg-update-prospect: ${updates.length} updates attempted, ${results.filter(r => r.startsWith('UPDATED')).length} applied.`);

  // CC pull for any prospect where inspection_complete was just set
  for (const name of ccNames) {
    console.log(`Pulling CompanyCam data for ${name}...`);
    const cc = spawnSync('node', [CC_SCRIPT, name], { encoding: 'utf8', timeout: 30000 });
    if (cc.error) { console.error(`CC error: ${cc.error.message}`); continue; }
    try {
      const ccData = JSON.parse(cc.stdout.slice(cc.stdout.indexOf('\n{') + 1));
      if (!ccData.found) { console.log(`CC: ${ccData.reason || 'not found'}`); continue; }
      const fresh = loadProspectsFlat();
      const i = fresh.findIndex(p =>
        (p.name || '').toLowerCase() === name.toLowerCase() ||
        (p.company || '').toLowerCase() === name.toLowerCase()
      );
      if (i >= 0) {
        fresh[i].companycam_data = ccData;
        fresh[i].last_updated = new Date().toISOString();
        saveProspectsFlat(fresh);
        console.log(`CC data saved: ${ccData.project_name}`);
      }
    } catch (e) {
      console.error(`CC parse error: ${e.message}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
