// src/wa.ts
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  jidNormalizedUser,
  proto
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import fetch from 'node-fetch';
import path from 'path';
import { aiReply } from './ai.js';
import { cfg } from './config.js';

// ====== Config de espera entre respuestas ======
const REPLY_DELAY_MS = 10_000;
const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

// ====== Helpers de texto/imagen ======
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
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'image/*,*/*;q=0.8'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  } finally {
    clearTimeout(id);
  }
}

// ====== Detección de solicitud de imagen / intención ======
type ImgKind = 'semillas' | 'capsulas' | 'gotas' | 'generic' | 'diabetes' | 'hipotiroidismo' | 'hipertiroidismo' | 'dosificar';

function parseImageRequest(raw: string): ImgKind | null {
  const t = normalize(raw);

  const hasImageWord = /\b(imagen|imagenes|foto|fotos|picture|pic|photo|📸|🖼️)\b/.test(t);
  const hasAskVerb   = /\b(mostrar|mostrame|mostra|manda|mandame|ver|podria|podrias|necesito|ensename|show|send)\b/.test(t);

  if (!(hasImageWord || hasAskVerb)) return null;

  if (/\bsemilla(s)?\b/.test(t)) return 'semillas';
  if (/\bcapsula(s)?\b|\bcaps\b/.test(t)) return 'capsulas';
  if (/\bgota(s)?\b|\bdrop(s)?\b/.test(t)) return 'gotas';
  if (/\bdiabetes\b/.test(t)) return 'diabetes';
  if (/\btiroidismo\b|\bhipo?tiroidismo\b/.test(t)) return 'hipotiroidismo';
  if (/\btiroidismo\b|\bhiper?tiroidismo\b/.test(t)) return 'hipertiroidismo';
  if (/\bdosificar\b/.test(t)) return 'dosificar';

  return 'generic';
}

// SOLO para producto (no patología ni dosificar)
function parseProductKind(raw: string): ImgKind | null {
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

// ====== Resolver URL según categoría (usa tus variables de entorno) ======
function pickUrl(kind: ImgKind): { url?: string; caption: string } {
  // Tomamos de cfg si existe o directo desde process.env
  const CAPS = (cfg as any).IMG1_CAPSULAS_URL ?? process.env.IMG1_CAPSULAS_URL;
  const SEMI = (cfg as any).IMG2_SEMILLAS_URL ?? process.env.IMG2_SEMILLAS_URL;
  const GOTE = (cfg as any).IMG3_GOTERO_URL   ?? process.env.IMG3_GOTERO_URL;
  const BIENVENIDA = (cfg as any).IMG4_BIENVEDNIDA_URL ?? process.env.IMG4_BIENVEDNIDA_URL; // (mantengo tu nombre)
  const DIABETES   = (cfg as any).IMG5_DIABETES_URL    ?? process.env.IMG5_DIABETES_URL;
  const TIROIDISMO = (cfg as any).IMG6_TIROIDISMO_URL  ?? process.env.IMG6_TIROIDISMO_URL;
  const DOSIFICAR  = (cfg as any).IMG7_DOSIFICAR_URL   ?? process.env.IMG7_DOSIFICAR_URL;

  const choose = (...cands: (string | undefined)[]) =>
    cands.find(u => !!u && u.trim().length > 0);

  switch (kind) {
    case 'capsulas':   return { url: choose(CAPS, SEMI, GOTE), caption: 'Cápsulas' };
    case 'semillas':   return { url: choose(SEMI, CAPS, GOTE), caption: 'Semillas' };
    case 'gotas':      return { url: choose(GOTE, CAPS, SEMI), caption: 'Gotas' };
    case 'diabetes':   return { url: choose(DIABETES), caption: 'Diabetes' };
    case 'hipotiroidismo': return { url: choose(TIROIDISMO), caption: 'hipotiroidismo' };
    case 'hipertiroidismo': return { url: choose(TIROIDISMO), caption: 'hipertiroidismo' };
    case 'dosificar':  return { url: choose(DOSIFICAR ?? BIENVENIDA), caption: 'Cómo dosificar' };
    default:           return { url: choose(BIENVENIDA), caption: 'Preguntame lo que necesites' };
  }
}

// ====== Extractor de texto útil ======
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
  for (const [id, ts] of processedIds) {
    if (now - ts > CACHE_TTL_MS) processedIds.delete(id);
  }
  if (processedIds.size > MAX_CACHE) {
    const toDelete = processedIds.size - MAX_CACHE;
    let i = 0;
    for (const k of processedIds.keys()) {
      processedIds.delete(k);
      if (++i >= toDelete) break;
    }
  }
}

// ====== Pausa POR CONVERSACIÓN con TTL (2 horas) ======
const PAUSE_TTL_MS = 2 * 60 * 60 * 1000; // 2h
const pausedChats = new Map<string, number>(); // chatJid -> timestamp (ms)

function gcPaused() {
  const now = Date.now();
  for (const [jid, ts] of pausedChats) {
    if (now - ts >= PAUSE_TTL_MS) pausedChats.delete(jid);
  }
}
function isPaused(jid: string): boolean {
  const ts = pausedChats.get(jid);
  if (!ts) return false;
  if (Date.now() - ts >= PAUSE_TTL_MS) {
    pausedChats.delete(jid); // expiró: auto reanudar
    return false;
  }
  return true;
}

// ====== Bienvenida 1 vez por día ======
const dailyWelcome = new Map<string, string>(); // chatJid -> 'YYYY-MM-DD'
function todayStr() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}
function shouldSendDailyWelcome(jid: string): boolean {
  const t = todayStr();
  const prev = dailyWelcome.get(jid);
  if (prev === t) return false;
  dailyWelcome.set(jid, t);
  return true;
}
const WELCOME_TEXT = 'Bienvenido a Herbalis. Estoy para asesorarte 🙂';

// ==== NUEVO (batch): buffer por chat con debounce de 10s ====
type Pending = { parts: string[]; timer?: NodeJS.Timeout };
const pendingByChat = new Map<string, Pending>();

async function processBatch(sock: ReturnType<typeof makeWASocket>, chatJid: string) {
  const pending = pendingByChat.get(chatJid);
  if (!pending) return;
  pendingByChat.delete(chatJid);

  const combinedText = pending.parts.join(' ').trim();
  if (!combinedText) return;

  // Presencia
  try {
    await sock.presenceSubscribe(chatJid);
    await sock.sendPresenceUpdate('composing', chatJid);
    setTimeout(() => { void sock.sendPresenceUpdate('paused', chatJid); }, 600);
  } catch {}

  // Bienvenida diaria (imagen + texto)
  if (shouldSendDailyWelcome(chatJid)) {
    const welcome = pickUrl('generic');
    if (welcome?.url) {
      await delay(REPLY_DELAY_MS);
      await sock.sendMessage(chatJid, { image: { url: welcome.url }, caption: WELCOME_TEXT });
    } else {
      await delay(REPLY_DELAY_MS);
      await sock.sendMessage(chatJid, { text: WELCOME_TEXT });
    }
    // seguimos con la respuesta normal
  }

  // Intención para combo de imagen + IA basados en TODO el batch
  const productKind = parseProductKind(combinedText);
  const medicalKind =
    (/\bdiabetes\b/i.test(combinedText)) ? 'diabetes'
    : (/\bhipo?tiroidismo\b/i.test(combinedText)) ? 'hipotiroidismo'
    : (/\bhiper?tiroidismo\b/i.test(combinedText)) ? 'hipertiroidismo'
    : null;
  const onlyNuezInstr = wantsNuezInstructions(combinedText);

  let comboImageKind: ImgKind | null = null;
  if (medicalKind) comboImageKind = medicalKind as ImgKind;
  else if (onlyNuezInstr) comboImageKind = 'dosificar';
  else if (productKind) comboImageKind = productKind;

  // Llamada IA con el texto combinado
  const reply = await aiReply(combinedText, chatJid);

  // Imagen combinada (si aplica)
  if (comboImageKind) {
    const chosen = pickUrl(comboImageKind);
    if (chosen?.url) {
      try {
        await delay(REPLY_DELAY_MS);
        await sock.sendMessage(chatJid, { image: { url: chosen.url }, caption: chosen.caption });
      } catch {
        try {
          const buf = await fetchImageBuffer(chosen.url!);
          await delay(REPLY_DELAY_MS);
          await sock.sendMessage(chatJid, { image: buf, caption: chosen.caption });
        } catch {
          // si falla la imagen, seguimos con el texto IA
        }
      }
    }
  }

  // Texto IA final (una sola respuesta)
  await delay(REPLY_DELAY_MS);
  await sock.sendMessage(chatJid, { text: reply });

  // /foto ... manual (si lo incluyó en el batch, lo mandamos extra)
  const fotoCmd = normalize(combinedText).match(/^\/?foto\s+(semillas|capsulas|gotas|diabetes|hipotiroidismo|hipertiroidismo|dosificar)\b/);
  if (fotoCmd?.[1]) {
    const extraKind = fotoCmd[1] as ImgKind;
    const extra = pickUrl(extraKind);
    if (extra?.url) {
      try {
        await delay(REPLY_DELAY_MS);
        await sock.sendMessage(chatJid, { image: { url: extra.url }, caption: extra.caption });
      } catch {
        try {
          const buf = await fetchImageBuffer(extra.url!);
          await delay(REPLY_DELAY_MS);
          await sock.sendMessage(chatJid, { image: buf, caption: extra.caption });
        } catch {
          await delay(REPLY_DELAY_MS);
          await sock.sendMessage(chatJid, { text: 'No pude enviar esa imagen ahora.' });
        }
      }
    } else {
      await delay(REPLY_DELAY_MS);
      await sock.sendMessage(chatJid, { text: 'No tengo esa imagen configurada.' });
    }
  }
}

function enqueueMessageForChat(sock: ReturnType<typeof makeWASocket>, chatJid: string, text: string) {
  const existing = pendingByChat.get(chatJid);
  if (!existing) {
    const p: Pending = { parts: [text] };
    p.timer = setTimeout(() => { void processBatch(sock, chatJid); }, REPLY_DELAY_MS);
    pendingByChat.set(chatJid, p);
  } else {
    existing.parts.push(text);
    if (existing.timer) clearTimeout(existing.timer);
    existing.timer = setTimeout(() => { void processBatch(sock, chatJid); }, REPLY_DELAY_MS);
  }
}

// ================================================

export async function iniciarWhatsApp() {
  // Unificar carpeta de sesión por env si la definiste
  const AUTH_DIR =
    process.env.WA_AUTH_DIR?.trim() ||
    process.env.WA_SESSION_DIR?.trim() ||
    path.join(process.cwd(), 'auth');

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false
  });

  console.log(`[AUTH] usando carpeta de sesión: ${AUTH_DIR}`);

  // Conexión/QR/Reintento
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
      // GC de pausas vencidas
      gcPaused();

      // Solo nuevos (notify)
      if (m.type !== 'notify') return;

      const msg = m.messages?.[0];
      if (!msg || !msg.message) return;

      const chatJid = jidNormalizedUser(msg.key.remoteJid || '');
      if (!chatJid || chatJid === 'status@broadcast') return;

      const fromMe = !!msg.key.fromMe;
      const text = getTextFromMessage(msg.message).trim();
      if (!text) return;

      // ======= 1) Comandos owner-only muy temprano =======
      if (fromMe) {
        const t = normalize(text);

        // Pausar este chat por 2h
        if (/^\/?\s*bot(?:-|\s*)pause\b/.test(t)) {
          pausedChats.set(chatJid, Date.now());
          try { await sock.presenceSubscribe(chatJid); await sock.sendPresenceUpdate('composing', chatJid); setTimeout(() => { void sock.sendPresenceUpdate('paused', chatJid); }, 600); } catch {}
          await delay(REPLY_DELAY_MS);
          await sock.sendMessage(chatJid, { text: '🛑 Bot pausado aquí por 2 horas. Mandá "bot-play" en este chat para reanudar antes.' });
          return;
        }

        // Reanudar manualmente este chat
        if (/^\/?\s*bot(?:-|\s*)play\b/.test(t)) {
          const wasPaused = pausedChats.delete(chatJid);
          try { await sock.presenceSubscribe(chatJid); await sock.sendPresenceUpdate('composing', chatJid); setTimeout(() => { void sock.sendPresenceUpdate('paused', chatJid); }, 600); } catch {}
          await delay(REPLY_DELAY_MS);
          await sock.sendMessage(chatJid, { text: wasPaused ? '▶️ Bot reanudado en este chat.' : '▶️ El bot ya estaba activo en este chat.' });
          return;
        }

        // Si el mensaje es mío y no es comando → no auto-responderme
        return;
      }

      // ======= 2) Chequeo de pausa ULTRA-TEMPRANO =======
      if (isPaused(chatJid)) return;

      // ======= 3) Deduplicación =======
      const messageId = msg.key.id || `${chatJid}:${Date.now()}`;
      if (processedIds.has(messageId)) return;
      processedIds.set(messageId, Date.now());
      gcProcessedIds();

      // ======= 4) NUEVO: Encolar y “debouncear” por chat (respuesta única)
      enqueueMessageForChat(sock, chatJid, text);

      // Nota: ya no respondemos acá; la respuesta sale desde processBatch()
      // después de REPLY_DELAY_MS sin nuevos mensajes del usuario.

    } catch (err) {
      console.error('Error en messages.upsert:', err);
    }
  });

  return sock;
}
