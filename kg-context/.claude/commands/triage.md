Rapid pipeline triage. One snap decision per card. No actions taken — planning only.

## STARTUP

```bash
python3 /home/kent/scripts/kg-startup-data.py
```

Parse JSON. If `mode == fallback`, abort: "Session-ready missing — run kg-prefetch.sh first."

Store `sr` and `cards_data`. Then run:

```bash
python3 -c "
import json, os
from datetime import date
today = date.today().isoformat()
prospects = json.load(open(os.path.expanduser('~/contexts/KG/prospects.json')))
done_today = {p['name'] for p in prospects if p.get('triage_done_today') == today}
print(json.dumps(list(done_today)))
"
```

Store result as `done_today`.

Set `cards = cards_data.cards`.
Filter to: `next_step_date <= today` AND `name not in done_today`.

If any were excluded, print: `({N} already marked done in triage today, skipped)`

Capture the start timestamp:
```bash
date +%s
```
Store result as `start_epoch`.

Print:
```
TRIAGE - {date} | {N} cards | clock is running
```

---

## Snap Grammar

| Input | Queues |
|---|---|
| `call` | Call prospect |
| `email` | Send follow-up email |
| `t` | Teams message to Vince |
| `t tom` / `t kyra` | Teams to that person |
| `day14` | Send Day 14 email |
| `close` | Close as Cold — door not shut, potential re-engage later |
| `lost` | Close as Lost — permanently off the list, no future outreach |
| `cw` | Close as Won — queues for /close-won flow in execute |
| `bump` | Bump to tomorrow |
| `bump 6/15` or any date | Bump to that date |
| `d` | Already handled today — writes `triage_done_today` flag, excludes from future triage runs today |
| `skip` | Exclude from execute |
| Free text | Use as triage note, then prompt: action? |

One word = instant. No confirmation. Present next card immediately.

---

## Card Loop

Card format:
```
──────────────────────────────
[N of TOTAL] COMPANY  ({X days overdue} / due today)
{contact} | {phone} | {email}
Next: {next_step}
{Note: {note}}   ← only if present
⛔ DO NOT CONTACT — {dnc_reason}   ← only if do_not_contact is true
──────────────────────────────
```

Wait for snap. Queue the action item. Print next card immediately.

**One write exception:** when Kent types `d`, immediately write `triage_done_today` to the prospect record:

```bash
echo '[{"name":"COMPANY_NAME","triage_done_today":"YYYY-MM-DD"}]' | node ~/contexts/KG/scripts/kg-update-prospect.js
```

All other snaps are queued — no writes until /execute.

---

## End — Write Triage File

After all cards (or when Kent types `done`):

Write `~/atomo-data/kg-triage-{date}.json`:
```json
{
  "date": "YYYY-MM-DD",
  "generated_at": "HH:MM",
  "items": [
    {
      "idx": 1,
      "name": "...",
      "company": "...",
      "action": "call|email|teams|day14|close|lost|bump",
      "contact": "...",
      "phone": "...",
      "email": "...",
      "status": "...",
      "next_step": "...",
      "next_step_date": "...",
      "days_overdue": N,
      "note": "...",
      "lead_source": "...",
      "city": "...",
      "teams_to": "vince|tom|kyra|null",
      "bump_date": "YYYY-MM-DD|null",
      "triage_note": "free text|null",
      "done": false
    }
  ]
}
```

Skip items where action = `skip`.

Compute elapsed time:
```bash
date +%s
```
Subtract `start_epoch` from this result, format as `Mm Ss`.

Print:
```
──────────────────────────────
TRIAGE COMPLETE
{N} items queued for /execute
  {n} calls   {n} emails   {n} teams   {n} day14   {n} close   {n} bumps
Elapsed: {Mm Ss}
Run /execute when ready.
──────────────────────────────
```
