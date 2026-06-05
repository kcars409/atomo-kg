/**
 * Fetch Outlook contacts and report summary for prospects.json import review.
 */
const { ensureAuthenticated } = require('/home/kent/outlook-mcp/auth');
const https = require('https');

function graphGet(path, token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'graph.microsoft.com',
      path: `/v1.0${path}`,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchAllContacts(token) {
  const contacts = [];
  let url = '/me/contacts?$top=100&$select=displayName,givenName,surname,jobTitle,companyName,emailAddresses,businessPhones,mobilePhone,businessAddress,homeAddress';

  while (url) {
    const res = await graphGet(url, token);
    if (res.error) throw new Error(JSON.stringify(res.error));
    contacts.push(...(res.value || []));
    url = res['@odata.nextLink']
      ? res['@odata.nextLink'].replace('https://graph.microsoft.com/v1.0', '')
      : null;
  }
  return contacts;
}

(async () => {
  const token = await ensureAuthenticated();
  const contacts = await fetchAllContacts(token);

  console.log(`Total contacts: ${contacts.length}\n`);

  // Print each contact in a readable format
  contacts.forEach((c, i) => {
    const email = c.emailAddresses?.[0]?.address || '';
    const phone = c.businessPhones?.[0] || c.mobilePhone || '';
    const city = c.businessAddress?.city || c.homeAddress?.city || '';
    const state = c.businessAddress?.state || c.homeAddress?.state || '';
    console.log(`[${i + 1}] ${c.displayName || '(no name)'}`);
    if (c.companyName) console.log(`    Company: ${c.companyName}`);
    if (c.jobTitle) console.log(`    Title: ${c.jobTitle}`);
    if (email) console.log(`    Email: ${email}`);
    if (phone) console.log(`    Phone: ${phone}`);
    if (city || state) console.log(`    Location: ${[city, state].filter(Boolean).join(', ')}`);
    console.log('');
  });
})();
