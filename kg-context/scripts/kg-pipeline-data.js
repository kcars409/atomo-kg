#!/usr/bin/env node
// Outputs a lean JSON of active prospects for pipeline review.
// Strips Not Contacted, Closed Won/Lost, Dormant — and trims each record
// to only the fields needed for the review card.

const fs = require("fs");
const path = require("path");

const PROSPECTS_PATH = path.join(__dirname, "..", "prospects.json");

const ACTIVE_STATUSES = new Set([
  "New Lead",
  "Not Contacted - Warm",
  "Contacted - Spoke",
  "Contacted - Responded",
  "Inspection Scheduled",
  "Inspection Complete",
  "Proposal Sent",
  "Proposal Delivered",
  "Working",
  "In 14-Day",
]);

const data = JSON.parse(fs.readFileSync(PROSPECTS_PATH, "utf8"));

function getLastNote(p) {
  // Combine all three note fields, newest appended content last
  const parts = [
    (p.notes || "").trim(),
    (p.atomo_notes || "").trim(),
    (p.notes_append || "").trim(),
  ].filter(Boolean);
  const combined = parts.join(" | ");
  // Return last two meaningful segments
  const segments = combined.split("|").map(s => s.trim()).filter(Boolean);
  return segments.slice(-2).join(" | ");
}

const active = data
  .filter(p => ACTIVE_STATUSES.has(p.status) && p.assigned_to !== "Vincent")
  .map(p => ({
    name: p.name,
    company: p.company,
    city: p.city,
    state: p.state,
    status: p.status,
    lead_source: p.lead_source,
    contact_person: p.contact_person,
    decision_maker: p.decision_maker || p.contact_person,
    next_step: p.next_step,
    next_step_date: p.next_step_date,
    "14day_start_date": p["14day_start_date"],
    "14day_step": p["14day_step"],
    last_note: getLastNote(p),    last_activity_date: p.last_activity_date,
  }));

process.stdout.write(JSON.stringify(active, null, 2));
process.stderr.write(`\nkg-pipeline-data: ${active.length} active of ${data.length} total prospects\n`);
