require('dotenv').config();
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { Telegraf } = require('telegraf');

const { askOllama } = require('./lib/ollama');
const { buildSystemPrompt, loadPending, approveCandidate, rejectCandidate } = require('./lib/faq');
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
const AUTO_REPLY_ENABLED = process.env.AUTO_REPLY_ENABLED !== 'false';

if (!process.env.BOT_TOKEN) {
  console.error('BOT_TOKEN не заданий у .env');
  process.exit(1);
}
if (!ADMIN_ID) {
  console.error('ADMIN_TELEGRAM_ID не заданий у .env — команди підтвердження FAQ будуть недоступні');
}

const bot = new Telegraf(process.env.BOT_TOKEN, {
  handlerTimeout: 300_000, // 5 хвилин — щоб довгі AI-аналізи не обривались
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

// Імітація набору тексту: sendChatAction("typing") тримається на боці Telegram
// ~5 секунд, тому для довших пауз його треба надсилати повторно.
async function simulateTyping(ctx, chatId, businessConnectionId, textLength) {
  const msPerChar = 35; // приблизна "швидкість друку"
  const minDelay = 800;
  const maxDelay = 6000; // не тримати людину занадто довго
  const delay = Math.min(Math.max(textLength * msPerChar, minDelay), maxDelay);

  const extra = businessConnectionId ? { business_connection_id: businessConnectionId } : {};

  let elapsed = 0;
  while (elapsed < delay) {
    try {
      await ctx.telegram.sendChatAction(chatId, 'typing', extra);
    } catch (err) {
      console.error('Помилка sendChatAction:', err.message);
      break;
    }
    const step = Math.min(4000, delay - elapsed); // typing "живе" ~5с, оновлюємо з запасом
    await new Promise((resolve) => setTimeout(resolve, step));
    elapsed += step;
  }
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

const lastReplyMap = new Map(); // userId -> timestamp останньої заглушки-fallback

// ---- Бізнес-повідомлення (Автоматизація чатів / Secretary mode) ----

bot.on('business_message', async (ctx) => {
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

  // Автовідповідач вимкнено через .env — лог вже записано вище, просто виходимо
  if (!AUTO_REPLY_ENABLED) {
    console.log(`[disabled] Автовідповідач вимкнено, відповідь не надсилається`);
    return;
  }

  const systemPrompt = buildSystemPrompt(ollamaConfig.baseSystemPrompt);

  const aiResult = messageText
    ? await askOllama({ config: ollamaConfig, systemPrompt, userText: messageText })
    : null;

  let replyText = null;

  if (aiResult && aiResult.confident && aiResult.answer.trim()) {
    replyText = aiResult.answer.trim() + (ollamaConfig.aiDisclaimer || '');
    console.log(`[ollama] Впевнена відповідь для ${userId}`);
  } else {
    const lastReply = lastReplyMap.get(userId);
    const cooldownMs = autoReplyConfig.cooldownMs || 3600000;
    if (!lastReply || now - lastReply >= cooldownMs) {
      replyText = getAutoReplyText(autoReplyConfig);
      lastReplyMap.set(userId, now);
      console.log(`[fallback] Стандартна заглушка для ${userId}`);
    }
  }

  if (replyText) {
    try {
      await simulateTyping(ctx, chat.id, msg.business_connection_id, replyText.length);
      await ctx.telegram.sendMessage(chat.id, replyText, {
        business_connection_id: msg.business_connection_id,
      });
      // Відповідь самого бота теж варто залогувати, щоб вона враховувалась в аналізі
      await logMessage({
        chatId: chat.id,
        peerId: chat.id,
        role: 'admin',
        text: replyText,
        timestamp: Date.now(),
      });
    } catch (err) {
      console.error('Помилка відправки відповіді:', err);
    }
  }
});

// ---- Адмін-команди (звичайні повідомлення боту напряму, не бізнес-режим) ----

function isAdmin(ctx) {
  return ctx.from && ADMIN_IDS.includes(ctx.from.id);
}

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

bot.command('analyze_now', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.reply('Запускаю аналіз логу за останню добу...');
  const added = await runAnalysisGuarded('analyze_now');
  if (added === null) {
    return ctx.reply('Аналіз вже виконується у фоні, зачекай на завершення.');
  }
  if (added.length === 0) {
    return ctx.reply('Нових типових питань не знайдено.');
  }
  await ctx.reply(`Знайдено ${added.length} нових кандидатів. Перевір /pending`);
});

// ---- Щоденний cron-аналіз ----

cron.schedule(
  CRON_SCHEDULE,
  async () => {
    console.log('[cron] Запуск щоденного аналізу FAQ...');
    const added = await runAnalysisGuarded('analyze_now');
    if (added === null) {
      return ctx.reply('Аналіз вже виконується у фоні, зачекай на завершення.');
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
    'business_connection',
    'business_message',
    'edited_business_message',
    'deleted_business_messages',
  ],
});

console.log('Bot started'); //Старт бота

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
