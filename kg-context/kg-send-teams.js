'use strict';
// Send a Teams 1:1 chat message via Graph API.
// Usage:
//   echo '{"to":"user@domain.com","message":"text"}' | node kg-send-teams.js
//   node kg-send-teams.js --to user@domain.com --message "text"
//
// Known recipients (shortcuts):
//   vince  → Vincent.Policky@kitchenguard.com
//   tom    → tom.dornish@kitchenguard.com
//   kyra   → kyra.dornish@kitchenguard.com

require('dotenv').config({ path: '/home/kent/.env-atomo' });
const { sendTeamsMessage } = require('/home/kent/contexts/KG/parsers/lib/graph-client');

const KNOWN = {
  vince: 'Vincent.Policky@kitchenguard.com',
  tom:   'tom.dornish@kitchenguard.com',
  kyra:  'kyra.dornish@kitchenguard.com',
};

async function run() {
  let to, message;

  if (!process.stdin.isTTY) {
    const raw = await new Promise(res => {
      let buf = '';
      process.stdin.on('data', c => buf += c);
      process.stdin.on('end', () => res(buf));
    });
    const parsed = JSON.parse(raw.trim());
    to      = parsed.to;
    message = parsed.message;
  } else {
    const args = process.argv.slice(2);
    const ti = args.indexOf('--to');
    const mi = args.indexOf('--message');
    if (ti === -1 || mi === -1) {
      console.error('Usage: node kg-send-teams.js --to <email|alias> --message "text"');
      process.exit(1);
    }
    to      = args[ti + 1];
    message = args[mi + 1];
  }

  const email = KNOWN[to.toLowerCase()] || to;

  try {
    const result = await sendTeamsMessage(email, message);
    console.log(JSON.stringify({ success: true, to: result.to, preview: result.preview }));
  } catch (err) {
    console.error(JSON.stringify({ success: false, error: err.message }));
    process.exit(1);
  }
}

run();
