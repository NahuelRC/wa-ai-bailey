// src/wa.ts
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  proto
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import path from 'path';
import { aiReply } from './ai.js';
import { promises as fsp } from 'fs';
import { clearWhatsAppQr, updateWhatsAppQr } from './qrState.js';
import { getAuthDir } from './sessionManager.js';

// ====== Config de espera entre respuestas ======
const REPLY_DELAY_MS = 1_000;
const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

let activeSock: ReturnType<typeof makeWASocket> | null = null;
let initializingPromise: Promise<ReturnType<typeof makeWASocket>> | null = null;

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

// Teléfono a partir del JID
function phoneFromJid(jidRaw: string): string {
  return (jidRaw || '').replace(/\D+/g, '');
}

// ====== Descarga opcional de imágenes (fallback) ======
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

// ====== Registro de pedidos en CSV ======
const ORDER_CSV_PATH =
  process.env.ORDERS_CSV_PATH?.trim() ||
  path.join(process.cwd(), 'data', 'orders.csv');

const ORDER_CSV_HEADERS = [
  'timestamp_iso',
  'chat_jid',
  'telefono',
  'nombre',
  'producto',
  'cantidad',
  'total_ars',
  'direccion',
  'cp',
  'ciudad',
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
// ====== Dedupe por (telefono, día y hora) ======
const lastOrderKeyByPhone = new Map<string, string>(); // telefono -> 'YYYY-MM-DDTHH'

function hourKeyFromIso(iso: string) {
  // Devuelve "YYYY-MM-DDTHH" para comparar por día y hora
  // Ej: 2025-03-01T14
  try {
    // Aseguramos formato ISO válido
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const hh = String(d.getUTCHours()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}T${hh}`;
  } catch {
    return '';
  }
}

async function readLastNonEmptyLine(filePath: string): Promise<string | null> {
  try {
    const data = await fsp.readFile(filePath, 'utf8');
    const lines = data.split(/\r?\n/).filter(Boolean);
    if (lines.length <= 1) return null; // solo header o vacío
    // última línea con datos (ignora header)
    return lines[lines.length - 1] || null;
  } catch {
    return null;
  }
}

// Reemplazar tu appendOrderCsv por esta versión
async function appendOrderCsv(row: Record<string, string>) {
  await ensureOrderCsv();

  // Normalizamos telefono (si no viene, lo intentamos construir desde chat_jid)
  let telefono = (row['telefono'] || '').trim();
  if (!telefono) telefono = (row['chat_jid'] || '').replace(/\D+/g, '');
  row['telefono'] = telefono;

  // Clave de hora (UTC) para dedupe
  const iso = row['timestamp_iso'] || new Date().toISOString();
  row['timestamp_iso'] = iso;
  const hourKey = hourKeyFromIso(iso);
  const memKey = `${telefono}:${hourKey}`;

  // 1) Dedupe en memoria (rápido)
  const lastMem = lastOrderKeyByPhone.get(telefono);
  if (lastMem === hourKey) {
    L('ORD_CSV_DEDUPE_MEM_SKIP', { telefono, hourKey });
    return; // mismo tel + misma hora ya registrada en esta ejecución
  }

  // 2) Dedupe por última línea del archivo (persistente)
  const lastLine = await readLastNonEmptyLine(ORDER_CSV_PATH);
  if (lastLine) {
    // Mapeamos columnas por header para comparar correctamente
    const cols = lastLine.split(',').map(c => c.replace(/^"|"$/g, '').replace(/""/g, '"'));
    const idx = Object.fromEntries(ORDER_CSV_HEADERS.map((h, i) => [h, i]));

    const lastTel = (cols[idx['telefono']] || '').replace(/\D+/g, '');
    const lastIso = cols[idx['timestamp_iso']] || '';
    const lastHourKey = hourKeyFromIso(lastIso);

    if (lastTel && lastHourKey && lastTel === telefono && lastHourKey === hourKey) {
      L('ORD_CSV_DEDUPE_FILE_SKIP', { telefono, hourKey });
      return; // mismo tel + misma hora ya persistido anteriormente
    }
  }

  // Si superó dedupes, escribimos
  const line = ORDER_CSV_HEADERS.map(h => {
    const v = (row[h] ?? '').replace(/\r?\n/g, ' ').replace(/"/g, '""');
    return `"${v}"`;
  }).join(',') + '\n';

  await fsp.appendFile(ORDER_CSV_PATH, line, 'utf8');
  lastOrderKeyByPhone.set(telefono, hourKey);
  L('ORD_CSV_APPEND', { path: ORDER_CSV_PATH, telefono, hourKey });
}


// ====== Payload de orden desde la IA (opcional) ======
type OrderPayload = {
  
  nombre?: string;
  producto?: 'capsulas' | 'semillas' | 'gotas' | string;
  cantidad?: string | number;
  total_ars?: string | number;
  direccion?: string;
  cp?: string;
  ciudad?: string;
};
function isValidOrder(o: any): o is OrderPayload {
  if (!o || typeof o !== 'object') return false;
  const hasCore =
    !!o.producto &&
    o.cantidad !== undefined && String(o.cantidad).trim() !== '' &&
    o.total_ars !== undefined && String(o.total_ars).trim() !== '';
  return hasCore;
}

function buildOrderJSON(jidRaw: string, order: OrderPayload) {
  const telefono = (jidRaw || '').replace(/\D+/g, '');
  // normalizo total a número (opcional)
  const totalNum = Number(String(order.total_ars ?? '').replace(/[^\d]/g, '')) || 0;
  return {
    telefono,
    total_ars: totalNum
  };
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

// ====== pauseKey + pausa por conversación (2h) ======
const PAUSE_TTL_MS = 2 * 60 * 60 * 1000;

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

// ====== Historial temporal por conversación (máx 25) ======
type ChatTurn = { role: 'user' | 'assistant'; text: string; ts: number };
type ChatTranscript = { msgs: ChatTurn[]; lastAt: number };

const transcriptByKey = new Map<string, ChatTranscript>();

const TRANSCRIPT_MAX_MSGS = 25;                    // límite total U+A
const TRANSCRIPT_GC_TTL_MS = 12 * 60 * 60 * 1000;  // 12h de inactividad => borrar

function pushTranscript(jidRaw: string, role: 'user' | 'assistant', text: string) {
  const key = pauseKeyFromJid(jidRaw);
  if (!text?.trim()) return;

  const now = Date.now();
  const bucket = transcriptByKey.get(key) ?? { msgs: [], lastAt: now };
  bucket.msgs.push({ role, text: text.trim(), ts: now });
  bucket.lastAt = now;

  if (bucket.msgs.length > TRANSCRIPT_MAX_MSGS) {
    bucket.msgs.splice(0, bucket.msgs.length - TRANSCRIPT_MAX_MSGS);
  }

  transcriptByKey.set(key, bucket);
}
function buildHistoryForPrompt(jidRaw: string): string {
  const key = pauseKeyFromJid(jidRaw);
  const bucket = transcriptByKey.get(key);
  if (!bucket || bucket.msgs.length === 0) return '';
  return bucket.msgs
    .slice(-TRANSCRIPT_MAX_MSGS)
    .map(t => (t.role === 'user' ? `U: ${t.text}` : `A: ${t.text}`))
    .join('\n');
}
function clearTranscript(jidRaw: string) {
  const key = pauseKeyFromJid(jidRaw);
  transcriptByKey.delete(key);
  L('TRANSCRIPT_CLEAR', { jidRaw, key });
}
function gcTranscripts() {
  const now = Date.now();
  for (const [key, bucket] of transcriptByKey) {
    if (now - bucket.lastAt >= TRANSCRIPT_GC_TTL_MS) {
      transcriptByKey.delete(key);
      L('TRANSCRIPT_GC', { key });
    }
  }
}

// ====== Envío seguro ======
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
    // Fallback: si es imagen por URL, intentamos descargar y reenviar como buffer
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

// ====== Buffer por chat (debounce 1s) + epoch ======
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

  // Guardar turno de usuario
  pushTranscript(jidRaw, 'user', combinedText);

  // Historial para prompt
  const history = buildHistoryForPrompt(jidRaw);

  // === Llamada IA (el modelo devuelve JSON con { text, media?, order? }) ===
  const ai = await aiReply(combinedText, jidRaw, history);
  const textReply = ai?.text?.trim() || '';
  const media = Array.isArray(ai?.media) ? ai.media : [];

  // Enviar media primero (en el orden que indica el modelo)
  if (media.length) {
    for (const m of media) {
      if (!m?.url) continue;
      await delay(REPLY_DELAY_MS);
      if (isPausedAny(jidRaw)) { L('IMG_ABORT_PAUSED', { jidRaw }); return; }
      await safeSendMessage(sock, jidRaw, {
        image: { url: m.url },
        caption: m.caption || ''
      });
    }
  }

  // Enviar el texto
  if (textReply) {
    await delay(REPLY_DELAY_MS);
    if (isPausedAny(jidRaw)) { L('TEXT_ABORT_PAUSED', { jidRaw }); return; }
    await safeSendMessage(sock, jidRaw, { text: textReply });
    pushTranscript(jidRaw, 'assistant', textReply);
  }

  // ====== CSV por objeto "order" (si la IA lo provee) ======
  if (ai && ai.order && isValidOrder(ai.order)) {
    const telefono = phoneFromJid(jidRaw);
    const row = {
      timestamp_iso: new Date().toISOString(),
      chat_jid: jidRaw,
      telefono,
      nombre: String(ai.order.nombre ?? ''),
      producto: String(ai.order.producto ?? ''),
      cantidad: String(ai.order.cantidad ?? ''),
      total_ars: String(ai.order.total_ars ?? ''),
      direccion: String(ai.order.direccion ?? ''),
      cp: String(ai.order.cp ?? ''),
      ciudad: String(ai.order.ciudad ?? ''),
      //raw_text: textReply || combinedText
    };
    // >>> AQUI construimos el JSON pedido <<<
  const orderJSON = buildOrderJSON(jidRaw, ai.order);
  L('ORDER_JSON', orderJSON); // lo ves en logs

    // (Opcional) Enviarlo a tu BE por webhook
  // if (process.env.ORDER_WEBHOOK_URL) {
  //   try {
  //     await fetch(process.env.ORDER_WEBHOOK_URL, {
  //       method: 'POST',
  //       headers: { 'Content-Type': 'application/json' },
  //       body: JSON.stringify(orderJSON)
  //     });
  //     L('ORDER_JSON_POST_OK', {});
  //   } catch (e) {
  //     L('ORDER_JSON_POST_ERR', { error: (e as Error)?.message });
  //   }
  // }
    try {
      await appendOrderCsv(row);
      L('ORDER_FROM_OBJECT_OK', { jidRaw, row });
      // Si querés, después de cerrar la compra podés limpiar historial:
      // clearTranscript(jidRaw);
    } catch (e) {
      L('ORDER_FROM_OBJECT_ERR', { error: (e as Error)?.message });
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
  if (initializingPromise) {
    return initializingPromise;
  }

  initializingPromise = (async () => {
    const AUTH_DIR = getAuthDir();
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({ version, auth: state, printQRInTerminal: false });
    activeSock = sock;
    console.log(`[AUTH] usando carpeta de sesión: ${AUTH_DIR}`);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        console.log('QR actualizado; consultalo desde el panel web.');
        try {
          await updateWhatsAppQr(qr);
        } catch (err) {
          console.error('No se pudo preparar el QR para la web', err);
        }
      }
      if (connection === 'open') {
        console.log('✅ Conectado a WhatsApp');
        clearWhatsAppQr();
      } else if (connection === 'close') {
        const code = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        console.warn('Conexión cerrada. Código:', code, 'Reintentar:', shouldReconnect);
        clearWhatsAppQr();
        if (!shouldReconnect) {
          activeSock = null;
        }
        if (shouldReconnect) void iniciarWhatsApp();
        else console.error('Sesión cerrada (logged out). Borra la carpeta de sesión para re-vincular.');
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // Mensajes entrantes
    sock.ev.on('messages.upsert', async (m) => {
      try {
        gcPaused();
        gcTranscripts();

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

        // Dedup
        if (processedIds.has(messageId)) { L('DEDUP_SKIP', { messageId }); return; }
        processedIds.set(messageId, Date.now());
        gcProcessedIds();

        // Comandos owner-only (enviados desde tu propio número)
        if (fromMe) {
          const t = normalize(text);
          L('CMD_CHECK', { chatJidRaw, t });

          if (/^\/?\s*bot(?:-|\s*)pause\b/.test(t)) {
            const digits = (t.match(/\d{7,}/g) || [])[0];
            const targetJidRaw = digits ? `${digits}@s.whatsapp.net` : chatJidRaw;
            setPaused(targetJidRaw);
            const targetKey = pauseKeyFromJid(targetJidRaw);
            const pending = pendingByKey.get(targetKey);
            if (pending?.timer) clearTimeout(pending.timer);
            pendingByKey.delete(targetKey);
            await delay(REPLY_DELAY_MS);
            await safeSendMessage(sock, chatJidRaw, { text: `🛑 Bot pausado por 2 horas en ${targetJidRaw}.` });
            return;
          }
          if (/^\/?\s*bot(?:-|\s*)play\b/.test(t)) {
            const digits = (t.match(/\d{7,}/g) || [])[0];
            const targetJidRaw = digits ? `${digits}@s.whatsapp.net` : chatJidRaw;
            clearPaused(targetJidRaw);
            await delay(REPLY_DELAY_MS);
            await safeSendMessage(sock, chatJidRaw, { text: `▶️ Bot reanudado en ${targetJidRaw}.` });
            return;
          }

          // no auto-responder mis mensajes
          return;
        }

        if (isPausedAny(chatJidRaw)) { L('MSG_SKIP_PAUSED', { chatJidRaw }); return; }

        // Encolar para batch
        enqueueMessageForChat(sock, chatJidRaw, text);

      } catch (err: any) {
        console.error('Error en messages.upsert:', err?.message || err);
        L('MSG_ERR', { error: err?.message || String(err) });
      }
    });

    return sock;
  })();

  try {
    return await initializingPromise;
  } finally {
    initializingPromise = null;
  }
}

export async function logoutWhatsApp() {
  if (activeSock) {
    try {
      await activeSock.logout();
    } catch (err) {
      console.warn('No se pudo cerrar sesión de WhatsApp', err);
    }
  }
  activeSock = null;
  initializingPromise = null;
  clearWhatsAppQr();
}

export function isConversationPaused(jidRaw: string): boolean {
  return isPausedAny(jidRaw);
}

export function setConversationPaused(jidRaw: string, paused: boolean) {
  if (paused) setPaused(jidRaw);
  else clearPaused(jidRaw);
}
