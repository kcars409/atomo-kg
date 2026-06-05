Check for new KG emails and process any inbound leads. Follow this sequence exactly.

## Pre-flight

Read ~/contexts/KG/assets/lead-ingestion-rules.md — required for all lead processing in this command.

Test Outlook connectivity: fetch the 5 most recent emails from the KG inbox (kent.seevers@kitchenguard.com). If this call errors, stop and display the re-auth steps from the "Outlook Re-Authentication (Headless)" section of ~/CLAUDE.md. Do not proceed until connectivity is confirmed.

## Step 1 — KG Inbox (Prospect Threads)

Search the KG Outlook inbox for emails received since the last pipeline review (or last 48 hours if unknown). Look for:
- Replies from prospects (any email not from an internal sender)
- New quote requests or inbound inquiries
- CSS lead notifications (subject contains `[Appointment]`)

For each prospect email found: surface it to Kent with sender, subject, date, and a one-line summary. Ask what action to take. If Kent directs an action (reply, status update, calendar invite), execute it and update prospects.json immediately per the Update Rule.

## Step 2 — Summary

Report:
- How many prospect threads reviewed
- Any actions taken or pending Kent's input
- Any prospects.json updates made this session
