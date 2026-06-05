Fill out the KG expense reimbursement form and save it as a .docx.

Usage: /expense-reimbursement

## Overview

Generates a filled copy of the expense reimbursement template as a .docx file, saved to ~/contexts/KG/assets/ with a dated filename. Optionally sends it to Tom and Kyra with receipt attachments.

## Step 1 - Collect Expense Line Items

Ask Kent for each expense:
- Date (MM/DD/YYYY)
- Description (e.g. "Fuel - U-Stop #8, Lincoln")
- Amount (USD)
- Category (e.g. Fuel, Meals, Supplies)

Continue until Kent says done. Compute the total.

If receipts were recently emailed to kent.seevers@kitchenguard.com, offer to read them from Outlook instead. Use mcp__claude_ai_Microsoft_365__outlook_email_search to find the email, then read each attachment image to extract line items. Ask Kent to confirm extracted amounts and flag any personal items to exclude before proceeding.

## Step 2 - Generate the .docx

Download the blank template from Kent's OneDrive and fill it via XML patching (preserves original formatting exactly).

**Template location on OneDrive:**
- Drive ID: `b!YEDgvZsTZEqyyihZkrLd9QRSqZK-iaZJtDvgHyLZUdxL1MSyjaFrRqvurjgVxrH3`
- Item ID: `01JL4WSS6Q2E3BSUYNJNCY6OVH4NWHUSAN`
- Filename: `Expense reimbursement 5-13.docx`

**Process (run as inline Python after sourcing env):**

```python
set -a; source ~/.env-atomo; set +a

# 1. Download template via Graph API (follow redirects)
#    GET https://graph.microsoft.com/v1.0/drives/{DRIVE_ID}/items/{ITEM_ID}/content
#    Use ensureAuthenticated() from /home/kent/outlook-mcp/auth via Node, or
#    use the access_token from ~/.outlook-mcp-tokens.json with curl -L

# 2. Fill fields via Python zipfile + string replacement:
import zipfile, re, os

# Open template, read all files into dict
# Modify word/document.xml:
#   - Replace trailing space after "Name:" label run with " Kent Seevers"
#   - Replace trailing space after first "Date:" label run with " MM/DD/YYYY" (today)
#   - Replace trailing space after "Total Amount:" label run with " $X.XX"
#   - For table rows 1-N: inject <w:r><w:t>VALUE</w:t></w:r> into each empty <w:p>
#     Pattern per cell: replace first </w:p> in cell with <w:r>...<w:t>VALUE</w:t></w:r></w:p>
# Rezip and save to output path
```

The table has 4 rows (1 header + 3 data). Fill rows 1 and 2 with expenses; leave row 3 blank.

Use today's date in the filename. Employee name is always Kent Seevers.
Output path: `/home/kent/contexts/KG/assets/expense-reimbursement-YYYY-MM-DD.docx`

**Token auth:** always `set -a; source ~/.env-atomo; set +a` before running Node/Python that calls ensureAuthenticated(). The token auto-refreshes and saves back to `~/.outlook-mcp-tokens.json`.

## Step 3 - Confirm Save Location

Tell Kent the full path where the file was saved.

## Step 4 - Offer to Send

Ask: "Want me to send this to Tom and Kyra? If you have receipt photos, email them to kent.seevers@kitchenguard.com first and I'll attach them."

If yes:
- Fetch any receipt images Kent emailed (read attachments from Outlook)
- Download receipt images to /tmp/
- Use kg-send-email.js (kgSend) to send to tom.dornish@kitchenguard.com, cc kyra.dornish@kitchenguard.com
- Subject: "Expense Reimbursement - Kent Seevers"
- Attach: filled .docx + receipt images
- Body: "Please see attached."
- Always source ~/.env-atomo before running kg-send-email.js

## Notes

- SharePoint template (read-only reference): `https://clintarholdings.sharepoint.com/sites/KGofNebraska/Shared Documents/NE General/Expense reimbursement template.docx` - IT blocks file download from SharePoint, use OneDrive copy instead
- OneDrive blank template: `Expense reimbursement 5-13.docx` (Drive/Item IDs above) - accessible via Graph API with existing Outlook token
- Saved files go to `~/contexts/KG/assets/` - not `~/temp/` - so they persist
- docx npm at `/home/kent/node_modules/docx` is NOT used for this approach - zipfile XML patching preserves original formatting
