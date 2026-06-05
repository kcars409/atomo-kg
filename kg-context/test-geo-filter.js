#!/usr/bin/env node
/**
 * Geo-filter: check drive time from Lincoln NE to a given address.
 * Flags anything over 90 minutes (1.5 hours).
 * Usage: node test-geo-filter.js "City, State"
 */

const https = require('https');
require('dotenv').config({ path: `${process.env.HOME}/.env-atomo` });

const ORIGIN = 'Lincoln,NE+68508';
const THRESHOLD_SECONDS = 90 * 60;
const API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// Cities that exceed 90 min but are served without a trip fee by exception
const GEO_EXCEPTIONS = ['grand island, ne'];

function distanceMatrix(destination) {
  return new Promise((resolve, reject) => {
    const dest = encodeURIComponent(destination);
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${ORIGIN}&destinations=${dest}&mode=driving&units=imperial&key=${API_KEY}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}hr ${m}min` : `${m}min`;
}

async function checkAddress(address) {
  const result = await distanceMatrix(address);
  const element = result.rows?.[0]?.elements?.[0];
  if (!element || element.status !== 'OK') {
    return { address, error: element?.status || 'No result' };
  }
  const seconds = element.duration.value;
  const isException = GEO_EXCEPTIONS.includes(address.toLowerCase());
  const flag = seconds > THRESHOLD_SECONDS && !isException;
  const label = flag
    ? '🚩 FLAG — trip fee applies'
    : isException && seconds > THRESHOLD_SECONDS
      ? '✅ PASS (exception)'
      : '✅ PASS';
  return { address, seconds, display: formatDuration(seconds), flag, result: label };
}

async function runTests() {
  const testCases = [
    { address: 'Omaha, NE',        expect: 'pass ~1hr' },
    { address: 'Springfield, NE',  expect: 'pass ~30min' },
    { address: 'Grand Island, NE', expect: 'pass ~1hr 20min' },
    { address: 'Norfolk, NE',      expect: 'flag ~1hr 45min' },
    { address: 'Sioux City, IA',   expect: 'flag ~2hr' },
    { address: 'Kansas City, MO',  expect: 'flag ~3hr' },
  ];

  console.log('Geo-filter test — origin: Lincoln NE 68508, threshold: 90 min\n');

  for (const tc of testCases) {
    const r = await checkAddress(tc.address);
    if (r.error) {
      console.log(`❌ ERROR  ${tc.address}: ${r.error}  (expected: ${tc.expect})`);
    } else {
      console.log(`${r.result}  ${r.address} — ${r.display}  (expected: ${tc.expect})`);
    }
  }
}

// Single address mode
if (process.argv[2]) {
  checkAddress(process.argv[2]).then(r => {
    if (r.error) { console.error(`Error: ${r.error}`); process.exit(1); }
    console.log(`${r.result}  ${r.address} — ${r.display}`);
  });
} else {
  runTests();
}
