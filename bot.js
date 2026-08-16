require('dotenv').config();
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { Telegraf, Markup } = require('telegraf');

const { classifyMessage } = require('./lib/ollama');
const { buildClassifierPrompt, loadPending, approveCandidate, rejectCandidate } = require('./lib/faq');
const { getAutoReplyText } = require('./lib/autoReply');
const { logMessage } = require('./lib/conversationLogger');
const { runDailyFaqAnalysis } = require('./cron/dailyFaqAnalysis');

const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_TELEGRAM_ID || '')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter(Boolean);
const ADMIN_ID = ADMIN_IDS[0]; // основний — куди шле сповіщення cron
const NOTIFY_ADMIN = process.env.NOTIFY_ADMIN_ON_NEW_CANDIDATES !== 'false';
const CRON_SCHEDULE = process.env.DAILY_ANALYSIS_CRON || '50 23 * * *';

if (!process.env.BOT_TOKEN) {
  console.error('BOT_TOKEN не заданий у .env');
  process.exit(1);
}
if (!ADMIN_ID) {
  console.error('ADMIN_TELEGRAM_ID не заданий у .env — команди підтвердження FAQ будуть недоступні');
}

const bot = new Telegraf(process.env.BOT_TOKEN, {
  handlerTimeout: 300_000, // 5 хвилин — щоб довгі AI-запити не обривались Telegraf'ом
});

const AUTO_REPLY_CONFIG_PATH = path.join(__dirname, 'config', 'auto-reply-config.json');
const OLLAMA_CONFIG_PATH = path.join(__dirname, 'config', 'ollama-config.json');

let autoReplyConfig = loadJson(AUTO_REPLY_CONFIG_PATH);
let ollamaConfig = loadJson(OLLAMA_CONFIG_PATH);

fs.watchFile(AUTO_REPLY_CONFIG_PATH, () => {
  try {
    autoReplyConfig = loadJson(AUTO_REPLY_CONFIG_PATH);
    console.log('auto-reply-config перезавантажено');
  } catch (err) {
    console.error('Помилка перезавантаження auto-reply-config:', err);
  }
});

fs.watchFile(OLLAMA_CONFIG_PATH, () => {
  try {
    ollamaConfig = loadJson(OLLAMA_CONFIG_PATH);
    console.log('ollama-config перезавантажено');
  } catch (err) {
    console.error('Помилка перезавантаження ollama-config:', err);
  }
});

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

// ---- Перемикачі автовідповіді (керовані з /settings, переживають pm2 restart) ----

const TOGGLES_PATH = path.join(__dirname, 'config', 'runtime-toggles.json');

function loadToggles() {
  try {
    return loadJson(TOGGLES_PATH);
  } catch (err) {
    // Файлу ще немає — стартові значення беремо з .env, далі керуємо тільки через бота
    const initial = {
      fixedEnabled: process.env.AUTO_REPLY_FIXED_ENABLED === 'true',
      llmEnabled: process.env.AUTO_REPLY_LLM_ENABLED === 'true',
    };
    fs.writeFileSync(TOGGLES_PATH, JSON.stringify(initial, null, 2), 'utf-8');
    return initial;
  }
}

const toggles = loadToggles();

function saveToggles() {
  fs.writeFileSync(TOGGLES_PATH, JSON.stringify(toggles, null, 2), 'utf-8');
}

function settingsText() {
  return (
    `⚙️ <b>Налаштування автовідповіді</b>\n\n` +
    `${toggles.fixedEnabled ? '🟢' : '🔴'} Фіксована заглушка: <b>${toggles.fixedEnabled ? 'увімкнена' : 'вимкнена'}</b>\n` +
    `${toggles.llmEnabled ? '🟢' : '🔴'} AI-відповіді (FAQ): <b>${toggles.llmEnabled ? 'увімкнені' : 'вимкнені'}</b>\n\n` +
    `Натисни кнопку, щоб перемкнути:`
  );
}

function settingsKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        `${toggles.fixedEnabled ? '🔴 Вимкнути' : '🟢 Увімкнути'} фіксовану заглушку`,
        'toggle_fixed'
      ),
    ],
    [
      Markup.button.callback(
        `${toggles.llmEnabled ? '🔴 Вимкнути' : '🟢 Увімкнути'} AI-відповіді`,
        'toggle_llm'
      ),
    ],
  ]);
}

let analysisInProgress = false;

async function runAnalysisGuarded(label) {
  if (analysisInProgress) {
    console.log(`[${label}] Аналіз вже виконується, пропускаю паралельний запуск`);
    return null;
  }
  analysisInProgress = true;
  try {
    return await runDailyFaqAnalysis({ ollamaConfig, timezone: autoReplyConfig.timezone });
  } finally {
    analysisInProgress = false;
  }
}

// Глобальна черга звернень до Ollama. Ollama на CPU обробляє генерацію
// послідовно, тому кілька паралельних запитів лише сповільнюють одне одного
// і призводять до таймаутів. Ця черга гарантує, що в кожен момент часу
// до Ollama йде не більше одного chat-запиту — решта чекають своєї черги тут,
// на боці Node.js, де це видно й контрольовано, а не мовчки всередині Ollama.
let ollamaQueue = Promise.resolve();
function queueOllamaCall(fn) {
  const run = ollamaQueue.then(fn, fn);
  ollamaQueue = run.catch(() => {}); // помилка одного запиту не має ламати чергу для наступних
  return run;
}

// Захист від дублів: якщо від того самого користувача вже обробляється
// повідомлення (він написав кілька разів поспіль, не дочекавшись відповіді),
// нові повідомлення не запускають додаткові паралельні AI-запити.
const inFlightUsers = new Set();

const lastReplyMap = new Map(); // userId -> timestamp останньої заглушки-fallback

// ---- Бізнес-повідомлення (Автоматизація чатів / Secretary mode) ----

// ВАЖЛИВО: обробник НЕ await'иться тут — Telegraf у режимі polling чекає завершення
// обробника поточного апдейту, перш ніж забрати наступний. Якщо чекати тут (await),
// довгий AI-запит (до 45с) блокує весь бот: кнопки в /settings, інші команди й
// повідомлення просто не дійдуть вчасно (Telegram визнає їх "застарілими").
// Тому запускаємо обробку у фоні ("fire-and-forget"), а Telegraf одразу йде за
// наступним апдейтом.
bot.on('business_message', (ctx) => {
  handleBusinessMessage(ctx).catch((err) => {
    console.error('[business_message] Необроблена помилка:', err);
  });
});

async function handleBusinessMessage(ctx) {
  const msg = ctx.update.business_message;
  const chat = msg.chat;
  const from = msg.from;

  if (chat.type !== 'private') return;

  const messageText = msg.text || '';
  const isFromAdmin = ADMIN_IDS.includes(from.id);
  const now = Date.now();

  // Логуємо обидва напрямки — і клієнта, і адміна (щоб бачити пари питання/відповідь)
  await logMessage({
    chatId: chat.id,
    peerId: chat.id, // ідентифікатор співрозмовника-клієнта (він же chat.id в приваті)
    role: isFromAdmin ? 'admin' : 'user',
    text: messageText,
    timestamp: now,
  });

  // На повідомлення від самого адміна (він пише клієнту зі свого телефону) бот не відповідає
  if (isFromAdmin) return;

  const userId = from.id;
  console.log(`[business] Повідомлення від ${userId}: "${messageText}"`);

  // Жоден з каналів автовідповіді не активний — просто логуємо (вже зроблено вище) і виходимо
  if (!toggles.fixedEnabled && !toggles.llmEnabled) {
    console.log(`[disabled] Обидва автовідповідачі вимкнено, лише логування`);
    return;
  }

  // Користувач уже написав раніше і те повідомлення ще обробляється (AI не відповіла) —
  // не запускаємо другий паралельний запит до Ollama, просто ігноруємо дубль.
  if (inFlightUsers.has(userId)) {
    console.log(`[skip] Повідомлення від ${userId} вже обробляється, пропускаю дубль`);
    return;
  }
  inFlightUsers.add(userId);

  try {
    // Допоміжна функція відправки одного повідомлення-відповіді + його логування
    const sendReply = async (text, sourceLabel) => {
      try {
        await ctx.telegram.sendMessage(chat.id, text, {
          business_connection_id: msg.business_connection_id,
          parse_mode: 'HTML',
        });
        await logMessage({
          chatId: chat.id,
          peerId: chat.id,
          role: 'admin',
          text,
          timestamp: Date.now(),
        });
        console.log(`[${sourceLabel}] Відповідь надіслана для ${userId}`);
      } catch (err) {
        console.error(`Помилка відправки відповіді (${sourceLabel}):`, err);
      }
    };

    // ---- Канал 1: фіксована заглушка за годиною — миттєво, з cooldown ----
    if (toggles.fixedEnabled) {
      const lastReply = lastReplyMap.get(userId);
      const cooldownMs = autoReplyConfig.cooldownMs || 3600000;
      if (!lastReply || now - lastReply >= cooldownMs) {
        lastReplyMap.set(userId, now);
        await sendReply(getAutoReplyText(autoReplyConfig), 'fixed');
      } else {
        console.log(`[cooldown] Заглушку для ${userId} пропущено (ще діє cooldown)`);
      }
    }

    // ---- Канал 2: AI-класифікатор (FAQ) — з затримкою (думає), без cooldown ----
    if (toggles.llmEnabled && messageText) {
      const { systemPrompt, faqList } = buildClassifierPrompt(ollamaConfig.baseSystemPrompt);

      const startedAt = Date.now();
      const matchedId = await queueOllamaCall(() =>
        classifyMessage({ config: ollamaConfig, systemPrompt, userText: messageText })
      );
      console.log(`[ollama] Запит для ${userId} зайняв ${Date.now() - startedAt}мс, matchedId=${matchedId}`);

      // matchedId — це номер (1-based) зі списку, показаного моделі. Текст відповіді
      // береться напряму з faqList, без жодної генерації — так URL/форматування
      // не можуть бути спотворені чи "загублені" моделлю.
      const matchedEntry =
        Number.isInteger(matchedId) && matchedId >= 1 && matchedId <= faqList.length
          ? faqList[matchedId - 1]
          : null;

      if (matchedEntry) {
        console.log(`[ollama] Знайдено відповідність FAQ #${matchedId} для ${userId}: "${matchedEntry.question}"`);
        await sendReply(matchedEntry.answer.trim() + (ollamaConfig.aiDisclaimer || ''), 'ollama');
      } else {
        console.log(`[ollama] Збігу з FAQ не знайдено для ${userId}`);
      }
    }
  } finally {
    inFlightUsers.delete(userId);
  }
}

// ---- Адмін-команди (звичайні повідомлення боту напряму, не бізнес-режим) ----

function isAdmin(ctx) {
  return ctx.from && ADMIN_IDS.includes(ctx.from.id);
}

bot.command('settings', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.reply(settingsText(), { parse_mode: 'HTML', ...settingsKeyboard() });
});

bot.action('toggle_fixed', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery();
  toggles.fixedEnabled = !toggles.fixedEnabled;
  saveToggles();
  console.log(`[settings] Фіксована заглушка ${toggles.fixedEnabled ? 'увімкнена' : 'вимкнена'} через /settings`);
  await ctx.answerCbQuery(toggles.fixedEnabled ? 'Увімкнено' : 'Вимкнено');
  await ctx.editMessageText(settingsText(), { parse_mode: 'HTML', ...settingsKeyboard() });
});

bot.action('toggle_llm', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery();
  toggles.llmEnabled = !toggles.llmEnabled;
  saveToggles();
  console.log(`[settings] AI-відповіді ${toggles.llmEnabled ? 'увімкнені' : 'вимкнені'} через /settings`);
  await ctx.answerCbQuery(toggles.llmEnabled ? 'Увімкнено' : 'Вимкнено');
  await ctx.editMessageText(settingsText(), { parse_mode: 'HTML', ...settingsKeyboard() });
});

bot.command('pending', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const pending = await loadPending();
  if (pending.length === 0) {
    return ctx.reply('Кандидатів у чергу немає.');
  }
  for (const c of pending) {
    await ctx.reply(
      `❓ ${c.question}\n💬 ${c.answer}\n\n/approve_${c.id} — додати в FAQ\n/reject_${c.id} — відхилити`
    );
  }
});

bot.hears(/^\/approve_([a-f0-9]{8})$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  const id = ctx.match[1];
  const entry = await approveCandidate(id);
  if (entry) {
    await ctx.reply(`✅ Додано в FAQ: "${entry.question}"`);
  } else {
    await ctx.reply('Кандидата з таким ID не знайдено (можливо, вже оброблено).');
  }
});

bot.hears(/^\/reject_([a-f0-9]{8})$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  const id = ctx.match[1];
  const entry = await rejectCandidate(id);
  if (entry) {
    await ctx.reply(`🗑 Відхилено: "${entry.question}"`);
  } else {
    await ctx.reply('Кандидата з таким ID не знайдено (можливо, вже оброблено).');
  }
});

// Так само як для business_message: не await'имо аналіз всередині обробника
// команди, щоб довгий AI-аналіз (до кількох хвилин) не блокував Telegraf
// від забору наступних апдейтів (кнопки, інші команди).
bot.command('analyze_now', (ctx) => {
  if (!isAdmin(ctx)) return;
  ctx.reply('Запускаю аналіз логу за останню добу...').catch(() => {});

  (async () => {
    const added = await runAnalysisGuarded('analyze_now');
    if (added === null) {
      return ctx.reply('Аналіз вже виконується у фоні, зачекай на завершення.');
    }
    if (added.length === 0) {
      return ctx.reply('Нових типових питань не знайдено.');
    }
    await ctx.reply(`Знайдено ${added.length} нових кандидатів. Перевір /pending`);
  })().catch((err) => console.error('[analyze_now] Необроблена помилка:', err));
});

// ---- Щоденний cron-аналіз ----

cron.schedule(
  CRON_SCHEDULE,
  async () => {
    console.log('[cron] Запуск щоденного аналізу FAQ...');
    const added = await runAnalysisGuarded('cron');
    if (added === null) {
      // Аналіз вже виконувався паралельно (наприклад, через /analyze_now) — просто пропускаємо
      return;
    }
    if (added.length > 0 && NOTIFY_ADMIN && ADMIN_ID) {
      try {
        await bot.telegram.sendMessage(
          ADMIN_ID,
          `🔔 Знайдено ${added.length} нових типових питань за добу. Перевір /pending`
        );
      } catch (err) {
        console.error('Не вдалось сповістити адміна:', err);
      }
    }
  },
  { timezone: 'Europe/Kyiv' }
);

// ---- Запуск ----

bot.launch({
  allowedUpdates: [
    'message',
    'callback_query',
    'business_connection',
    'business_message',
    'edited_business_message',
    'deleted_business_messages',
  ],
});

console.log('Bot started'); //Старт бота

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));