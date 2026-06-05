#!/usr/bin/env node
// Applies buffered prospect updates to prospects.json without loading the full
// file into Claude context. Accepts a JSON array via stdin.
//
// Each item must have a `name` field matching the prospect record.
// All other fields are merged onto the record.
//
// Usage (pipeline review wrap-up):
//   echo '[{"name":"El Tejano","status":"Closed Lost",...}]' | node kg-update-prospect.js

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const PROSPECTS_PATH = path.join(__dirname, '..', 'prospects.json');

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

  const data = JSON.parse(fs.readFileSync(PROSPECTS_PATH, 'utf8'));
  const now = new Date().toISOString();
  const results = [];

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
  }

  fs.writeFileSync(PROSPECTS_PATH, JSON.stringify(data, null, 2));

  results.forEach(r => console.log(r));
  console.error(`\nkg-update-prospect: ${updates.length} updates attempted, ${results.filter(r => r.startsWith('UPDATED')).length} applied.`);
}

main().catch(e => { console.error(e); process.exit(1); });
