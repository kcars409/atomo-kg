# KG Lead Ingestion Rules

Reference file — loaded by /check-emails. Not needed for pipeline review or other workflows.

## Lead Sources & Geographic Policy
- KG Corporate provides leads via SharePoint spreadsheets and a biweekly Restaurant Activity Report
- Source data is nationwide — apply 1.5-hour drive radius filter from Lincoln, NE on all lead processing
- Leads outside radius: do not block or reject — flag with trip fee notice in Telegram alert
- Kent or Vincent will still call outside-radius leads; the flag lets them communicate the trip fee upfront
- Nebraska health dept public records: secondary lead source (future)
- Do not build custom ingestion pipeline until prospects.json schema and routing rules are solid

## Round-Robin Assignment (Kent + Vincent)
- Applies to: Web Form, Cohesive, and Call Office leads — combined pool
- CSS leads are exempt — assigned by Kyra
- Tracked in: ~/contexts/KG/lead-rotation.json
- Flow: Atomo sends Telegram asking "Is this your prospect? Yes/No"
  - **Yes** → assign to Kent, flip next to Vincent, log override if applicable
  - **No** → assign to Vincent, flip next to Kent, honor system from here
- Log all assignments in prospects.json regardless of owner

## CSS Lead Rule
**Trigger:** Email at atomoseevers@gmail.com with subject containing `[Appointment]` or from CSS-related sender, with `invite.ics` attachment

**What CSS is:** Corporate Sales Support — Kyra assigns these. An appointment has already been scheduled with the prospect by a CSS rep (via TimeTap). Inspection is confirmed. Not subject to round-robin.

**Extract from email body:**
- Company name → from Client Address block
- Contact name → from "appointment with [name]"
- Contact email → from "contact the client at"
- Contact phone → "Ph: (W)" number only — ALWAYS ignore the Sales Person phone (Brenda Talbert or any CSS rep — identified by appearing after "Sales Phone:" label)
- Address, City, State, Zip → from Client Address block
- Inspection date/time → from appointment line (e.g. "Wednesday, Apr 15, 2026 at 1:00 PM CDT")
- Notes → full text between "Notes:" and "Sales Person:"
- TimeTap Appointment ID → from "Appointment ID:" line
- Sister property → flag if multiple locations mentioned in notes

**Static values:**
- LeadSource = CSS
- NextServiceName = Inspection
- Owner = Kent Seevers
- Are you a New Customer = Yes

**Outputs:**
- SM CSV generated for primary location — ready to upload
- If sister property detected: second SM CSV generated, flagged "INCOMPLETE — needs manual review before upload"
- Entry added to prospects.json — full notes, TimeTap ID, sister property flag
- Telegram alert: "New CSS lead: [Company] ([City]) — [Contact], inspection [date/time]. [Sister property flagged at [address] if applicable]"

**Do not import:** Sales Person name, Sales Phone number, TimeTap login link

## Web Form Lead Rule
**Trigger:** Email at atomoseevers@gmail.com with subject containing `New Form Submission From Contact Kitchen Guard of Nebraska`

**What Web Form is:** Prospect filled out the KG Nebraska contact form. Forwarded by Kyra to Kent and Vincent. Subject to round-robin assignment.

**Outlook forward rule:** Already created — forwards matching emails to atomoseevers@gmail.com

**Extract from email body:**
- First name, Last name, Company name, Title
- Address, City, State, Zip
- Phone, Email
- "Tell Us More" → Notes
- "How Did You Hear About Us?" → LeadSource detail
- Sister property flag if multiple locations mentioned in Tell Us More

**Static values:**
- LeadSource = KG Website
- Are you a New Customer = Yes
- Owner = Kent (only if Kent's turn)

**Flow:**
1. Extract fields
2. Geographic check — flag trip fee if outside 1.5hr radius from Lincoln NE
3. Telegram: "New Web Form lead: [Name], [Company], [City]. [⚠️ Outside radius — trip fee applies.] Next up: [Kent/Vincent]. Is this your prospect? Yes/No"
5. **No** → Vincent's, flip rotation, log in prospects.json, done

## Cohesive Lead Rule
**Trigger:** Email at atomoseevers@gmail.com with subject starting with `Cohesive AI - Reply from`

**What Cohesive is:** AI outreach tool running cold email sequences. This email means a prospect replied — it's a warm lead. Subject to round-robin. Cohesive sends 2 emails and 2 texts per lead reply — deduplication is critical. Texts go to work phone — ignore.

**Deduplication (always first step):**
1. Extract lead email from subject line
2. Check against prospects.json
3. If exists and reply body is identical → discard silently
4. If exists and reply body has new information → update prospects.json, Telegram: "Duplicate Cohesive lead: [Name/email] — record updated with new reply info."
5. If exists and no new info → stop, do nothing

**Extract from email body:**
- Email → from subject line and Lead Information block
- Phone → Lead Information block, strip country code (e.g. 14029436238 → (402) 943-6238)
- Address → Lead Information block
- Website → Lead Information block, infer company name from domain
- User Reply → full text as Notes
- Cohesive campaign link → store in prospects.json

**Lead temperature (scan User Reply text):**
- "call me", "meet", "interested", "schedule", "happy to chat" → Hot
- Neutral or unclear → Contacted — Responded

**Static values:**
- LeadSource = Cohesive
- Are you a New Customer = Yes
- Owner = Kent (only if Kent's turn)

**Flow:**
1. Dedup check
2. Extract fields
3. Geographic check — flag trip fee if outside 1.5hr radius
4. Assess lead temperature
5. Telegram: "New Cohesive lead: [Name], [Company] ([City] — [within/outside] radius). [Hot — wants a call/meeting.] Next up: [Kent/Vincent]. Is this your prospect? Yes/No"
7. **No** → Vincent's, flip rotation, log in prospects.json, done

## ServiceMinder CSV Generation Rules
- **Template:** ~/contexts/KG/serviceminder_upload_template.csv
- **Output naming:** `sm_import_[companynameslug]_[YYYYMMDD].csv`
- **Always populate:** Name, Contact Person, Contact Person Email, Phone, Address1, City, State, Zip, LeadSource, NextServiceName, NextServiceDate (if known), Owner, Are you a New Customer, Notes
- **Never populate:** AccountingClass (set by owners), Sales Person fields, any CSS rep contact info
- **Sister property CSVs:** generate with available data, add to Notes: "INCOMPLETE — sister property, needs manual review before upload"
