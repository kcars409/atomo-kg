Close a prospect as Lost.

Usage: /close-lost [prospect name or partial match]

## Step 1 — Find Prospect

Find the matching record in ~/contexts/KG/prospects.json. If ambiguous, list matches and ask Kent to confirm.

## Step 2 — Confirm

Ask for a brief reason (optional — e.g. "no response after Day 14", "price", "went with competitor").

## Step 3 — Update prospects.json

Set:
- `status`: Closed Lost
- `closed_date`: today
- `closed_reason`: reason if provided
- Clear `next_step` and `next_step_date`

## Step 4 — Summary

One line confirming what was updated.
