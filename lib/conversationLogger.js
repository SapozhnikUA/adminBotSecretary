const path = require('path');
const { appendJsonLine, readJsonLines } = require('./storage');

const LOG_PATH = path.join(__dirname, '..', 'data', 'conversation-log.jsonl');

// Груба фільтрація явно чутливих даних перед тим, як лог піде в модель для аналізу.
// Не претендує на ідеальність — це запобіжник, а не DLP-система.
function redactSensitive(text) {
  if (!text) return text;
  return text
    // послідовності з 6+ цифр підряд (номери карток, договорів, телефонів)
    .replace(/\d[\d\s-]{5,}\d/g, '[REDACTED]')
    // email-адреси
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[REDACTED_EMAIL]');
}

async function logMessage({ chatId, peerId, role, text, timestamp }) {
  await appendJsonLine(LOG_PATH, {
    chatId,
    peerId,
    role, // 'user' | 'admin'
    text: redactSensitive(text || ''),
    timestamp,
  });
}

// Повертає записи логу за проміжок часу [fromMs, toMs)
async function getLogEntries(fromMs, toMs) {
  const entries = await readJsonLines(LOG_PATH);
  return entries.filter((e) => e.timestamp >= fromMs && e.timestamp < toMs);
}

// Форматує записи у текстовий вигляд для передачі в промпт аналізу
function formatLogForAnalysis(entries, timezone) {
  const formatter = new Intl.DateTimeFormat('uk-UA', {
    timeZone: timezone || 'Europe/Kyiv',
    hour: '2-digit',
    minute: '2-digit',
  });

  return entries
    .filter((e) => e.text && e.text.trim())
    .map((e) => {
      const time = formatter.format(new Date(e.timestamp));
      return `[${time}] [${e.role}] (peerId=${e.peerId}): ${e.text}`;
    })
    .join('\n');
}

module.exports = {
  logMessage,
  getLogEntries,
  formatLogForAnalysis,
  redactSensitive,
};
