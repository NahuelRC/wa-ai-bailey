// src/wa.ts
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  proto
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import fetch from 'node-fetch';
import path from 'path';
import { aiReply } from './ai.js';
import { cfg } from './config.js';
import { promises as fsp } from 'fs';

// ====== Config de espera entre respuestas ======
const REPLY_DELAY_MS = 5_000;
const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

// ====== Logger ======
function L(scope: string, obj: any) {
  try {
    const time = new Date().toISOString();
    console.log(`[${time}] [${scope}]`, typeof obj === 'string' ? obj : JSON.stringify(obj));
  } catch {
    // no-op
  }
}

// ====== Helpers ======
function normalize(t: string) {
  return (t || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchImageBuffer(url: string, timeoutMs = 15000): Promise<Buffer> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*,*/*;q=0.8' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  } finally { clearTimeout(id); }
}

// ====== Intenciones / productos ======
type ImgKind =
  | 'semillas' | 'capsulas' | 'gotas'
  | 'precio_semillas' | 'precio_capsulas' | 'precio_gotas'
  | 'dosificar' | 'bienvenida';

// ¿Se pidió precio?
function wantsPrice(raw: string): boolean {
  const t = normalize(raw);
  return /\b(precio|precios|cuanto\s+(sale|vale|cuesta|estan?)|cuanto|costo|lista\s+de\s+precios|tarifa|oferta|ofertas|promo|promocion|promos?)\b/.test(t)
      || /\$\s*\d/.test(t)
      || /\bars\b/.test(t);
}

// Producto mencionado
function parseProductKind(raw: string): 'semillas'|'capsulas'|'gotas'|null {
  const t = normalize(raw);
  if (/\bsemilla(s)?\b|\bnuez(es)?\b/.test(t)) return 'semillas';
  if (/\bcapsula(s)?\b|\bcaps\b/.test(t)) return 'capsulas';
  if (/\bgota(s)?\b|\bdrop(s)?\b|\bgotero\b/.test(t)) return 'gotas';
  return null;
}

// Instrucciones EXCLUSIVAS de NUEZ/semilla
function wantsNuezInstructions(raw: string): boolean {
  const t = normalize(raw);
  const mentionsNuez = /\b(nuez|semilla|semillas)\b/.test(t);
  const mentionsCapsOrDrops = /\b(capsula|capsulas|caps)\b|\b(gota|gotas|gotero|drop)\b/.test(t);
  const mentionsInstructions = /\b(dosificar|instruccion(es)?|uso|preparar|preparacion|como usar|modo de uso)\b/.test(t);
  return mentionsNuez && !mentionsCapsOrDrops && mentionsInstructions;
}

// ====== Registro de pedidos en CSV ======
const ORDER_CSV_PATH = process.env.ORDERS_CSV_PATH?.trim() || path.join(process.cwd(), 'data', 'orders.csv');
const ORDER_CSV_HEADERS = [
  'timestamp_iso',
  'chat_jid',
  'pause_key',
  'product_intent',
  'price_intent',
  'quantity_guess',
  'has_address_hint',
  'raw_text'
];

async function ensureOrderCsv() {
  const dir = path.dirname(ORDER_CSV_PATH);
  await fsp.mkdir(dir, { recursive: true });
  const exists = await fsp.access(ORDER_CSV_PATH).then(() => true).catch(() => false);
  if (!exists) {
    await fsp.writeFile(ORDER_CSV_PATH, ORDER_CSV_HEADERS.join(',') + '\n', 'utf8');
    L('ORD_CSV_INIT', { path: ORDER_CSV_PATH });
  }
}
function csvEscape(val: string) {
  const v = (val ?? '').replace(/\r?\n/g, ' ').replace(/"/g, '""');
  return `"${v}"`;
}
async function appendOrderCsv(row: Record<string, string>) {
  await ensureOrderCsv();
  const line = ORDER_CSV_HEADERS.map(h => csvEscape(row[h] ?? '')).join(',') + '\n';
  await fsp.appendFile(ORDER_CSV_PATH, line, 'utf8');
  L('ORD_CSV_APPEND', { path: ORDER_CSV_PATH });
}

// Heurística de detección de pedido (texto libre)
type OrderDetect = {
  isOrder: boolean;
  quantityGuess: string;
  hasAddressHint: boolean;
};
function detectOrder(raw: string): OrderDetect {
  const t = normalize(raw);

  const intentWords = /\b(quiero|deseo|necesito|hago|hacer|realizar|confirmar)\b.*\b(pedido|compra|orden)\b/.test(t)
    || /\b(quiero|deseo|necesito)\b.*\b(semillas?|capsulas?|gotas?)\b/.test(t)
    || /\b(enviar|mandar|envio|envío)\b/.test(t)
    || /\bcontra\s*reembolso\b/.test(t);

  const hasQty =
    /\b(\d+)\s*(botes?|frascos?|unidades?|u\.?|pack|cajas?)\b/.test(t) ||
    /\b(pack|combo)\b/.test(t) ||
    /\b(dos|tres|cuatro|cinco)\b\s*(botes?|frascos?|unidades?)\b/.test(t);

  const qtyMatch = t.match(/\b(\d+)\s*(botes?|frascos?|unidades?|u\.?|pack|cajas?)\b/);
  const quantityGuess = qtyMatch?.[1] || (/\b(dos)\b/.test(t) ? '2' : /\b(tres)\b/.test(t) ? '3' : '');

  const hasAddressHint =
    /\b(direccion|dirección|calle|av\.?|avenida|nro|numero|número|cp|codigo postal|c\.p\.|barrio|ciudad|provincia)\b/.test(t)
    || /\bentre\s+calles?\b/.test(t);

  const mentionsProduct = /\b(semillas?|capsulas?|gotas?)\b/.test(t);

  const isOrder = (intentWords || hasQty || hasAddressHint) && mentionsProduct;

  return { isOrder, quantityGuess: quantityGuess || (hasQty ? '?' : ''), hasAddressHint };
}

// === NUEVO === Parseo del mensaje final de confirmación "Resumen: ... <END_CONVERSATION/>"
function parseFinalOrderSummary(text: string): null | {
  product: string;
  qty: string;
  name: string;
  address: string;
  city: string;
  postal: string;
} {
  if (!/resumen:/i.test(text) || !/<end_conversation\/>/i.test(text)) return null;

  // Acepta "—" o "-"
  const re = /resumen:\s*(.+?)\s*x\s*(\d+)\b.*?[—-]\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^.]+)\.?/i;
  const m = text.match(re);
  if (!m) return null;

  const [, product, qty, name, address, city, postal] = m.map(s => (s ?? '').trim());
  return { product, qty, name, address, city, postal };
}

// ====== Resolver URL según categoría (usa tus variables .env) ======
function pickUrl(kind: ImgKind): { url?: string; caption: string } {
  // Precios
  const PREC_CAPS = (cfg as any).IMG1_PrecioCAPSULAS_URL ?? process.env.IMG1_PrecioCAPSULAS_URL;
  const PREC_SEMI = (cfg as any).IMG2_PrecioSEMILLAS_URL ?? process.env.IMG2_PrecioSEMILLAS_URL;
  const PREC_GOTE = (cfg as any).IMG3_PrecioGOTERO_URL   ?? process.env.IMG3_PrecioGOTERO_URL;
  // Bienvenida
  const BIENV    = (cfg as any).IMG4_BIENVENIDA_URL      ?? process.env.IMG4_BIENVENIDA_URL;
  // Info general
  const INFO_CAPS = (cfg as any).IMG5_CAPSULA_URL        ?? process.env.IMG5_CAPSULA_URL;
  const INFO_SEMI = (cfg as any).IMG6_SEMILLAS_URL       ?? process.env.IMG6_SEMILLAS_URL;
  const INFO_GOTE = (cfg as any).IMG6_GOTERO_URL         ?? process.env.IMG6_GOTERO_URL;

  const choose = (...cands: (string | undefined)[]) => cands.find(u => !!u && u.trim().length > 0);

  switch (kind) {
    case 'precio_capsulas':  return { url: choose(PREC_CAPS), caption: 'Cápsulas · Precios' };
    case 'precio_semillas':  return { url: choose(PREC_SEMI), caption: 'Semillas · Precios' };
    case 'precio_gotas':     return { url: choose(PREC_GOTE), caption: 'Gotas · Precios' };
    case 'capsulas':         return { url: choose(INFO_CAPS), caption: 'Cápsulas' };
    case 'semillas':         return { url: choose(INFO_SEMI), caption: 'Semillas' };
    case 'gotas':            return { url: choose(INFO_GOTE), caption: 'Gotas' };
    case 'dosificar':        return { url: choose(INFO_SEMI), caption: 'Cómo dosificar (Nuez)' };
    case 'bienvenida':       return { url: choose(BIENV), caption: '' };
    default:                 return { url: choose(BIENV), caption: '' };
  }
}

// ====== Extraer texto útil ======
function getTextFromMessage(msg: proto.IMessage): string {
  if (!msg) return '';
  if (msg.conversation) return msg.conversation;
  if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
  if (msg.imageMessage?.caption) return msg.imageMessage.caption;
  if (msg.videoMessage?.caption) return msg.videoMessage.caption;
  if (msg.buttonsResponseMessage?.selectedButtonId) return msg.buttonsResponseMessage.selectedButtonId;
  if (msg.listResponseMessage?.singleSelectReply?.selectedRowId) return msg.listResponseMessage.singleSelectReply.selectedRowId;
  return '';
}

// ====== Anti-duplicados ======
const processedIds = new Map<string, number>(); // id -> ts
const MAX_CACHE = 5000;
const CACHE_TTL_MS = 10 * 60_000;
function gcProcessedIds() {
  const now = Date.now();
  for (const [id, ts] of processedIds) if (now - ts > CACHE_TTL_MS) processedIds.delete(id);
  if (processedIds.size > MAX_CACHE) {
    const toDelete = processedIds.size - MAX_CACHE;
    let i = 0;
    for (const k of processedIds.keys()) { processedIds.delete(k); if (++i >= toDelete) break; }
  }
}

// ====== pauseKey por dígitos + pausa por conversación (2h) ======
const PAUSE_TTL_MS = 2 * 60 * 60 * 1000;

// clave estable por chat basada en dígitos del número
function pauseKeyFromJid(jidRaw: string): string {
  const digits = (jidRaw || '').replace(/\D+/g, '');
  const key = digits || jidRaw;
  L('PAUSEKEY', { jidRaw, key });
  return key;
}

const pausedByKey = new Map<string, number>();     // pauseKey -> ts
const chatEpochByKey = new Map<string, number>();  // pauseKey -> epoch

function getEpoch(key: string) { return chatEpochByKey.get(key) ?? 0; }
function bumpEpoch(key: string) {
  const v = getEpoch(key) + 1;
  chatEpochByKey.set(key, v);
  L('EPOCH', { key, newEpoch: v });
}

function setPaused(jidRaw: string) {
  const key = pauseKeyFromJid(jidRaw);
  pausedByKey.set(key, Date.now());
  L('PAUSE_SET', { jidRaw, key, ts: Date.now() });
  bumpEpoch(key);
}
function clearPaused(jidRaw: string) {
  const key = pauseKeyFromJid(jidRaw);
  pausedByKey.delete(key);
  L('PAUSE_CLEAR', { jidRaw, key });
  bumpEpoch(key);
}
function isPausedAny(jidRaw: string): boolean {
  const key = pauseKeyFromJid(jidRaw);
  const ts = pausedByKey.get(key);
  if (!ts) {
    L('PAUSE_CHECK', { jidRaw, key, paused: false });
    return false;
  }
  const expired = (Date.now() - ts) >= PAUSE_TTL_MS;
  if (expired) {
    pausedByKey.delete(key);
    L('PAUSE_EXPIRE', { jidRaw, key, ts, now: Date.now() });
    return false;
  }
  L('PAUSE_CHECK', { jidRaw, key, paused: true });
  return true;
}
function gcPaused() {
  const now = Date.now();
  for (const [k, ts] of pausedByKey) {
    if (now - ts >= PAUSE_TTL_MS) {
      pausedByKey.delete(k);
      L('PAUSE_GC', { key: k, removedAt: now });
    }
  }
}

// ====== Último chat entrante (para comandos sin número) ======
let lastInboundChatRaw: string | null = null;

// Resolver destino desde comando o fallback
function resolveTargetJidFromCommand(text: string, fallback: string | null): string | null {
  const t = normalize(text);
  const digits = (t.match(/\d{7,}/g) || [])[0]; // primer número largo
  if (digits) {
    const jid = `${digits}@s.whatsapp.net`;
    L('CMD_TARGET_FROM_NUMBER', { digits, jid });
    return jid;
  }
  if (fallback) {
    L('CMD_TARGET_FROM_LASTINBOUND', { jid: fallback });
    return fallback;
  }
  L('CMD_TARGET_NOT_FOUND', {});
  return null;
}

// ====== Wrapper de envío seguro ======
async function safeSendMessage(
  sock: ReturnType<typeof makeWASocket>,
  jidRaw: string,
  content: any
) {
  if (isPausedAny(jidRaw)) {
    L('SEND_SKIP_PAUSED', { jidRaw, reason: 'paused' });
    return;
  }
  try {
    L('SEND_TRY', { jidRaw, kind: Object.keys(content)[0] });
    await sock.sendMessage(jidRaw, content);
    L('SEND_OK', { jidRaw, kind: Object.keys(content)[0] });
  } catch (e) {
    L('SEND_ERR', { jidRaw, error: (e as Error)?.message });
    if (content?.image?.url) {
      try {
        const buf = await fetchImageBuffer(content.image.url);
        if (isPausedAny(jidRaw)) {
          L('SEND_BUF_SKIP_PAUSED', { jidRaw });
          return;
        }
        await sock.sendMessage(jidRaw, { image: buf, caption: content.caption ?? content.image?.caption ?? content?.caption });
        L('SEND_BUF_OK', { jidRaw });
      } catch (e2) {
        L('SEND_BUF_ERR', { jidRaw, error: (e2 as Error)?.message });
      }
    }
  }
}

// ====== Bienvenida 1 vez por día ======
const dailyWelcome = new Map<string, string>(); // jidRaw -> YYYY-MM-DD
function todayStr() {
  const d = new Date(); const mm = String(d.getMonth()+1).padStart(2,'0'); const dd = String(d.getDate()).padStart(2,'0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}
function shouldSendDailyWelcome(jidRaw: string): boolean {
  const t = todayStr();
  const prev = dailyWelcome.get(jidRaw);
  if (prev === t) return false;
  dailyWelcome.set(jidRaw, t);
  L('WELCOME_MARK', { jidRaw, day: t });
  return true;
}

// ====== Buffer por chat (debounce 10s) + epoch por pauseKey ======
type Pending = { parts: string[]; timer?: NodeJS.Timeout; epoch: number };
const pendingByKey = new Map<string, Pending>();

async function processBatch(sock: ReturnType<typeof makeWASocket>, jidRaw: string, key: string) {
  const pending = pendingByKey.get(key);
  if (!pending) { L('BATCH_MISS', { jidRaw, key }); return; }
  pendingByKey.delete(key);
  L('BATCH_START', { jidRaw, key, epoch: pending.epoch });

  if (isPausedAny(jidRaw)) { L('BATCH_ABORT_PAUSED', { jidRaw, key }); return; }
  if (pending.epoch !== getEpoch(key)) { L('BATCH_ABORT_EPOCH', { jidRaw, key, old: pending.epoch, current: getEpoch(key) }); return; }

  const combinedText = pending.parts.join(' ').trim();
  L('BATCH_COMBINED', { jidRaw, key, len: combinedText.length, text: combinedText });
  if (!combinedText) return;

  try {
    await sock.presenceSubscribe(jidRaw);
    await sock.sendPresenceUpdate('composing', jidRaw);
    setTimeout(() => { void sock.sendPresenceUpdate('paused', jidRaw); }, 600);
  } catch {}

  // Bienvenida (solo 1 vez al día)
  if (shouldSendDailyWelcome(jidRaw)) {
    const w = pickUrl('bienvenida');
    if (w.url) {
      await delay(REPLY_DELAY_MS);
      if (isPausedAny(jidRaw) || pending.epoch !== getEpoch(key)) { L('WELCOME_ABORT', { jidRaw, key }); return; }
      await safeSendMessage(sock, jidRaw, { image: { url: w.url }, caption: w.caption });
    }
  }

  // Intención (en todo el batch)
  const product = parseProductKind(combinedText);
  const price = wantsPrice(combinedText);
  const onlyNuezInstr = wantsNuezInstructions(combinedText);

  // Prioridad: precio+producto > dosificar > producto
  let comboImageKind: ImgKind | null = null;
  if (product && price) {
    comboImageKind =
      product === 'semillas' ? 'precio_semillas' :
      product === 'capsulas' ? 'precio_capsulas' :
      'precio_gotas';
  } else if (onlyNuezInstr) {
    comboImageKind = 'dosificar';
  } else if (product) {
    comboImageKind = product;
  }
  L('INTENT', { jidRaw, key, product, price, onlyNuezInstr, comboImageKind });

  // ====== Detección + guardado del pedido en CSV (texto libre) ======
  const order = detectOrder(combinedText);
  if (order.isOrder) {
    const row = {
      timestamp_iso: new Date().toISOString(),
      chat_jid: jidRaw,
      pause_key: key,
      product_intent: product ?? '',
      price_intent: price ? 'yes' : 'no',
      quantity_guess: order.quantityGuess || '',
      has_address_hint: order.hasAddressHint ? 'yes' : 'no',
      raw_text: combinedText
    };
    try {
      await appendOrderCsv(row);
      L('ORDER_DETECTED', { jidRaw, key, row });
    } catch (e) {
      L('ORDER_ERR', { error: (e as Error)?.message });
    }
  }

  // Llamada IA
  const reply = await aiReply(combinedText, jidRaw);
  L('AI_REPLY_LEN', { jidRaw, key, len: (reply || '').length });

  if (isPausedAny(jidRaw) || pending.epoch !== getEpoch(key)) { L('POST_AI_ABORT', { jidRaw, key }); return; }

  // Imagen combinada si aplica
  if (comboImageKind) {
    const chosen = pickUrl(comboImageKind);
    if (chosen?.url) {
      await delay(REPLY_DELAY_MS);
      if (isPausedAny(jidRaw) || pending.epoch !== getEpoch(key)) { L('IMG_ABORT', { jidRaw, key }); return; }
      await safeSendMessage(sock, jidRaw, { image: { url: chosen.url }, caption: chosen.caption });
    } else {
      L('IMG_SKIP_NOURL', { jidRaw, key, comboImageKind });
    }
  }

  // Texto IA
  await delay(REPLY_DELAY_MS);
  if (isPausedAny(jidRaw) || pending.epoch !== getEpoch(key)) { L('TEXT_ABORT', { jidRaw, key }); return; }
  await safeSendMessage(sock, jidRaw, { text: reply });

  // /foto ... explícito dentro del batch (para pruebas)
  const fotoCmd = normalize(combinedText).match(/^\/?foto\s+(semillas|capsulas|gotas|precio_semillas|precio_capsulas|precio_gotas|dosificar)\b/);
  if (fotoCmd?.[1]) {
    const extraKind = fotoCmd[1] as ImgKind;
    const extra = pickUrl(extraKind);
    if (extra?.url) {
      await delay(REPLY_DELAY_MS);
      if (isPausedAny(jidRaw) || pending.epoch !== getEpoch(key)) { L('EXTRA_IMG_ABORT', { jidRaw, key }); return; }
      await safeSendMessage(sock, jidRaw, { image: { url: extra.url }, caption: extra.caption });
    } else {
      await delay(REPLY_DELAY_MS);
      if (isPausedAny(jidRaw) || pending.epoch !== getEpoch(key)) { L('EXTRA_TEXT_ABORT', { jidRaw, key }); return; }
      await safeSendMessage(sock, jidRaw, { text: 'No tengo esa imagen configurada.' });
    }
  }

  L('BATCH_END', { jidRaw, key });
}

function enqueueMessageForChat(sock: ReturnType<typeof makeWASocket>, jidRaw: string, text: string) {
  if (isPausedAny(jidRaw)) { L('ENQ_SKIP_PAUSED', { jidRaw }); return; }
  const key = pauseKeyFromJid(jidRaw);
  const currentEpoch = getEpoch(key);
  const existing = pendingByKey.get(key);

  if (!existing) {
    const p: Pending = { parts: [text], epoch: currentEpoch };
    p.timer = setTimeout(() => { void processBatch(sock, jidRaw, key); }, REPLY_DELAY_MS);
    pendingByKey.set(key, p);
    L('ENQ_NEW', { jidRaw, key, epoch: currentEpoch, parts: 1 });
  } else {
    if (existing.epoch !== currentEpoch) {
      if (existing.timer) clearTimeout(existing.timer);
      const p: Pending = { parts: [text], epoch: currentEpoch };
      p.timer = setTimeout(() => { void processBatch(sock, jidRaw, key); }, REPLY_DELAY_MS);
      pendingByKey.set(key, p);
      L('ENQ_RESET_EPOCH', { jidRaw, key, epoch: currentEpoch });
    } else {
      existing.parts.push(text);
      if (existing.timer) clearTimeout(existing.timer);
      existing.timer = setTimeout(() => { void processBatch(sock, jidRaw, key); }, REPLY_DELAY_MS);
      L('ENQ_APPEND', { jidRaw, key, epoch: existing.epoch, parts: existing.parts.length });
    }
  }
}

// ================================================
export async function iniciarWhatsApp() {
  const AUTH_DIR =
    process.env.WA_AUTH_DIR?.trim() ||
    process.env.WA_SESSION_DIR?.trim() ||
    path.join(process.cwd(), 'auth');

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({ version, auth: state, printQRInTerminal: false });
  console.log(`[AUTH] usando carpeta de sesión: ${AUTH_DIR}`);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('Escaneá este QR para vincular tu sesión:');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      console.log('✅ Conectado a WhatsApp');
    } else if (connection === 'close') {
      const code = (lastDisconnect?.error as any)?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.warn('Conexión cerrada. Código:', code, 'Reintentar:', shouldReconnect);
      if (shouldReconnect) void iniciarWhatsApp();
      else console.error('Sesión cerrada (logged out). Borra la carpeta de sesión para re-vincular.');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Mensajes entrantes
  sock.ev.on('messages.upsert', async (m) => {
    try {
      gcPaused();
      if (m.type !== 'notify') return;

      const msg = m.messages?.[0];
      if (!msg || !msg.message) return;

      const chatJidRaw = msg.key.remoteJid || '';
      if (!chatJidRaw || chatJidRaw === 'status@broadcast') return;

      const fromMe = !!msg.key.fromMe;
      const text = getTextFromMessage(msg.message).trim();
      const messageId = msg.key.id || `${chatJidRaw}:${Date.now()}`;

      L('MSG_IN', { messageId, chatJidRaw, fromMe, text });

      if (!text) return;

      // Dedupe
      if (processedIds.has(messageId)) { L('DEDUP_SKIP', { messageId }); return; }
      processedIds.set(messageId, Date.now());
      gcProcessedIds();

      // ===== Comportamiento para mensajes ENVIADOS POR EL BOT =====
      if (fromMe) {
        // 1) Si es el mensaje de confirmación "Resumen: ... <END_CONVERSATION/>" -> guardar al CSV
        const parsed = parseFinalOrderSummary(text);
        if (parsed) {
          const key = pauseKeyFromJid(chatJidRaw);
          const row = {
            timestamp_iso: new Date().toISOString(),
            chat_jid: chatJidRaw,
            pause_key: key,
            product_intent: parsed.product || '',
            price_intent: 'no',
            quantity_guess: parsed.qty || '',
            has_address_hint: 'yes',
            raw_text: text
          };
          try {
            await appendOrderCsv(row);
            L('ORDER_FINAL_LOGGED', { chatJidRaw, key, row });
          } catch (e) {
            L('ORDER_FINAL_ERR', { error: (e as Error)?.message });
          }
          // No retorno: por si además querés que siga evaluando comandos (abajo).
        }

        // ===== Comandos owner-only (enviados desde tu número / LID) =====
        const t = normalize(text);
        L('CMD_CHECK', { chatJidRaw, t });

        // bot-pause (con número o sin número -> usa último entrante)
        if (/^\/?\s*bot(?:-|\s*)pause\b/.test(t)) {
          const targetJidRaw = resolveTargetJidFromCommand(text, lastInboundChatRaw);
          if (!targetJidRaw) {
            await delay(REPLY_DELAY_MS);
            await safeSendMessage(sock, chatJidRaw, { text: 'No pude determinar qué chat pausar. Enviá: bot-pause <numeroSin+>' });
            return;
          }

          setPaused(targetJidRaw);

          // cancelar cualquier batch pendiente del destino (por pauseKey)
          const targetKey = pauseKeyFromJid(targetJidRaw);
          const pending = pendingByKey.get(targetKey);
          if (pending?.timer) clearTimeout(pending.timer);
          pendingByKey.delete(targetKey);
          L('CMD_PAUSE_OK', { fromChat: chatJidRaw, targetJidRaw, key: targetKey });

          try { await sock.presenceSubscribe(chatJidRaw); await sock.sendPresenceUpdate('composing', chatJidRaw); setTimeout(() => { void sock.sendPresenceUpdate('paused', chatJidRaw); }, 600); } catch {}
          await delay(REPLY_DELAY_MS);
          await safeSendMessage(sock, chatJidRaw, { text: `🛑 Bot pausado por 2 horas en ${targetJidRaw}. Mandá "bot-play ${targetJidRaw.replace('@s.whatsapp.net','')}" para reanudar antes.` });
          return;
        }

        // bot-play (con número o sin número -> usa último entrante)
        if (/^\/?\s*bot(?:-|\s*)play\b/.test(t)) {
          const targetJidRaw = resolveTargetJidFromCommand(text, lastInboundChatRaw);
          if (!targetJidRaw) {
            await delay(REPLY_DELAY_MS);
            await safeSendMessage(sock, chatJidRaw, { text: 'No pude determinar qué chat reanudar. Enviá: bot-play <numeroSin+>' });
            return;
          }

          const wasPaused = isPausedAny(targetJidRaw);
          clearPaused(targetJidRaw);
          L('CMD_PLAY_OK', { fromChat: chatJidRaw, targetJidRaw, wasPaused });

          try { await sock.presenceSubscribe(chatJidRaw); await sock.sendPresenceUpdate('composing', chatJidRaw); setTimeout(() => { void sock.sendPresenceUpdate('paused', chatJidRaw); }, 600); } catch {}
          await delay(REPLY_DELAY_MS);
          await safeSendMessage(sock, chatJidRaw, { text: wasPaused ? `▶️ Bot reanudado en ${targetJidRaw}.` : `▶️ El bot ya estaba activo en ${targetJidRaw}.` });
          return;
        }

        // No auto-responder mis propios mensajes
        L('SELF_SKIP', { chatJidRaw });
        return;
      }

      // ===== Mensajes entrantes (usuario) =====

      // Actualizar último chat entrante (para comandos sin número)
      lastInboundChatRaw = chatJidRaw;
      L('LAST_INBOUND_SET', { lastInboundChatRaw });

      // Si está pausado → silencio total
      if (isPausedAny(chatJidRaw)) { L('MSG_SKIP_PAUSED', { chatJidRaw }); return; }

      // Encolar para batch 10s (unir mensajes del usuario)
      enqueueMessageForChat(sock, chatJidRaw, text);

    } catch (err: any) {
      console.error('Error en messages.upsert:', err?.message || err);
      L('MSG_ERR', { error: err?.message || String(err) });
    }
  });

  return sock;
}
