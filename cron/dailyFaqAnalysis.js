const { getLogEntries, formatLogForAnalysis } = require('../lib/conversationLogger');
const { analyzeDailyLog } = require('../lib/ollama');
const { addCandidates } = require('../lib/faq');

// Аналізує лог за попередню добу (або за вказаний проміжок) і повертає
// список реально доданих нових кандидатів (дублікати вже відфільтровані).
async function runDailyFaqAnalysis({ ollamaConfig, timezone, fromMs, toMs }) {
  const now = Date.now();
  const rangeTo = toMs ?? now;
  const rangeFrom = fromMs ?? rangeTo - 24 * 60 * 60 * 1000;

  const entries = await getLogEntries(rangeFrom, rangeTo);
  const logText = formatLogForAnalysis(entries, timezone);

  if (!logText.trim()) {
    console.log('[daily-analysis] Лог за період порожній, аналіз пропущено');
    return [];
  }

  console.log(`[daily-analysis] Аналізую ${entries.length} повідомлень...`);
  const candidates = await analyzeDailyLog({ config: ollamaConfig, logText });

  if (candidates.length === 0) {
    console.log('[daily-analysis] Типових питань не знайдено');
    return [];
  }

  const added = await addCandidates(candidates);
  console.log(`[daily-analysis] Додано ${added.length} нових кандидатів у чергу (з ${candidates.length} знайдених)`);
  return added;
}

module.exports = { runDailyFaqAnalysis };
