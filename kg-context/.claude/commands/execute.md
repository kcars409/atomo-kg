Work through today's triage items. Writes happen here.

## STARTUP

```bash
python3 -c "
import json, os
from datetime import date
path = os.path.expanduser(f'~/atomo-data/kg-triage-{date.today().isoformat()}.json')
d = json.load(open(path))
pending = [x for x in d['items'] if not x.get('done')]
print(json.dumps({'items': pending, 'total': len(d['items'])}))
"
```

Store as `triage`. If file missing or empty, say "No triage file for today — run /triage first."

Count by action type and print:
```
EXECUTE - {date} | {N} items
  {n} calls  {n} emails  {n} teams  {n} day14  {n} close  {n} bumps
```

---

## Item Loop

For each item in `triage.items` (in order):

### CALL

```
──────────────────────────────
[N] CALL — COMPANY  ({days_overdue} days overdue)
{contact} | {phone}
{email}
Next step was: {next_step}
{note}
⛔ DO NOT CONTACT — {dnc_reason}   ← only if do_not_contact is true
──────────────────────────────
Reached them? (y / vm / no)
```

If `do_not_contact` is true: print the warning in red and ask "This prospect is flagged DNC — proceed anyway? (y/n)" before continuing.

- `y` → "What's the next step + date?" → write: update next_step + next_step_date + append note to atomo_notes
- `vm` → write: append "[{date}] Left voicemail." to atomo_notes, bump next_step_date +3 days
- `no` → write: append "[{date}] No answer." to atomo_notes, bump next_step_date +2 days

### EMAIL

Draft based on prospect context (status, notes, next step). Show draft before sending:
```
──────────────────────────────
[N] EMAIL — COMPANY
──────────────────────────────
To: {email}
Subject: {subject}
Body:
{body}
──────────────────────────────
Send? (y / edit / skip)
```

- `y` → send via:
  ```bash
  echo '{...}' | node /home/kent/contexts/KG/kg-send-email.js
  ```
  Then write: append sent note to atomo_notes, update next_step + next_step_date
- `edit` → ask what to change, redraft, show again
- `skip` → move on, no write

### TEAMS

Draft a Teams message to the specified recipient based on prospect context. Show draft:
```
──────────────────────────────
[N] TEAMS → {teams_to} — re: COMPANY
──────────────────────────────
{draft message}
──────────────────────────────
Send? (y / edit / skip)
```

- `y` → send via:
  ```bash
  echo '{"to":"{teams_to}","message":"{draft}"}' | node /home/kent/contexts/KG/kg-send-teams.js
  ```
  Then write: append "[{date}] Teams message sent to {teams_to} re: {company}." to atomo_notes
- `edit` → redraft, show again
- `skip` → move on, no write

### DAY14

Draft the Day 14 final touchpoint email. Same flow as EMAIL above.

After sending: write:
- `14day_step = "done"`
- `next_step = ""`
- `next_step_date = ""`
- Append sent note to atomo_notes

### CLOSE

```
──────────────────────────────
[N] CLOSE COLD — COMPANY
Reason? (one word or phrase)
──────────────────────────────
```

Write: status = Cold, append "[{date}] Closed Cold — {reason}." to atomo_notes.

### LOST

```
──────────────────────────────
[N] CLOSE LOST — COMPANY
Reason? (one word or phrase)
Do Not Contact? (y/n)
──────────────────────────────
```

- Write: status = Closed Lost, append "[{date}] Closed Lost — {reason}." to atomo_notes.
- If `y` to DNC: also set `do_not_contact: true`, ask "Reason for DNC?" and append "[{date}] DNC — {reason}." to atomo_notes.

### CLOSE_WON

```
──────────────────────────────
[N] CLOSE WON — COMPANY
──────────────────────────────
{note from triage item}
──────────────────────────────
```

Hand off to /close-won inline. After that flow completes, mark done.

### BUMP

No input needed. Write immediately: next_step_date = bump_date (or tomorrow if none set).
Print: `✓ {company} bumped to {date}` and continue.

---

## Write Pattern

After each item (except BUMP which is immediate and SKIP which writes nothing):

```bash
echo '[{"name":"COMPANY","field":"value",...}]' | node ~/contexts/KG/scripts/kg-update-prospect.js
```

Then mark done in the triage file:
```bash
python3 -c "
import json, os
from datetime import date
path = os.path.expanduser(f'~/atomo-data/kg-triage-{date.today().isoformat()}.json')
d = json.load(open(path))
for item in d['items']:
    if item['name'] == 'COMPANY_NAME':
        item['done'] = True
        break
json.dump(d, open(path, 'w'), indent=2)
"
```

---

## End

```
──────────────────────────────
EXECUTE COMPLETE
{N} done  {N} skipped
──────────────────────────────
Queue for SharePoint sync? (y/n)
```

If `y`:
```bash
python3 ~/scripts/pipeline-writeback.py --changes ~/atomo-data/pipeline-queue.json
```
