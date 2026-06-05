Send a scheduling handoff to Kyra via the "Scheduling Hand Off Notifications" Teams chat.

Format: `Restaurant Name - # of Locations - Cleaning Cadence - Scheduling Date - notes`

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
    import sys; print(json.dumps({'name': p['name'], 'city': p.get('city',''), 'num_locations': p.get('num_locations', 1), 'notes': p.get('atomo_notes',''), 'address': p.get('address1','')}))
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

**Scheduling Date:**
- If `cc.scheduling` is set: use it (e.g. "ASAP")
- If `cc.date_info` is also set: append it (e.g. "ASAP - Schedule on Sunday Evening")
- If neither: ask "Scheduling date? (ASAP or a specific date)"

**Notes:**
- Start with any relevant CC fields that Kyra needs:
  - Parking: `cc.parking` if set
  - Water access: `cc.water_access` if set
  - Notes: `cc.notes` if set
  - Repairs: `cc.repairs` if set
- Then ask: "Any additional notes for Kyra?"
- Combine all into one notes string, semicolons between items

---

## Show draft and confirm

```
----------------------------------------------
HANDOFF DRAFT - Scheduling Hand Off Notifications
----------------------------------------------
[PROSPECT_NAME] - [N location(s)] - [Cadence] - [Date] - [Notes]
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

After send: write a note to the prospect record:

```bash
echo '[{"name":"PROSPECT_NAME","atomo_notes":"DATE: Scheduling handoff sent to Kyra. Cadence: CADENCE. Scheduled: DATE_PREF."}]' | node /home/kent/contexts/KG/scripts/kg-update-prospect.js
```

Print: `Sent. Handoff logged on [prospect name].`

---

## Notes

- Teams chat: Scheduling Hand Off Notifications (19:1626e47e77674313afacb5e100cbf64d@thread.v2)
- CC data pulls from the newest Condensed Inspection checklist on the project
- If CC project not found, all fields fall back to manual entry
