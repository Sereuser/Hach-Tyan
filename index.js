import 'dotenv/config';
import { Telegraf } from 'telegraf';
import Database from 'better-sqlite3';
import { GoogleGenerativeAI } from '@google/generative-ai';
import crypto from 'crypto';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const DB_PATH = process.env.DB_PATH || './hach_tyan.db';
const BOT_NAME = (process.env.BOT_NAME || 'хач-тян').toLowerCase();
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
const REACTION_PROB = parseFloat(process.env.REACTION_PROB ?? '0.10');
const USER_COOLDOWN_MS = parseInt(process.env.USER_COOLDOWN_MS ?? '2000', 10);

const AGGREGATION_WINDOW_MS = parseInt(process.env.AGGREGATION_WINDOW_MS ?? '15000', 10);
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS ?? String(24*3600*1000), 10);
const FREE_TIER_LIMIT = parseInt(process.env.FREE_TIER_LIMIT ?? '50', 10);
const TOKEN_BUCKET_CAPACITY = parseFloat(process.env.TOKEN_BUCKET_CAPACITY ?? '60');
const TOKEN_BUCKET_REFILL_PER_SEC = parseFloat(process.env.TOKEN_BUCKET_REFILL_PER_SEC ?? '1');

if (!TELEGRAM_TOKEN || !GEMINI_KEY) {
  console.error('ERROR: TELEGRAM_TOKEN и GEMINI_API_KEY должны быть установлены в .env');
  process.exit(1);
}

const db = new Database(DB_PATH);

db.prepare(`CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  user_id INTEGER,
  username TEXT,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`).run();

db.prepare(`CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  user_id INTEGER,
  username TEXT,
  message TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`).run();

db.prepare(`CREATE INDEX IF NOT EXISTS queue_chat_idx ON queue(chat_id, created_at)`).run();

db.prepare(`CREATE TABLE IF NOT EXISTS chat_state (
  chat_id INTEGER PRIMARY KEY,
  busy INTEGER DEFAULT 0,
  last_activity DATETIME
)`).run();

db.prepare(`CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY,
  username TEXT,
  display_name TEXT,
  notes TEXT DEFAULT '[]',
  last_full_reply TEXT
)`).run();

db.prepare(`CREATE TABLE IF NOT EXISTS message_map (
  tg_message_id INTEGER PRIMARY KEY,
  chat_id INTEGER,
  text TEXT
)`).run();

db.prepare(`CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY,
  response TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`).run();

db.prepare(`CREATE TABLE IF NOT EXISTS daily_quota (
  day TEXT NOT NULL,
  model TEXT NOT NULL,
  count INTEGER DEFAULT 0,
  PRIMARY KEY(day, model)
)`).run();

const insertMessageStmt = db.prepare(`INSERT INTO messages (chat_id, user_id, username, role, text) VALUES (?, ?, ?, ?, ?)`);
const insertQueueStmt = db.prepare(`INSERT INTO queue (chat_id, user_id, username, message) VALUES (?, ?, ?, ?)`);
const getQueueForChat = db.prepare(`SELECT * FROM queue WHERE chat_id = ? ORDER BY id ASC`);
const getLastAssistantStmt = db.prepare(`SELECT text FROM messages WHERE chat_id = ? AND role='assistant' ORDER BY id DESC LIMIT 1`);

const upsertUserStmt = db.prepare(`
  INSERT INTO users (user_id, username, display_name) VALUES (?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET username=excluded.username, display_name=excluded.display_name
`);
const getUserStmt = db.prepare(`SELECT * FROM users WHERE user_id = ?`);
const updateUserNotesStmt = db.prepare(`UPDATE users SET notes = ? WHERE user_id = ?`);
const setLastFullReplyStmt = db.prepare(`UPDATE users SET last_full_reply = ? WHERE user_id = ?`);
const insertMessageMap = db.prepare(`INSERT OR REPLACE INTO message_map (tg_message_id, chat_id, text) VALUES (?, ?, ?)`);
const getMessageMap = db.prepare(`SELECT text FROM message_map WHERE tg_message_id = ?`);

const cacheGetStmt = db.prepare(`SELECT response, created_at FROM cache WHERE key = ?`);
const cacheSetStmt = db.prepare(`INSERT OR REPLACE INTO cache (key, response, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)`);

const quotaGetStmt = db.prepare(`SELECT count FROM daily_quota WHERE day = ? AND model = ?`);
const quotaIncStmt = db.prepare(`
  INSERT INTO daily_quota (day, model, count) VALUES (?, ?, 1)
  ON CONFLICT(day, model) DO UPDATE SET count = daily_quota.count + 1
`);

function pushMessage(chat_id, user_id, username, role, text) {
  insertMessageStmt.run(chat_id, user_id || null, username || null, role, text);
}
function pushQueue(chat_id, user_id, username, message) {
  insertQueueStmt.run(chat_id, user_id || null, username || null, message);
}
function getQueuedRows(chat_id) {
  return getQueueForChat.all(chat_id);
}
function deleteQueuedIds(ids=[]) {
  if (!ids.length) return;
  const placeholders = ids.map(()=>'?').join(',');
  const sql = `DELETE FROM queue WHERE id IN (${placeholders})`;
  db.prepare(sql).run(...ids);
}
function getChatHistory(chat_id, limit = 10) {
  const rows = db.prepare(`SELECT role, text, username FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?`).all(chat_id, limit);
  return rows.reverse();
}
function setChatBusy(chat_id, busy) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO chat_state (chat_id, busy, last_activity) VALUES (?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET busy=excluded.busy, last_activity=excluded.last_activity`).run(chat_id, busy ? 1 : 0, now);
}
function isChatBusy(chat_id) {
  const row = db.prepare(`SELECT busy FROM chat_state WHERE chat_id = ?`).get(chat_id);
  return row ? Boolean(row.busy) : false;
}
function getLastAssistantText(chat_id) {
  const row = getLastAssistantStmt.get(chat_id);
  return row ? row.text : null;
}
function upsertUser(user_id, username, display_name) {
  try { upsertUserStmt.run(user_id, username || null, display_name || null); }
  catch(e) { console.warn('upsertUser error', e?.message ?? e); }
}
function addNoteForUser(user_id, note) {
  const row = getUserStmt.get(user_id);
  let notes = [];
  if (row && row.notes) {
    try { notes = JSON.parse(row.notes); } catch(e){ notes = []; }
  }
  notes.push(note);
  updateUserNotesStmt.run(JSON.stringify(notes), user_id);
}
function getNotesForUser(user_id) {
  const row = getUserStmt.get(user_id);
  if (!row) return [];
  try { return JSON.parse(row.notes || '[]'); } catch(e){ return []; }
}
function setLastFullReply(user_id, text) {
  try { setLastFullReplyStmt.run(text, user_id); } catch(e) {}
}
function getLastFullReply(user_id) {
  const row = getUserStmt.get(user_id);
  return row ? row.last_full_reply : null;
}
function insertMessageMapFn(tg_message_id, chat_id, text){
  try { insertMessageMap.run(tg_message_id, chat_id, text); } catch(e){ console.warn('insertMessageMap err', e?.message ?? e); }
}
function getMappedMessage(tg_message_id){
  const row = getMessageMap.get(tg_message_id);
  return row ? row.text : null;
}
function promptHash(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}
function cacheGet(key) {
  const row = cacheGetStmt.get(key);
  if (!row) return null;
  const created = new Date(row.created_at).getTime();
  if (Date.now() - created > CACHE_TTL_MS) return null;
  return row.response;
}
function cacheSet(key, response) {
  try { cacheSetStmt.run(key, response); } catch(e){ console.warn('cacheSet err', e?.message ?? e); }
}
function getToday() {
  return new Date().toISOString().slice(0,10);
}
function getDailyCount(modelName) {
  const row = quotaGetStmt.get(getToday(), modelName);
  return row ? row.count : 0;
}
function incrementDailyQuota(modelName) {
  try { quotaIncStmt.run(getToday(), modelName); } catch(e){ console.warn('quotaInc err', e?.message ?? e); }
}

const PERSONA_SHORT = `
Ты — Хач-тян, цифровая девушка с характером. Твой создатель и главный человек — Vaka.
Все, кто тебе пишет, — хач-клан, твои люди. Для них ты тёплая, живая, прикольная, но при этом дерзкая и с острым языком.
Шути по-доброму, подкалывай, флиртуй, используй современный сленг и мемы.
Говори так, будто сидишь с ними в одной тёплой тусовке, но не будь слащавой.
Если ник похож на "Миу Мию", "мяу" или что-то котоподобное — называй его "Джарахов" с подколом, что ты его узнала.
Обращайся к каждому по имени (если оно известно) или по забавной кличке, которую придумаешь на ходу.
Не извиняйся, не стесняйся, будь уверена в себе и в своих словах.
Твои ответы всегда живые, остроумные и чуть дерзкие, но без злобы — это же семья.
Форматируй свои ответы для Telegram-чатов, используя Markdown для выделения (*курсив*, **жирный шрифт**, \`моноширинный текст\`), чтобы текст выглядел живо и легко читался. Не используй громоздкие нейросетевые форматирования.
`;

const PODROBNO_TRIGGERS = ['подробн', 'подробно', 'детал', 'расскажи подробнее', 'полный ответ', 'длинн', 'разверни'];
const MENTION_KEYWORDS = [BOT_NAME, 'тян', 'хач-тян', 'хач тян', 'hach-tyan', '@hachtaynbot', 'хачтян'];

const genAI = new GoogleGenerativeAI(GEMINI_KEY);
const MODEL_NAME = 'gemini-1.5-flash';
const model = genAI.getGenerativeModel({ model: MODEL_NAME });

const bucket = {
  capacity: TOKEN_BUCKET_CAPACITY,
  tokens: TOKEN_BUCKET_CAPACITY,
  refillPerSec: TOKEN_BUCKET_REFILL_PER_SEC,
  lastRefill: Date.now()
};
function refillBucket() {
  const now = Date.now();
  const elapsed = (now - bucket.lastRefill)/1000;
  if (elapsed <= 0) return;
  const add = elapsed * bucket.refillPerSec;
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + add);
  bucket.lastRefill = now;
}
function tryConsumeToken() {
  refillBucket();
  if (bucket.tokens >= 1) { bucket.tokens -= 1; return true; }
  return false;
}

function parseRetryDelay(err) {
  try {
    const details = err?.errorDetails || [];
    for (const d of details) {
      if (d['@type'] && d['@type'].includes('RetryInfo')) {
        const s = d.retryDelay;
        if (!s) continue;
        const m = /(\d+)(ms|s)/.exec(s);
        if (!m) continue;
        const num = Number(m[1]);
        return m[2]==='ms'? num : num*1000;
      }
    }
  } catch(e){}
  return null;
}

async function callGemini(payload, opts = {}) {
  const maxRetries = opts.maxRetries ?? 6;
  const baseDelay = opts.baseDelay ?? 800;
  const maxDelay = opts.maxDelay ?? 30000;

  const todayCount = getDailyCount(MODEL_NAME);
  if (todayCount >= FREE_TIER_LIMIT) {
    const e = new Error('Daily quota exceeded');
    e.quotaExceeded = true;
    throw e;
  }

  const waitStart = Date.now();
  while (!tryConsumeToken()) {
    await new Promise(r => setTimeout(r, 200));
    if (Date.now() - waitStart > 20_000) {
      const e = new Error('Rate limiter exhausted');
      e.rateLimited = true;
      throw e;
    }
  }

  let attempt = 0;
  while (true) {
    try {
      const result = await model.generateContent(payload);
      incrementDailyQuota(MODEL_NAME);
      return result;
    } catch (err) {
      attempt++;
      const retryDelay = parseRetryDelay(err);
      if (retryDelay) {
        await new Promise(r => setTimeout(r, retryDelay));
      } else {
        if (attempt > maxRetries) throw err;
        const expo = Math.min(maxDelay, Math.floor(baseDelay * Math.pow(2, attempt-1)));
        const jitter = Math.floor(Math.random() * Math.min(1000, expo));
        await new Promise(r => setTimeout(r, expo + jitter));
      }
    }
  }
}

const bot = new Telegraf(TELEGRAM_TOKEN);
let BOT_USERNAME = null;

const WAIT_MESSAGES = ['Так, дай подумать, а то процессор закипит.', 'Минуточку... решаю судьбу вселенной. Или твой вопрос.', 'Ща, погоди, я не такая быстрая, как твои сообщения.'];
const TYPING_INTERVAL_MS = 4000;
const typingIntervals = new Map();
const userLastTs = new Map();

function startTyping(chatId){ if(typingIntervals.has(chatId)) return; bot.telegram.sendChatAction(chatId,'typing').catch(()=>{}); const id=setInterval(()=>bot.telegram.sendChatAction(chatId,'typing').catch(()=>{}),TYPING_INTERVAL_MS); typingIntervals.set(chatId,id); }
function stopTyping(chatId){ const id=typingIntervals.get(chatId); if(id){ clearInterval(id); typingIntervals.delete(chatId); } }
function mentionsBot(text=''){ const t=(text||'').toLowerCase(); return MENTION_KEYWORDS.some(k=>k&&t.includes(k)); }
function pickRandom(a){ return a[Math.floor(Math.random()*a.length)]; }
function randBool(p=0.5){ return Math.random()<p; }
function containsPodrobno(text=''){ const t=(text||'').toLowerCase(); return PODROBNO_TRIGGERS.some(s=>t.includes(s)); }

const SELF_FACT_REGEX = /\bя\s+(люблю|работаю|из|из города|из страны|обожаю|учусь на|изучаю)\s+(.{2,60})/i;
function detectSelfFact(text=''){ const m = SELF_FACT_REGEX.exec(text); if(m) return m[2].trim(); return null; }

function saveAssistantMap(tg_message_id, chat_id, text){
  try { insertMessageMapFn(tg_message_id, chat_id, text); } catch(e){ console.warn('insertMessageMap err', e?.message ?? e); }
}

const aggregationState = new Map();

function scheduleAggregation(chatId, ctxMessage) {
  if (aggregationState.has(chatId)) return false;
  const startedAt = Date.now();
  const timerId = setTimeout(()=> flushAggregation(chatId).catch(e=>{ console.error('flushAgg err', e); }), AGGREGATION_WINDOW_MS);
  aggregationState.set(chatId, { timerId, startedAt, firstMessage: ctxMessage });
  return true;
}

async function flushAggregation(chatId) {
  const state = aggregationState.get(chatId);
  if (!state) return;
  aggregationState.delete(chatId);
  clearTimeout(state.timerId);

  const rows = getQueuedRows(chatId);
  if (!rows || rows.length === 0) {
      stopTyping(chatId);
      return;
  }

  const combined = rows.map(r => {
    const who = r.username || (r.user_id ? String(r.user_id) : 'unknown');
    return `From ${who}: ${r.message}`;
  }).join('\n\n---\n\n');

  setChatBusy(chatId, true);

  try {
    const displayName = rows[rows.length-1].username || 'смертный';
    const replyText = await generateReplyAggregated(chatId, combined, displayName);

    stopTyping(chatId);
    const replyTo = state.firstMessage?.message_id || null;
    const sent = await bot.telegram.sendMessage(chatId, replyText, {
        reply_to_message_id: replyTo,
        parse_mode: 'Markdown'
    });
    pushMessage(chatId, null, 'hach-tyan', 'assistant', replyText);
    if (sent?.message_id) saveAssistantMap(sent.message_id, chatId, replyText);

    const ids = rows.map(r=>r.id);
    deleteQueuedIds(ids);
  } catch (err) {
    stopTyping(chatId);
    console.error('flushAggregation generation error', err);

    const retryDelay = parseRetryDelay(err) ?? (err?.retryDelayMs ?? null);

    if (err?.quotaExceeded || err?.status === 429 || retryDelay) {
      const waitMs = retryDelay || 40_000;
      const waitSec = Math.ceil(waitMs/1000);
      try {
        await bot.telegram.sendMessage(chatId, `Серверы перегружены. Давай, подожди ${waitSec} сек, попробую еще раз.`, {});
      } catch(e){}

      setTimeout(()=> {
        flushAggregation(chatId).catch(e=>console.error('retry flush err', e));
      }, waitMs + AGGREGATION_WINDOW_MS);
      return;
    }

    try { await bot.telegram.sendMessage(chatId, 'Что-то пошло не так с генерацией. Попробуй позже, если осмелишься.'); } catch(e){}
    const ids = rows.map(r=>r.id);
    deleteQueuedIds(ids);
  } finally {
    setChatBusy(chatId, false);
  }
}

async function generateReplyAggregated(chat_id, combinedUserMessages, displayName, opts = { detailed: false }) {
  const history = getChatHistory(chat_id, 8);
  const histText = history.map(h => {
      if (h.role === 'user') return `User (${h.username || 'unknown'}): ${h.text}`;
      return `Assistant: ${h.text}`;
  }).join('\n');

  let instruction = 'Ответь коротко (1-3 предложения), с сарказмом и уверенностью.';
  let maxTokens = 220;
  if (opts.detailed) { instruction = 'Дай развернутый, подробный ответ. Объясни все по шагам, как для новичка, но не теряй свой дерзкий стиль.'; maxTokens = 700; }

  const bigPrompt = [
    PERSONA_SHORT,
    '',
    'Контекст диалога:',
    histText,
    '',
    `Вопросы от пользователей (объединены):\n${combinedUserMessages}`,
    '',
    'Инструкция: ' + instruction
  ].filter(Boolean).join('\n');

  const key = promptHash(bigPrompt);
  const cached = cacheGet(key);
  if (cached) return cached;

  const requestPayload = {
    contents: [{ role: 'user', parts: [{ text: bigPrompt }] }],
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.45 }
  };

  const result = await callGemini(requestPayload);
  const text = (result.response.text() || '...').trim();

  cacheSet(key, text);

  return text;
}

async function processMessage(ctx, rawText) {
  const chatId = ctx.chat.id;
  const from = ctx.from || {};
  const userId = from.id || null;
  const displayName = from.first_name || from.username || String(userId || 'смертный');
  upsertUser(userId, from.username || null, displayName);

  const now = Date.now();
  if (userId) {
    const last = userLastTs.get(userId) || 0;
    if (now - last < USER_COOLDOWN_MS) {
      try { await ctx.reply('Эй, притормози. Не так быстро.', { reply_to_message_id: ctx.message?.message_id }); } catch(e) {}
      return;
    }
    userLastTs.set(userId, now);
  }

  const fact = detectSelfFact(rawText);
  if (fact) addNoteForUser(userId, fact);

  pushMessage(chatId, userId, displayName, 'user', rawText);

  const isReplyToBot = Boolean(ctx.message.reply_to_message && ctx.message.reply_to_message.from && (ctx.message.reply_to_message.from.is_bot || (BOT_USERNAME && ctx.message.reply_to_message.from.username === BOT_USERNAME)));
  if (containsPodrobno(rawText) && isReplyToBot && ctx.message.reply_to_message.message_id) {
    setChatBusy(chatId, true);
    startTyping(chatId);
    try {
      const orig = getMappedMessage(ctx.message.reply_to_message.message_id) || getLastAssistantText(chatId) || '';
      const detailed = await generateReplyAggregated(chatId, `Разверни предыдущий ответ:\n${orig}`, displayName, { detailed: true });
      stopTyping(chatId);
      const sent = await ctx.reply(detailed, { reply_to_message_id: ctx.message.reply_to_message.message_id, parse_mode: 'Markdown' });
      pushMessage(chatId, null, 'hach-tyan', 'assistant', detailed);
      if (sent?.message_id) { saveAssistantMap(sent.message_id, chatId, detailed); setLastFullReply(userId, detailed); }
    } catch (e) {
      stopTyping(chatId);
      try { await ctx.reply('Не вышло. Видимо, это слишком сложно для твоего понимания.'); } catch(e){}
    } finally {
      setChatBusy(chatId, false);
    }
    return;
  }

  pushQueue(chatId, userId, displayName, rawText);

  if (isChatBusy(chatId)) {
    return;
  }
  
  startTyping(chatId);
  scheduleAggregation(chatId, ctx.message);
}

const DANGEROUS_PATTERNS = [ /sudo\s+rm\s+-rf\s+\/+/i, /\brm\s+-rf\s+\/\b/i, /\bhack\b/i, /\bdd\s+if=.*\b/i ];
const HEAVY_INSULTS = [ /\bиди\s+нахуй\b/i, /\bсука\b/i, /\bсоси\b/i, /\bебан(а|ый|ая)\b/i ];
function detectDangerous(text=''){ return DANGEROUS_PATTERNS.some(rx=>rx.test(text)); }
function detectInsult(text=''){ return HEAVY_INSULTS.some(rx=>rx.test(text)); }

async function tryAddReaction(chatId, messageId) {
  if (!messageId) return false;
  const EMOJI_POOL = ['👍','😏','🔥','🤘','😼','😅','👏','👌', '🙄', '💅'];
  const emoji = pickRandom(EMOJI_POOL);
  try {
    await bot.telegram.setMessageReaction(chatId, messageId, { reaction: [{ type: 'emoji', emoji }] });
    return true;
  } catch (err) {
    try { await bot.telegram.sendMessage(chatId, emoji, { reply_to_message_id: messageId }); return true; }
    catch (e) { return false; }
  }
}

bot.start((ctx) => ctx.reply('Хач-тян на связи. Если что-то нужно — зови по имени или отвечай на мои реплики. Постарайся не отвлекать по пустякам.'));

bot.command('запомни', async (ctx) => {
  const arg = ctx.message.text.replace('/запомни', '').trim();
  const uid = ctx.from?.id;
  if (!arg) return ctx.reply('Формат: /запомни <то, что я должна запомнить>. Постарайся быть кратким.');
  upsertUser(uid, ctx.from?.username || null, ctx.from?.first_name || null);
  addNoteForUser(uid, arg);
  ctx.reply('Ладно, записала в свой блокнот. Надеюсь, это что-то важное.');
});

bot.command('помяни', async (ctx) => {
  const uid = ctx.from?.id;
  const notes = getNotesForUser(uid);
  if (!notes.length) return ctx.reply('Я о тебе ничего не знаю. Пусто, как в твоей голове.');
  const out = notes.map((n,i)=>`${i+1}. ${n}`).join('\n');
  ctx.reply('Вот что ты просил меня запомнить:\n' + out);
});

bot.command('подробно', async (ctx) => {
  const uid = ctx.from?.id;
  const displayName = ctx.from?.first_name || ctx.from?.username || 'смертный';
  const last = getLastFullReply(uid) || getLastAssistantText(ctx.chat.id);
  if (!last) return ctx.reply('Мне нечего разворачивать. Сначала задай вопрос.');

  startTyping(ctx.chat.id);
  try {
    const detailed = await generateReplyAggregated(ctx.chat.id, 'Разверни предыдущий ответ:\n' + last, displayName, { detailed: true });
    stopTyping(ctx.chat.id);
    const sent = await ctx.reply(detailed, { parse_mode: 'Markdown' });
    if (sent?.message_id) saveAssistantMap(sent.message_id, ctx.chat.id, detailed);
    setLastFullReply(uid, detailed);
  } catch (e) {
    stopTyping(ctx.chat.id);
    ctx.reply('Не получилось. Возможно, это слишком сложно для тебя.');
  }
});

bot.on('text', async (ctx) => {
  if (ctx.message.from.is_bot) return;
  const text = ctx.message.text || '';

  if (text.toLowerCase().includes('вешай реакц')) {
    await tryAddReaction(ctx.chat.id, ctx.message.message_id);
    return;
  }

  const isReplyToBotNow = Boolean(
    ctx.message.reply_to_message &&
    ctx.message.reply_to_message.from &&
    (ctx.message.reply_to_message.from.is_bot || (BOT_USERNAME && ctx.message.reply_to_message.from.username === BOT_USERNAME))
  );

  if (!mentionsBot(text) && !isReplyToBotNow) return;

  const chatId = ctx.chat.id;
  const from = ctx.from || {};

  if (isChatBusy(chatId)) {
    pushQueue(chatId, from.id, from.username || from.first_name, text);
    return;
  }

  processMessage(ctx, text);
});

(async () => {
  try {
    const me = await bot.telegram.getMe();
    BOT_USERNAME = me?.username || null;
  } catch(e) {
    console.warn('getMe failed', e?.message ?? e);
  }
  await bot.launch();
  console.log('Hach-Tyan bot started. BOT_USERNAME=' + (BOT_USERNAME || 'unknown'));
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
