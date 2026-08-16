const path = require('path');
const crypto = require('crypto');
const { readJson, readJsonSync, writeJson } = require('./storage');

const FAQ_PATH = path.join(__dirname, '..', 'data', 'faq-knowledge.json');
const PENDING_PATH = path.join(__dirname, '..', 'data', 'faq-pending.json');

async function loadFaq() {
  return readJson(FAQ_PATH, []);
}

async function loadPending() {
  return readJson(PENDING_PATH, []);
}

// Синхронна версія — потрібна для формування системного промпту "на льоту"
// при кожному вхідному повідомленні без await на гарячому шляху.
function loadFaqSync() {
  return readJsonSync(FAQ_PATH, []);
}

function buildSystemPrompt(baseSystemPrompt) {
  const faq = loadFaqSync();
  if (faq.length === 0) {
    return `${baseSystemPrompt}\n\nВідомі типові питання: (поки що порожньо, відповідай confident: false на все)`;
  }
  const faqText = faq.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n');
  return `${baseSystemPrompt}\n\nВідомі типові питання:\n${faqText}`;
}

// Варіант для класифікатора: модель НЕ генерує текст відповіді сама (це призводить
// до втрати URL/форматування чи "порожніх" відповідей на складний текст) — вона лише
// визначає НОМЕР питання зі списку, яке відповідає запиту користувача. Сам текст
// відповіді код бере напряму з faq-knowledge.json, без жодної генерації.
// Повертає { systemPrompt, faqList } — faqList треба зберегти й використати той самий
// масив для пошуку відповіді за id, щоб нумерація гарантовано збігалась з тією,
// що бачила модель (навіть якщо файл зміниться між запитом і відповіддю).
function buildClassifierPrompt(baseSystemPrompt) {
  const faq = loadFaqSync();
  if (faq.length === 0) {
    return {
      systemPrompt: `${baseSystemPrompt}\n\nСписок питань: (поки що порожньо, завжди повертай {"matchedId": null})`,
      faqList: faq,
    };
  }
  const listText = faq.map((f, i) => `${i + 1}. ${f.question}`).join('\n');
  return {
    systemPrompt: `${baseSystemPrompt}\n\nСписок питань:\n${listText}`,
    faqList: faq,
  };
}

// Дуже проста перевірка на дублікат — щоб не плодити майже однакові питання
// в черзі кандидатів або в базі. Порівнює нормалізований текст питання.
function normalize(text) {
  return text.toLowerCase().trim().replace(/\s+/g, ' ');
}

function isDuplicate(question, list) {
  const norm = normalize(question);
  return list.some((item) => normalize(item.question) === norm);
}

// Додає нові кандидати в чергу, пропускаючи дублікати з уже підтвердженого FAQ
// і з уже існуючих кандидатів у черзі. Повертає масив реально доданих кандидатів.
async function addCandidates(candidates) {
  const faq = await loadFaq();
  const pending = await loadPending();

  const added = [];
  for (const candidate of candidates) {
    if (isDuplicate(candidate.question, faq)) continue;
    if (isDuplicate(candidate.question, pending)) continue;

    const entry = {
      id: crypto.randomUUID().slice(0, 8),
      question: candidate.question.trim(),
      answer: candidate.answer.trim(),
      createdAt: Date.now(),
    };
    pending.push(entry);
    added.push(entry);
  }

  if (added.length > 0) {
    await writeJson(PENDING_PATH, pending);
  }
  return added;
}

async function approveCandidate(id) {
  const pending = await loadPending();
  const idx = pending.findIndex((c) => c.id === id);
  if (idx === -1) return null;

  const [entry] = pending.splice(idx, 1);
  const faq = await loadFaq();
  faq.push({ question: entry.question, answer: entry.answer, addedAt: Date.now() });

  await writeJson(PENDING_PATH, pending);
  await writeJson(FAQ_PATH, faq);
  return entry;
}

async function rejectCandidate(id) {
  const pending = await loadPending();
  const idx = pending.findIndex((c) => c.id === id);
  if (idx === -1) return null;

  const [entry] = pending.splice(idx, 1);
  await writeJson(PENDING_PATH, pending);
  return entry;
}

module.exports = {
  loadFaq,
  loadPending,
  buildSystemPrompt,
  buildClassifierPrompt,
  addCandidates,
  approveCandidate,
  rejectCandidate,
};