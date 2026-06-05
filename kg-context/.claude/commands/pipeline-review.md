Run the KG daily pipeline review. Follow this sequence exactly — do not skip steps.

## Command Shortcuts

During the card loop, Kent will respond with one of these — act immediately without confirmation:

| Input | Action |
|---|---|
| `b` | Bump to tomorrow |
| `b 5/15` or any date | Bump to that date |
| `cl` | Close Cold — no response / not ready / went elsewhere. Re-engage someday. (ask one-word reason) |
| `lost` | Close Lost — permanently off the list. No future outreach. (ask reason, then ask DNC?) |
| `cw` | Close Won (hand off to /close-won flow) |
| `14` | Move to In 14-Day |
| `next` or `n` | Advance 14-day to next step |
| `sm` | Schedule a meeting for this prospect |
| `t` | Send Teams message (ask who + draft, confirm before sending) |
| `skip` | Skip — revisit at end |
| `done` | End the card loop, go to wrap-up |
| `back` | Re-present the previous card |
| Free text | Note/update — ask next step + date, then write immediately |

## Account Classification Rules

| Category | Definition | Sales Tracker | Pipeline Review |
|---|---|---|---|
| **Lead** | Not yet contacted | NO | NO |
| **Prospect** | Made contact, actively working through the process | YES | YES |
| **Project** | Large multi-location account, needs deep research before outreach | NO | Snapshot only |
| **Current Customer** | Signed, has ongoing service relationship | YES | YES — flag `[CUSTOMER]` |
| **Cold** | Closed — door not shut. No response, not ready, went with competitor. Re-engage someday. | NO | NO |
| **Closed Lost** | Permanently off the list. Not a fit, business closed, or actively unwanted. No future outreach. | NO | NO |

**Do Not Contact flag** (`do_not_contact: true`): can be set on any record regardless of status. Always show `⛔ DO NOT CONTACT — {reason}` when this flag is present. Ask for confirmation before taking any outreach action.

Never include Leads in the card loop. Projects appear in the opening snapshot only, not the card loop.

---

## STARTUP — Run before anything else

One call. No other tool calls before this completes.

```bash
python3 /home/kent/scripts/kg-startup-data.py
```

Parse the JSON output. Store the entire result as `startup`.

- If `startup.mode == "fast"`: store `startup.sr` as `sr` and `startup.cards_data` as `cards_data`. Proceed to **FAST PATH** below.
- If `startup.mode == "fallback"`: proceed to **FALLBACK** section.

---

### FAST PATH (pre-warmed data available)

**Stop here. Do not read the Fallback section. Execute only these steps, then jump to Card Loop.**

**Step F1.** You already have `sr` and `cards_data` from the startup call. No additional reads needed.

**Step F2.** Print immediately — this is the first visible output:
```
Pre-warmed (built at {sr.built_at}). {sr.card_count} cards.
```
Then print `sr.rendered_snapshot` verbatim (do not reformat).

**Step F3.** Past meeting follow-ups. If `sr.rendered_past_meetings` is non-empty, print each entry verbatim and handle responses per **Meeting Follow-up Response Logic** below. Write each outcome immediately.

**Step F4.** Terminal candidates. If `sr.rendered_terminal_batch` is non-empty, print it verbatim and wait for responses. For each `y`: status = Cold, write immediately via kg-update-prospect.js.

**Step F5.** Set card stack = `sr.rendered_cards` (pre-rendered strings, one per card). Set pos = 0. Jump to **Card Loop**.

---

### EXIT 1 — FALLBACK (session-ready stale or missing)

**Pipeline data:** Check for `/home/kent/atomo-data/kg-cache/kg-pipeline-cache.json`.
- If it exists and `as_of` is today: use it. Say "Using pre-fetched pipeline from [time]."
- If missing or stale: run `python3 ~/scripts/pipeline-fetch.py --owner kent`.

**Outlook emails:** Check for `/home/kent/atomo-data/kg-cache/kg-emails-cache.json`.
- If it exists and `fetched_at` date matches today: show 3 most recent. Say "Using pre-fetched emails from [time]."
- If missing or stale: fetch live via Outlook MCP. If that errors, display re-auth steps from ~/CLAUDE.md.

**Past meeting follow-ups:** Read `~/contexts/KG/prospects.json` directly. Scan every prospect for:
- `inspection_meeting.datetime` < now AND no `inspection_meeting.completed_at`
- `proposal_meeting.datetime` < now AND no `proposal_meeting.completed_at`

Handle each before the card loop (see **Meeting Follow-up Response Logic** below).

**Terminal candidates:** Scan all due/overdue cards for terminal signals in `notes` or `next_step`: "declined", "expired", "no response", "lost", "close", "contracted with", "going with someone else". Present as a batch before the card loop.

**Opening snapshot:**
```
PIPELINE REVIEW - {as_of}
---------------------------------
Active (<=7 days):   {n}
Aging (8-13 days):   {n}
Stale (14+ days):    {n}
---------------------------------
Meetings today: {list or "none"}
---------------------------------
```
Then list any Projects (status = "Project") as one-liners.

**Build working list:** next_step_date <= today, sorted:
1. Meeting today (inspection or proposal datetime falls today, not yet completed)
2. Overdue (next_step_date < today)
3. Due today
4. In 14-Day
5. Upcoming / no date

Within each group, Kent's rows first. Report count: "X prospects due or overdue today."

---

## Meeting Follow-up Response Logic

```
MEETING FOLLOW-UP - [Company Name]
[Inspection / Proposal] on [date at time CDT]
--------------------------------------
```

**Inspection:**
- Ask: "Did it complete? (y / noshow / no)"
- `y` → "Notes?" → buffer: status=Inspection Complete, append to atomo_notes, set `inspection_meeting.completed_at`=now, `inspection_meeting.outcome`="completed"
  - **CSS note prompt (only if `lead_source === 'CSS'`):** "CSS note for this inspection? (type it or 'skip')"
    - Write changes first, then call:
      ```bash
      curl -s -X POST "http://localhost:3100/api/prospects/ENCODED_NAME/todos" \
        -H 'Content-Type: application/json' \
        -d '{"text":"CSS inspection note: [text]"}'
      ```
    - If 'skip': `{"text": "Add inspection notes in CSS (ServiceMinder)"}` — leaves todo open
  - If no `proposal_meeting` set: "No proposal meeting scheduled — set one now? (y/n)" → if y, run meeting scheduling flow
- `noshow` → "Notes?" → buffer: append to atomo_notes, set completed_at/outcome="no-show"
- `no` → "What happened?" → buffer: append notes, set completed_at/outcome="could-not-complete"

**Proposal:**
- Ask: "How did it go? (signed / followup / lost)"
- `signed` → "Notes?" → buffer: status=Closed Won, append to atomo_notes, set completed_at/outcome="signed" → hand off to /close-won
- `followup` → "Notes? Next step + date?" → buffer: append notes, set next step, set completed_at/outcome="follow-up"
- `lost` → "Reason?" → buffer: status=Closed Lost, append to atomo_notes, set completed_at/outcome="lost"

Write follow-up changes immediately:
```
echo '<JSON array>' | node ~/contexts/KG/scripts/kg-update-prospect.js
```

---

## Step 2 — Card Loop

**Cards are pre-rendered. Print `sr.rendered_cards[pos]` verbatim. Do not reformat.**

If the prospect has `do_not_contact: true` (check `cards_data` for the raw record), prepend `⛔ DO NOT CONTACT — {dnc_reason}` before printing the card. Ask confirmation before any outreach action.

After printing the card, wait for Kent's response. Execute the action, write the change immediately to prospects.json (see Per-Card Write below), then advance pos and print `sr.rendered_cards[pos]`.

**Actions:**
- `b` / bump → next_step_date = tomorrow (or specified date), write immediately
- `cl` → one-word reason, status = Cold, write immediately
- `lost` → reason, status = Closed Lost, write immediately. Then: "DNC? (y/n)" — if y, set `do_not_contact: true`, ask reason, write immediately
- `cw` → hand off to /close-won inline
- `14` → status = In 14-Day, 14day_start_date = today, 14day_step = day3, next_step_date = today+2, write immediately
- `next` → advance 14day_step, set next_step_date per schedule, write immediately
- `sm` → run meeting scheduling flow (see below), then return to this card
- `t` → ask "Who? (vince/tom/kyra or email)" and "Message?", show full draft, wait for approval, then send:
  ```bash
  echo '{"to":"ALIAS_OR_EMAIL","message":"DRAFT"}' | node /home/kent/contexts/KG/kg-send-teams.js
  ```
  Report result. Return to current card — do NOT advance.
- `skip` → skip, revisit at end — do NOT write
- `done` → end loop, go to Step 3 — do NOT write (nothing to save)
- `back` → re-present previous card
- Free text → log as note, ask for next step + date, write immediately

**Per-Card Write** — after every action except `skip`, `done`, and `back`, run:
```bash
echo '[{"name":"COMPANY NAME","field":"value",...}]' | node ~/contexts/KG/scripts/kg-update-prospect.js
```
Include only the fields that changed for this card. Do not accumulate a buffer across cards.

After parsing any response, confirm in one line: `✓ "{next_step}" - {date}`

Flag any Sales Tracker prospect not in prospects.json and ask whether to add.

## Meeting Scheduling Flow (triggered by `sm`)

1. "Inspection or Proposal? (i/p)"
2. "Date and time? (e.g. tomorrow 2pm, 5/30 10am)" — parse to ISO datetime in CDT
3. If **inspection** and no `proposal_meeting` already set:
   - "SOP: Proposal meeting must be set with DM before inspection. Set one now? (y/skip)"
   - `y` → also collect proposal date/time + DM name + DM email
   - `skip` → "Reason?" → record as sop_exception
4. If **proposal** (or "set now" from inspection path): "DM name? DM email?" (skip if already on the prospect)

Call the dashboard API to create the meeting and Outlook calendar event:
```bash
curl -s -X POST http://localhost:3100/api/prospects/ENCODED_NAME/meeting \
  -H 'Content-Type: application/json' \
  -d '{"type":"inspection","datetime":"...","sop_exception":"...","dm_contacts":[...]}'
```
If scheduling both inspection and proposal, make two sequential calls.

Report the result. If `calendar_error` is set in the response, say "Meeting saved — calendar invite failed: {error}."

## Day 14 Handling

When a card is In 14-Day status and the current step is Day 14:

**Check `sr.day14_sent[prospect_name]` first (fast path only — skip if fallback):**
- `true` → Email confirmed sent at prefetch time. Say "Day 14 email confirmed sent." Apply updates (see below). Move on.
- `false` → Email address on record but NOT found in recent sent items. Compose the Day 14 draft, show to Kent, send on confirmation.
- `null` → No email on record or sent data unavailable. Ask Kent: "Was the Day 14 email sent? (y/n)"
  - `y` → mark done, apply updates
  - `n` → compose draft, show to Kent, send on confirmation

**If fallback path (no sr):**
Check Outlook sent items via MCP for emails to that prospect's email address. If found: log it, mark done. If not found: compose the Day 14 final touchpoint email, show draft, send on confirmation.

**After sending or confirming sent — apply all three updates in one pass:**
- prospects.json: `14day_step = "done"`, `next_step = ""`, `next_step_date = ""`
- Sales Tracker "Day 14 Final touchpoint" column: today's date
- Sales Tracker "Cold" column: `X`
- Sales Tracker "Next step updated" column: clear

Do not close as Lost immediately after Day 14 — that happens only if no response follows.

## Step 3 — Wrap Up

prospects.json is already up to date — each card was written immediately during the loop. No batch write needed.

**Queue for SharePoint sync** — write to `~/atomo-data/pipeline-queue.json`:
```json
{ "changes": [{ "prospect": "Name", "next_step": "...", "next_step_date": "YYYY-MM-DD", "status": "...", "notes": "..." }] }
```

**Print summary:**
```
---------------------------------
REVIEW COMPLETE - {N} updates
{one line per changed prospect: name -> new next step}
---------------------------------
Sync to SharePoint now? (yes/no)
```
- Yes → `python3 ~/scripts/pipeline-writeback.py --changes ~/atomo-data/pipeline-queue.json`
- No → nightly sync at 11pm CDT will push the queue automatically

**Then:**
- Write `~/temp/kg-bumped-today.json` (bumped prospects, or `[]` to clear)
- If any new Inspection Scheduled or Inspection Complete: `node ~/contexts/KG/scripts/kg-generate-sm-csv.js`
- Report CSV count and paths

## Constraints

- Never ask "what would you like to do?" — just present the next card
- Never print raw JSON
- Dates default to today if Kent doesn't specify
- Keep responses short — rapid-fire review, not a conversation
- If Kent asks about a prospect not in the current card, answer briefly and return to the loop
- **No Todoist.** Not part of this workflow.
- **Gold rows = 3+ locations.** Pass `"num_locations": N` in the update; writeback.py applies gold fill (`FFC000`) automatically.
- **Sparse cell bug is fixed.** fetch.py uses cell coordinates — do not revert to sequential append.
