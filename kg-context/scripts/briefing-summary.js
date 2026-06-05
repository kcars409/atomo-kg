'use strict';
const fs = require('fs');
const path = require('path');

const PROSPECTS_PATH = path.join(__dirname, '../prospects.json');
const CLOSED = ['Closed Won', 'Closed Lost'];

function loadProspects() {
  try { return JSON.parse(fs.readFileSync(PROSPECTS_PATH)); }
  catch { return []; }
}

function getSummary() {
  const all = loadProspects();
  // Briefing is Kent's — only show his leads
  const prospects = all.filter(p => p.assigned_to === 'Kent' || p.owner === 'Kent Seevers');
  if (!prospects.length) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().slice(0, 10);

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const lines = [];

  // New leads since yesterday's briefing
  const newLeads = prospects.filter(p => {
    if (CLOSED.includes(p.status)) return false;
    const updated = new Date(p.last_updated);
    return updated >= yesterday && p.status === 'New Lead';
  });
  if (newLeads.length) {
    lines.push(`🆕 ${newLeads.length} new lead(s): ${newLeads.map(p => p.contact_person || p.company || p.email).join(', ')}`);
  }

  // Overdue follow-ups
  const overdue = prospects.filter(p => {
    if (CLOSED.includes(p.status)) return false;
    return p.next_step_date && p.next_step_date < todayStr;
  });
  if (overdue.length) {
    lines.push(`⚠️ ${overdue.length} overdue follow-up(s):`);
    overdue.forEach(p => {
      lines.push(`  • ${p.contact_person || p.company} — due ${p.next_step_date}`);
    });
  }

  // Open proposals with no activity in 14+ days
  const staleProposals = prospects.filter(p => {
    if (p.status !== 'Proposal Sent') return false;
    if (!p.last_activity_date) return true;
    const diff = (today - new Date(p.last_activity_date)) / (1000 * 60 * 60 * 24);
    return diff >= 14;
  });
  if (staleProposals.length) {
    lines.push(`📋 ${staleProposals.length} proposal(s) with no activity in 14+ days:`);
    staleProposals.forEach(p => {
      lines.push(`  • ${p.contact_person || p.company} (${p.last_activity_date || 'unknown'})`);
    });
  }

  // Inspection scheduled but missing service date
  const missingSvcDate = prospects.filter(p =>
    p.status === 'Inspection Scheduled' && !p.next_service_date
  );
  if (missingSvcDate.length) {
    lines.push(`📅 ${missingSvcDate.length} inspection(s) missing service date:`);
    missingSvcDate.forEach(p => {
      lines.push(`  • ${p.contact_person || p.company}`);
    });
  }

  if (!lines.length) return null;

  return { lines, counts: { newLeads: newLeads.length, overdue: overdue.length, staleProposals: staleProposals.length } };
}

module.exports = { getSummary };
