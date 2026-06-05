Plan an inspection trip: Home -> Shop (ladder/truck) -> Inspection site.

## STARTUP

Parse args if provided: `/inspection-trip <name> <time> [date]`

Examples:
- `/inspection-trip "Cristinas" "9am" "2026-06-08"`
- `/inspection-trip "Old Main" "10:30 AM"`

If any arg is missing, ask for it:
- Prospect name? (partial match OK)
- Appointment time? (e.g. 9am, 10:30 AM)
- Date? (YYYY-MM-DD -- press enter to use prospect's next_step_date)

Then run:

```bash
node /home/kent/scripts/kg-trip-plan.js "NAME" "TIME" "DATE"
```

Print the output verbatim.

---

## After output

Offer two follow-ups:

- **c** -- add the leave-home time as an Outlook calendar reminder
- **a** -- add the street address to this prospect (if flagged as missing)

### c: Calendar reminder

Build the leave-home time as ICS UTC format (YYYYMMDDTHHMMSSZ), then:

```bash
node -e "
const { createCalendarEvent } = require('/home/kent/contexts/KG/parsers/lib/graph-client');
require('dotenv').config({ path: '/home/kent/.env-atomo' });
createCalendarEvent({
  subject: 'Leave for KG Inspection -- PROSPECT_NAME',
  dtstart: 'LEAVE_UTC',
  dtend:   'LEAVE_UTC_PLUS15',
  body: 'Home to Shop (5030 S 16th St) to DESTINATION'
}).then(e => console.log('Created:', e.webLink)).catch(e => console.error(e.message));
"
```

### a: Add street address

Ask for the street address, then:

```bash
echo '[{"name":"PROSPECT_NAME","address1":"STREET"}]' | node /home/kent/contexts/KG/scripts/kg-update-prospect.js
```

---

## Hard-coded addresses

- Home : 1404 E 8th St Hickman, NE 68372
- Shop : 5030 S 16th St Lincoln, NE 68512
- Shop buffer: 15 min to load ladder and truck
- Drive times are live traffic-aware via Google Maps Distance Matrix API
