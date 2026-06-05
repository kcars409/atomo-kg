"use strict";
require("dotenv").config({ path: "/home/kent/.env-atomo" });
const { graphPost } = require("./parsers/lib/graph-client");

const CHAT_ID = "19:1626e47e77674313afacb5e100cbf64d@thread.v2";

async function main() {
  const input = JSON.parse(require("fs").readFileSync("/dev/stdin", "utf8"));
  const msg = (input.message || "").replace(/—/g, "-").replace(/–/g, "-");
  await graphPost(`/v1.0/chats/${CHAT_ID}/messages`, {
    body: { contentType: "text", content: msg },
  });
  console.log(JSON.stringify({ success: true, preview: msg.slice(0, 100) }));
}

main().catch(e => { console.error(e.message); process.exit(1); });
