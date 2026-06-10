Close a prospect as Won and complete the full ops handoff. Run this when a proposal is signed.

Usage: /close-won [prospect name or partial match]

## Pre-flight

1. If a name was provided, find the matching record in ~/contexts/KG/prospects.json. If ambiguous, list matches and ask Kent to confirm. If none found, ask for clarification.

2. Test Outlook connectivity: fetch the 1 most recent email from the KG inbox (kent.seevers@kitchenguard.com). If this fails, stop and display the re-auth steps from the "Outlook Re-Authentication (Headless)" section of ~/CLAUDE.md. Do not proceed until connectivity is confirmed.

## Step 1 — Confirm Deal Details

Ask Kent to confirm or provide:
- Annualized revenue value
- First service date (or "ASAP" if not specified)
- Payment method (check, card, invoice)

## Step 2 — Update prospects.json

Set status to `Closed Won`. Record:
- `closed_date`: today
- `annualized_value`: confirmed value
- `first_service_date`: confirmed date or "ASAP"
- `payment_method`: confirmed method
- Clear `next_step` and `next_step_date`

## Step 2.5 — CSS Note (CSS leads only)

**Skip this step entirely if `lead_source` is not `CSS`.**

Ask: "CSS note for this account? (type it for the record, or 'skip')"

Create the todo via API (replace ENCODED_NAME with `encodeURIComponent(name)`):
```bash
curl -s -X POST "http://localhost:3100/api/prospects/ENCODED_NAME/todos" \
  -H 'Content-Type: application/json' \
  -d '{"text":"..."}'
```
- If Kent typed a note: `{"text": "CSS closing note: [text]"}`
- If 'skip': `{"text": "Add closing notes in CSS (ServiceMinder)"}` — leaves it open as a reminder

Confirm: "CSS todo created."

## Step 3 — ServiceMinder CSV

If sm_csv_generated is false or SM CSV v2 has not been generated, run:
`node ~/contexts/KG/scripts/kg-generate-sm-csv.js`

Report the output path.

## Step 4 — Scheduling Handoff Checklist

Pull CompanyCam inspection data first:

```bash
node /home/kent/scripts/kg-cc-inspection.js "PROSPECT_NAME"
```

Use CC data to pre-fill what's available. For each field below, show the pre-filled value (if any) and ask Kent to confirm or fill in gaps. Do not skip fields — all must be confirmed before proceeding:

- [ ] Number of Hoods — from `cc.hoods`, else ask
- [ ] Number of Fans — from `cc.fans`, else ask
- [ ] Hours IN (`hours_in`) — ask (not in CC)
- [ ] Hours OUT (`hours_out`) — ask (not in CC)
- [ ] Access notes (`access_notes`) — ask (keys, entry method)
- [ ] Key info (`key_info`) — physical key, entry code, or lockbox (NOT alarm codes)
- [ ] Alarm Code (`alarm_code`) — security alarm only, blank if none
- [ ] IA Video Needed (`ia_video_needed`) — yes/no: inaccessible areas?
- [ ] Parking — from `cc.parking`, else ask
- [ ] Water hookup — from `cc.water_access`, else ask
- [ ] Special Instructions — from `cc.notes`, else ask; or "ASAP"

Update prospects.json as each field is confirmed. Confirm: "All handoff fields complete."

## Step 5 — Kyra Teams Handoff

Run `/handoff PROSPECT_NAME` inline. The skill will pull CC data, use the confirmed cadence, ask for scheduling date preference, and send the Teams message to Scheduling Hand Off Notifications.

Do not proceed past this step until the Teams message is confirmed sent.

## Step 6 — Summary

One line per action taken. Flag anything still needing manual follow-up.
