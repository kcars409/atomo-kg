/**
 * KG email sender -- always injects the signature and logo.
 * Use this for all outgoing KG emails instead of calling send.js or reply.js directly.
 *
 * Usage:
 *   const { kgSend, kgReply } = require('./kg-send-email');
 *
 *   kgSend({ to, subject, body })
 *   kgReply({ messageId, body, cc?, replyAll? })
 *
 * `body` is the message content only -- signature is appended automatically.
 * Body may be plain text or HTML; plain text is wrapped in <p> tags.
 *
 * kgReply auto-detects whether the referenced message is a sent item or a
 * received message. For sent items (prospect never replied), it creates a draft
 * with proper In-Reply-To/References headers so the email threads correctly in
 * the prospect's inbox. For received messages, it uses the Graph reply endpoint.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const handleSendEmail = require('/home/kent/outlook-mcp/email/send.js');
const handleReplyEmail = require('/home/kent/outlook-mcp/email/reply.js');
const { callGraphAPI } = require('/home/kent/outlook-mcp/utils/graph-api');
const { ensureAuthenticated } = require('/home/kent/outlook-mcp/auth');

const LOGO_PATH = path.join(__dirname, 'assets/kg-signature-logo.png');
const SIGNATURE_PATH = path.join(__dirname, 'assets/email-signature.html');
const KG_FROM = 'kent.seevers@kitchenguard.com';

function noEmDash(str) {
  return (str || '').replace(/—/g, '-');
}

function buildSignedBody(body) {
  const HTML_TAGS = /<(html|body|p|div|span|table|tr|td|img|br|a|b|i|u|strong|em|h[1-6])\b/i;
  const htmlBody = HTML_TAGS.test(body)
    ? body
    : body.split(/\n{2,}/)
        .filter(para => para.trim())
        .map(para => `<p style="margin:0 0 1em 0;">${para.trim().replace(/\n/g, '<br>')}</p>`)
        .join('\n');

  let signature = fs.readFileSync(SIGNATURE_PATH, 'utf8');
  signature = signature.replace(/src="[^"]*kg-signature-logo\.png"/, 'src="cid:kg-logo@kitchenguard"');

  return `${htmlBody}\n<br>\n${signature}`;
}

function buildLogoAttachment() {
  return {
    name: 'kg-signature-logo.png',
    contentType: 'image/png',
    contentBytes: fs.readFileSync(LOGO_PATH).toString('base64'),
    contentId: 'kg-logo@kitchenguard'
  };
}

function formatAttachments(attachments) {
  return attachments.map(a => ({
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: a.name,
    contentType: a.contentType,
    contentBytes: a.contentBytes,
    ...(a.contentId ? { contentId: a.contentId, isInline: true } : {})
  }));
}

async function fetchMessage(accessToken, messageId) {
  const encodedId = encodeURIComponent(messageId);
  return new Promise((resolve, reject) => {
    https.get(
      `https://graph.microsoft.com/v1.0/me/messages/${encodedId}?$select=from,toRecipients,internetMessageId,subject`,
      { headers: { 'Authorization': 'Bearer ' + accessToken } },
      res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error('Graph API error: ' + JSON.stringify(parsed.error)));
          else resolve(parsed);
        });
      }
    ).on('error', reject);
  });
}

async function kgSend({ to, subject, body, cc, bcc, attachments = [] }) {
  if (!to || !subject || !body) throw new Error('to, subject, and body are required.');
  return handleSendEmail({
    to,
    subject: noEmDash(subject),
    body: buildSignedBody(noEmDash(body)),
    cc,
    bcc,
    attachments: [buildLogoAttachment(), ...attachments]
  });
}

async function kgReply({ messageId, body, cc, replyAll = false, attachments = [] }) {
  if (!messageId || !body) throw new Error('messageId and body are required.');

  const signedBody = buildSignedBody(noEmDash(body));
  const allAttachments = [buildLogoAttachment(), ...attachments];
  const accessToken = await ensureAuthenticated();

  const msg = await fetchMessage(accessToken, messageId);
  const fromAddr = (msg.from?.emailAddress?.address || '').toLowerCase();

  if (fromAddr === KG_FROM.toLowerCase()) {
    // Sent item: prospect never replied. Build a draft with proper RFC threading
    // headers (In-Reply-To + References) so it threads in the prospect's inbox.
    const subject = msg.subject.startsWith('Re:') ? msg.subject : 'Re: ' + msg.subject;

    const draftPayload = {
      subject,
      body: { contentType: 'HTML', content: signedBody },
      toRecipients: msg.toRecipients,
      internetMessageHeaders: [
        { name: 'In-Reply-To', value: msg.internetMessageId },
        { name: 'References', value: msg.internetMessageId }
      ],
      attachments: formatAttachments(allAttachments)
    };

    if (cc) {
      draftPayload.ccRecipients = cc.split(',').map(e => ({ emailAddress: { address: e.trim() } }));
    }

    const draft = await callGraphAPI(accessToken, 'POST', 'me/messages', draftPayload);
    await callGraphAPI(accessToken, 'POST', `me/messages/${draft.id}/send`, {});
    return { content: [{ type: 'text', text: 'Reply sent in thread (threaded via sent item).' }] };
  }

  // Received message: use the Graph reply endpoint (handles threading natively).
  return handleReplyEmail({
    messageId,
    body: signedBody,
    cc,
    replyAll,
    attachments: allAttachments
  });
}

module.exports = { kgSend, kgReply };
