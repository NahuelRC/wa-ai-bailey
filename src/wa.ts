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

// ====== Detección de solicitud de imagen ======
type ImgKind = 'semillas' | 'capsulas' | 'gotas' | 'generic';

function parseImageRequest(raw: string): ImgKind | null {
  const t = normalize(raw);

  const hasImageWord = /\b(imagen|imagenes|foto|fotos|picture|pic|photo|📸|🖼️)\b/.test(t);
  const hasAskVerb   = /\b(mostrar|mostrame|mostra|manda|mandame|enviar|enviame|pasa|pasame|ver|quiero|podria|podrias|necesito|ensename|show|send)\b/.test(t);

  if (!(hasImageWord || hasAskVerb)) return null;

  if (/\bsemilla(s)?\b/.test(t)) return 'semillas';
  if (/\bcapsula(s)?\b|\bcaps\b/.test(t)) return 'capsulas';
  if (/\bgota(s)?\b|\bdrop(s)?\b/.test(t)) return 'gotas';

  return 'generic';
}

// ====== Resolver URL según categoría (usa tus variables nuevas) ======
function pickUrl(kind: ImgKind): { url?: string; caption: string } {
  // Tomamos de cfg si existe o directo desde process.env
  const CAPS = (cfg as any).IMG1_CAPSULAS_URL ?? process.env.IMG1_CAPSULAS_URL;
  const SEMI = (cfg as any).IMG2_SEMILLAS_URL ?? process.env.IMG2_SEMILLAS_URL;
  const GOTE = (cfg as any).IMG3_GOTERO_URL   ?? process.env.IMG3_GOTERO_URL;

  const choose = (...cands: (string | undefined)[]) =>
    cands.find(u => !!u && u.trim().length > 0);

  switch (kind) {
    case 'capsulas':
      return { url: choose(CAPS, SEMI, GOTE), caption: 'Cápsulas' };
    case 'semillas':
      return { url: choose(SEMI, CAPS, GOTE), caption: 'Semillas ' };
    case 'gotas':
      return { url: choose(GOTE, CAPS, SEMI), caption: 'Gotas' };
    default:
      return { url: choose(SEMI, CAPS, GOTE), caption: 'Presentación de referencia' };
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
      // Solo nuevos (notify)
      if (m.type !== 'notify') return;

      const msg = m.messages?.[0];
      if (!msg || !msg.message) return;

      // Ignorar propios y status
      if (msg.key.fromMe) return;
      const from = jidNormalizedUser(msg.key.remoteJid || '');
      if (!from || from === 'status@broadcast') return;

      // Deduplicación
      const messageId = msg.key.id || `${from}:${Date.now()}`;
      if (processedIds.has(messageId)) return;
      processedIds.set(messageId, Date.now());
      gcProcessedIds();

      const text = getTextFromMessage(msg.message).trim();
      if (!text) return;

      // Presencia "escribiendo"
      try {
        await sock.presenceSubscribe(from);
        await sock.sendPresenceUpdate('composing', from);
        setTimeout(() => { void sock.sendPresenceUpdate('paused', from); }, 600);
      } catch {}

      // ===== Solicitud de imagen =====
      const imgKind = parseImageRequest(text);

      // Comando explícito: /foto semillas|capsulas|gotas
      const fotoCmd = normalize(text).match(/^\/?foto\s+(semillas|capsulas|gotas)\b/);
      const cmdKind = (fotoCmd?.[1] as ImgKind | undefined) || null;

      const finalKind = imgKind || cmdKind;

      if (finalKind) {
        const chosen = pickUrl(finalKind);

        if (!chosen.url) {
          await sock.sendMessage(from, { text: 'Por ahora no tengo una imagen cargada para esa presentación. ¿Querés que te comparta info en texto?' });
          return; // no llamar a IA
        }

        try {
          // 1) Intento por URL
          await sock.sendMessage(from, { image: { url: chosen.url }, caption: chosen.caption });
        } catch {
          // 2) Reintento con Buffer
          try {
            const buf = await fetchImageBuffer(chosen.url);
            await sock.sendMessage(from, { image: buf, caption: chosen.caption });
          } catch {
            await sock.sendMessage(from, { text: 'No pude enviar la imagen ahora. ¿Te paso la información en texto?' });
          }
        }
        return; // IMPORTANTE: no responder con IA si ya gestionamos imagen
      }

      // Si no pidió imagen → responder con IA (solo texto)
      const reply = await aiReply(text, from);
      await sock.sendMessage(from, { text: reply });

    } catch (err) {
      console.error('Error en messages.upsert:', err);
    }
  });

  return sock;
}
