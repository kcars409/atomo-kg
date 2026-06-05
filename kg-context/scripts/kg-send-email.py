#!/usr/bin/env python3
# Sends a KG email via Graph API with correct CID inline logo attachment.
# Usage: echo '{"to":"a@b.com","subject":"Hi","body_html":"<p>Hi</p>"}' | python3 kg-send-email.py
import json, sys, urllib.request, base64, re
from pathlib import Path

ASSETS = Path(__file__).parent.parent / "assets"
TOKEN_PATH = Path.home() / ".outlook-mcp-tokens.json"

def get_token():
    return json.loads(TOKEN_PATH.read_text())["access_token"]

def build_sig():
    sig = (ASSETS / "email-signature.html").read_text()
    sig = re.sub(r'src="[^"]*kg-signature-logo[^"]*"', 'src="cid:kg-logo@kitchenguard"', sig)
    return sig

def send_email(to, subject, body_html, attachments=None):
    token = get_token()
    sig = build_sig()
    logo_bytes = (ASSETS / "kg-signature-logo.png").read_bytes()
    full_body = body_html + sig
    inline_logo = {
        "@odata.type": "#microsoft.graph.fileAttachment",
        "name": "kg-signature-logo.png",
        "contentType": "image/png",
        "contentBytes": base64.b64encode(logo_bytes).decode(),
        "contentId": "kg-logo@kitchenguard",
        "isInline": True
    }
    all_attachments = [inline_logo] + (attachments or [])
    message = {
        "message": {
            "subject": subject,
            "body": {"contentType": "HTML", "content": full_body},
            "toRecipients": [{"emailAddress": {"address": to}}],
            "attachments": all_attachments
        }
    }
    data = json.dumps(message).encode()
    req = urllib.request.Request(
        "https://graph.microsoft.com/v1.0/me/sendMail",
        data=data,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        method="POST"
    )
    try:
        r = urllib.request.urlopen(req)
        print(f"Sent to {to} | Status: {r.status}")
        return True
    except urllib.request.HTTPError as e:
        print(f"ERROR {e.code}: {e.read().decode()[:200]}")
        return False

if __name__ == "__main__":
    payload = json.loads(sys.stdin.read())
    file_attachments = []
    for fa in payload.get("file_attachments", []):
        path = Path(fa["path"])
        file_attachments.append({
            "@odata.type": "#microsoft.graph.fileAttachment",
            "name": fa.get("name", path.name),
            "contentType": fa.get("content_type", "application/octet-stream"),
            "contentBytes": base64.b64encode(path.read_bytes()).decode()
        })
    send_email(payload["to"], payload["subject"], payload["body_html"], file_attachments)
