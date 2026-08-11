const fs = require('fs');
const fsp = require('fs/promises');

// Простий "мьютекс" на кожен файл: черга проміsів, щоб паралельні
// читання/записи в один і той самий JSON-файл не затирали одне одного.
const fileLocks = new Map();

function withLock(filePath, fn) {
  const prev = fileLocks.get(filePath) || Promise.resolve();
  const next = prev.then(fn, fn); // виконати fn незалежно від того, чи попередня операція впала
  fileLocks.set(filePath, next.catch(() => {})); // не даємо помилці зламати ланцюжок для наступних викликів
  return next;
}

function readJsonSync(filePath, defaultValue) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return defaultValue;
    throw err;
  }
}

async function readJson(filePath, defaultValue) {
  try {
    const raw = await fsp.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return defaultValue;
    throw err;
  }
}

async function writeJson(filePath, data) {
  return withLock(filePath, async () => {
    const tmpPath = `${filePath}.tmp`;
    await fsp.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    await fsp.rename(tmpPath, filePath); // атомарна заміна файлу
  });
}

async function appendJsonLine(filePath, obj) {
  return withLock(filePath, async () => {
    await fsp.appendFile(filePath, JSON.stringify(obj) + '\n', 'utf-8');
  });
}

async function readJsonLines(filePath) {
  try {
    const raw = await fsp.readFile(filePath, 'utf-8');
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

module.exports = {
  readJsonSync,
  readJson,
  writeJson,
  appendJsonLine,
  readJsonLines,
};
