// Generates SM import CSVs for prospects at Inspection Scheduled or Inspection Complete.
// Run at the end of a pipeline review session, or on demand.
// Output: ~/temp/sm_import_[slug]_[date].csv
// Also marks prospects with sm_csv_generated: true in prospects.json.

const fs = require('fs');
const path = require('path');

const PROSPECTS_PATH = '/home/kent/contexts/KG/prospects.json';
const TEMP_DIR = '/home/kent/temp';
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

// SM template columns — exact order matters for import
const SM_COLUMNS = [
  'Id','Name','Nickname','Title','Company','County','CreatedAt','UpdatedAt',
  'Email','Do Not Mail','Unsubscribed','CreditHold','Phone','PhoneLabel',
  'Alt Phone','AltPhoneLabel','Address1','Address2','City','State','Zip',
  'Community','Lat','Lon','Tags','BillingAddressName','BillingAddress1',
  'BillingAddress2','BillingCity','BillingState','BillingZip','BillingCommunity',
  'BillingCounty','BillingLat','BillingLon','NationalAccount','ContactCategory',
  'ManagedBy','ManagedByAddress','Owner','AccountingClass','LeadSource','Campaign',
  'NextServiceName','NextServiceDate','LastServiceDate','FlashMessage','NamedTaxRate',
  'Initial Contact First Name','Initial Contact Last Name',
  'Hours We Can Be IN by','Hours We Have To Be OUT By',
  'Contact Person','Contact Person Mobile','Contact Person Email',
  'Roof Access Instructions','Special Instructions','Parking Instructions',
  'Water Hookup Instructions','Noise Issues','Declined Repairs',
  'Does this account have an open balance to be paid?',
  'Does this account need a commission reduction?','Lost Account Reason',
  'Has this account been sent to collections?','Has a release of liability been sent?',
  'Tracking number for certified letter','Alarm Code','Notes',
  'Number of Hoods','Number of Fans','Initial Contact Emails','Service Requested',
  'How did you find out about us?','Why did you leave your current hood company?',
  'Do you have roof access?','Initial Contact Name','Security Contact',
  'Property Management Contact?','Annual Contract Value','Access',
  'Annual Value of Deal Amount','Key','Customer Notes','Are you a New Customer ?',
  'Web Message','IA Video Needed','Magnetic','Physical Invoice?','General Notes',
  'Current KEC Provider','Recommended Repairs','Inaccessible Areas (If Any)',
  'Roof','Kitchen','Green Steam','Roof Clean Up','Vapor Cleaning',
  'Water channel','Is there a dishwasher fan?'
];

function csvEscape(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function slugify(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
}

function prospectToSmRow(p) {
  const row = {};
  SM_COLUMNS.forEach(col => { row[col] = ''; });

  row['Name']                        = p.name || p.company || '';
  row['Title']                       = p.title || '';
  row['Company']                     = p.company || '';
  row['Email']                       = p.email || '';
  row['Phone']                       = p.phone || '';
  row['Address1']                    = p.address1 || '';
  row['Address2']                    = p.address2 || '';
  row['City']                        = p.city || '';
  row['State']                       = p.state || '';
  row['Zip']                         = p.zip || '';
  row['Owner']                       = p.owner || 'Kent Seevers';
  row['LeadSource']                  = p.lead_source || '';
  row['NextServiceName']             = p.next_service_name || (p.status === 'Inspection Scheduled' ? 'Inspection' : '');
  row['NextServiceDate']             = p.next_service_date || '';
  row['Initial Contact First Name']  = p.first_name || '';
  row['Initial Contact Last Name']   = p.last_name || '';
  row['Initial Contact Name']        = [p.first_name, p.last_name].filter(Boolean).join(' ');
  row['Initial Contact Emails']      = p.email || '';
  row['Contact Person']              = p.contact_person || '';
  row['Contact Person Mobile']       = p.phone || '';
  row['Contact Person Email']        = p.contact_person_email || p.email || '';
  row['How did you find out about us?'] = p.how_did_you_find_out || '';
  row['Are you a New Customer ?']    = p.are_you_a_new_customer || 'Yes';
  row['Notes']                       = p.notes || '';
  row['General Notes']               = p.atomo_notes || '';

  // Access info — populated at Inspection Complete
  row['Hours We Can Be IN by']       = p.hours_in || '';
  row['Hours We Have To Be OUT By']  = p.hours_out || '';
  row['Roof Access Instructions']    = p.roof_access_instructions || '';
  row['Do you have roof access?']    = p.roof_access ? 'Yes' : '';
  row['Alarm Code']                  = p.alarm_code || '';
  row['Access']                      = p.access_notes || '';
  row['Key']                         = p.key_info || '';
  row['Parking Instructions']        = p.parking_notes || '';
  row['Special Instructions']        = p.special_instructions || '';
  row['Water Hookup Instructions']   = p.water_hookup || '';
  row['Noise Issues']                = p.noise_issues || '';
  row['Security Contact']            = p.security_contact || '';
  row['Number of Hoods']             = p.num_hoods != null ? p.num_hoods : '';
  row['Number of Fans']              = p.num_fans != null ? p.num_fans : '';

  return row;
}

function generateCsv(prospects) {
  const header = SM_COLUMNS.map(csvEscape).join(',');
  const rows = prospects.map(p => {
    const row = prospectToSmRow(p);
    return SM_COLUMNS.map(col => csvEscape(row[col])).join(',');
  });
  return [header, ...rows].join('\n');
}

function run() {
  const all = JSON.parse(fs.readFileSync(PROSPECTS_PATH, 'utf8'));

  const pending = all.filter(p =>
    ['Inspection Scheduled', 'Inspection Complete'].includes(p.status) &&
    !p.sm_csv_generated
  );

  if (pending.length === 0) {
    console.log('No pending SM CSVs to generate.');
    return [];
  }

  const generated = [];

  for (const p of pending) {
    const slug = slugify(p.company || p.name);
    const filename = `sm_import_${slug}_${TODAY}.csv`;
    const outPath = path.join(TEMP_DIR, filename);
    const csv = generateCsv([p]);
    fs.writeFileSync(outPath, csv);
    p.sm_csv_generated = true;
    p.sm_csv_path = outPath;
    p.last_updated = TODAY;
    generated.push({ name: p.name || p.company, path: outPath, status: p.status });
    console.log(`  Generated: ${filename}`);
  }

  fs.writeFileSync(PROSPECTS_PATH, JSON.stringify(all, null, 2));
  return generated;
}

// Allow require() for use in pipeline review, or run standalone
if (require.main === module) {
  console.log('\nSM CSV Generator\n');
  const generated = run();
  if (generated.length > 0) {
    console.log(`\n${generated.length} CSV(s) written to ~/temp/ — ready to upload to ServiceMinder.`);
  }
}

module.exports = { run };
