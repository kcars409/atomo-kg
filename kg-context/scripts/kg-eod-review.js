require('dotenv').config({ path: '/home/kent/.env-atomo' });
const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');
const { loadProspectsFlat } = require('../parsers/lib/shared');

const bot = new TelegramBot(process.env.TELEGRAM_KG_BOT_TOKEN);
const chatId = process.env.TELEGRAM_KG_CHAT_ID;

const CARDS_PATH       = '/home/kent/atomo-data/kg-review-cards.json';
const BUMPED_PATH      = '/home/kent/temp/kg-bumped-today.json';

function todayCDT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function loadJson(path, fallback) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch { return fallback; }
}

async function sendEod() {
  const today = new Date();
  const dayName  = today.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/Chicago' });
  const dateStr  = today.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/Chicago' });
  const todayStr = todayCDT();

  let message = `🌆 *KG End of Day*\n📅 ${dayName}, ${dateStr}\n\n`;

  const prospects = loadProspectsFlat();
  const bumped    = loadJson(BUMPED_PATH, []);
  const cardsData = loadJson(CARDS_PATH, { cards: [] });
  const cards     = cardsData.cards || [];

  // Wins: prospects whose last atomo_note is from today and status is a win state
  const winStatuses = ['Closed Won', 'Inspection Scheduled', 'Inspection Complete', 'Proposal Delivered'];
  const wins = prospects.filter(p => {
    if (!winStatuses.includes(p.status)) return false;
    const notes = p.atomo_notes || [];
    const lastNote = notes[notes.length - 1] || '';
    return lastNote.startsWith(todayStr);
  });

  if (wins.length > 0) {
    message += `🏆 *Wins Today (${wins.length})*\n`;
    wins.forEach(p => {
      const note = (p.atomo_notes || []).slice(-1)[0] || '';
      const snippet = note.replace(/^\d{4}-\d{2}-\d{2}: /, '').slice(0, 60);
      message += `• ${p.name} [${p.status}] — ${snippet}\n`;
    });
    message += '\n';
  } else {
    message += `🏆 *Wins Today:* None logged\n\n`;
  }

  // Bumped today
  if (bumped.length > 0) {
    message += `📋 *Bumped Today (${bumped.length})*\n`;
    bumped.forEach(b => {
      message += `• ${b.name}${b.city ? ` (${b.city})` : ''} → ${b.next_step_date || 'no date'}\n`;
    });
    message += '\n';
  }

  // Still overdue: cards with days_ago > 0 (not handled today)
  const overdue = cards.filter(c => (c.days_ago || 0) > 0);
  if (overdue.length > 0) {
    message += `⏰ *Still Overdue (${overdue.length})*\n`;
    overdue.slice(0, 6).forEach(c => {
      message += `• ${c.name} — ${c.days_ago}d | ${(c.next_step || '').slice(0, 40)}\n`;
    });
    if (overdue.length > 6) message += `_...and ${overdue.length - 6} more_\n`;
    message += '\n';
  } else {
    message += `⏰ *Overdue:* All clear\n\n`;
  }

  message += `_Run /pipeline-review to continue_`;

  await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  console.log('KG EOD review sent.');
  process.exit(0);
}

sendEod().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
