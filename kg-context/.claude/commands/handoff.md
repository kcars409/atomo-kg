Send a scheduling handoff to Kyra via the "Scheduling Hand Off Notifications" Teams chat.

Format: `Restaurant Name - # Locations - Cadence - Availability - Contact - Payment - Key on file - Scheduler notes`

Tech notes (parking, water, repairs, portable) are NOT included here. They stay on the prospect record for eventual SM entry.

## STARTUP

Parse args if provided: `/handoff <prospect_name>`

If no arg, ask: "Which prospect?"

Then run both in parallel:

```bash
node /home/kent/scripts/kg-cc-inspection.js "PROSPECT_NAME"
```

```bash
python3 -c "
import json
ps = json.load(open('/home/kent/contexts/KG/prospects.json'))
hits = [p for p in ps if 'PROSPECT_NAME_LOWER' in p['name'].lower()]
if hits:
    p = hits[0]
    import sys; print(json.dumps({'name': p['name'], 'city': p.get('city',''), 'num_locations': p.get('num_locations', 1), 'notes': p.get('atomo_notes',''), 'address': p.get('address1',''), 'contact_person': p.get('contact_person',''), 'contact_person_mobile': p.get('contact_person_mobile',''), 'contact_person_email': p.get('contact_person_email','')}))
else:
    print('{\"error\": \"not found\"}')
"
```

Store CC result as `cc` and prospect result as `prospect`.

---

## Build the message

**Cleaning Cadence:**
- If `cc.found` and `cc.cadence` is set: use it directly (e.g. "Semi-annual")
- If `cc.cadence === "Other/Multiple"` and `cc.cadence_other`: use `cc.cadence_other`
- If not found: ask "Cleaning cadence? (Quarterly / Semi-annual / Annual / Other)"

**# of Locations:**
- Use `prospect.num_locations` if > 1, otherwise "1"

**Scheduling availability:**
- Build from CC fields, semicolons between items:
  - Hours: `cc.hours_in` and/or `cc.hours_out` if set (e.g. "Hours in: 6pm")
  - When: `cc.scheduling` if set (e.g. "ASAP")
  - Date detail: `cc.date_info` if set
- If none set: ask "When can they be scheduled? (times, days, ASAP, etc.)"

**Scheduling contact:**
- Use `prospect.contact_person` if set, append mobile/email if available
- If not set: ask "Who is the scheduling contact? (name + phone or email)"

**Payment:**
- Ask: "How are they paying? (check / credit card / ACH)"

**Key on file:**
- If `cc.key_on_file` is set: use it directly (e.g. "Key on file: Yes" or "Key on file: No")
- If not set: ask "Key on file? (y / n / pickup first cleaning)"

**Scheduler notes:**
- Ask: "Any other notes for Kyra? (access codes, special instructions, etc.) or 'none'"

**Tech notes - do NOT include in Kyra's message:**
- Parking (`cc.parking`), water access (`cc.water_access`), repairs (`cc.repairs`),
  portable needed (`cc.need_portable`), general notes (`cc.notes`) are excluded from the handoff.
- If any tech note fields are present, save them to the prospect record (see Send step).

---

## Show draft and confirm

```
----------------------------------------------
HANDOFF DRAFT - Scheduling Hand Off Notifications
----------------------------------------------
[PROSPECT_NAME] - [N location(s)] - [Cadence] - [Availability] - [Contact] - [Payment] - [Key on file] - [Scheduler notes if any]
----------------------------------------------
Send? (y / edit / cancel)
```

- `y` -> send
- `edit` -> ask what to change, redraft
- `cancel` -> abort

---

## Send

```bash
echo '{"message":"MESSAGE_TEXT"}' | node /home/kent/contexts/KG/kg-send-handoff.js
```

After send: write notes to the prospect record. Build two lines:
1. Handoff log: `DATE: Scheduling handoff sent to Kyra. Cadence: CADENCE. Payment: PAYMENT.`
2. If any tech note fields exist in CC (parking, water, repairs, portable, notes), append:
   `Tech notes: [assembled from cc fields, semicolons between items]`

```bash
echo '[{"name":"PROSPECT_NAME","atomo_notes":"NOTES"}]' | node /home/kent/contexts/KG/scripts/kg-update-prospect.js
```

Print: `Sent. Handoff logged on [prospect name].`

---

## Notes

- Teams chat: Scheduling Hand Off Notifications (19:1626e47e77674313afacb5e100cbf64d@thread.v2)
- CC data pulls from the newest Condensed Inspection checklist on the project
- If CC project not found, all fields fall back to manual entry
