// Звернення до локальної Ollama з таймаутом через AbortController,
// щоб бот ніколи не "завис", чекаючи на модель.
async function callOllama({ url, model, systemPrompt, userContent, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        stream: false,
        format: 'json',
      }),
    });

    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);

    const data = await res.json();
    return data.message?.content || '';
  } finally {
    clearTimeout(timeout);
  }
}

// Відповідь на одне повідомлення клієнта. Повертає { confident, answer } або null.
async function askOllama({ config, systemPrompt, userText }) {
  try {
    const raw = await callOllama({
      url: config.ollamaUrl,
      model: config.chatModel,
      systemPrompt,
      userContent: userText,
      timeoutMs: config.chatTimeoutMs,
    });

    const parsed = JSON.parse(raw);
    if (typeof parsed.confident === 'boolean' && typeof parsed.answer === 'string') {
      return parsed;
    }
    console.error('[ollama] Відповідь не за очікуваним форматом:', raw);
    return null;
  } catch (err) {
    console.error('[ollama] Помилка/таймаут запиту:', err.message);
    return null;
  }
}

// Аналіз денного логу переписки. Повертає масив [{question, answer}] або [] при помилці.
async function analyzeDailyLog({ config, logText }) {
  if (!logText || !logText.trim()) return [];

  try {
    const raw = await callOllama({
      url: config.ollamaUrl,
      model: config.analysisModel,
      systemPrompt: config.analysisSystemPrompt,
      userContent: logText,
      timeoutMs: config.analysisTimeoutMs,
    });

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.error('[ollama] Аналіз повернув не масив:', raw);
      return [];
    }
    return parsed.filter(
      (item) => item && typeof item.question === 'string' && typeof item.answer === 'string'
    );
  } catch (err) {
    console.error('[ollama] Помилка аналізу логу:', err.message);
    return [];
  }
}

module.exports = { askOllama, analyzeDailyLog };
