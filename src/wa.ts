import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  jidNormalizedUser,
  proto
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { aiReply } from './ai.js';
import { cfg } from './config.js';
import QRCode from 'qrcode';
import * as fs from 'fs';
import * as path from 'path';

// ====== Detección de solicitud de imagen ======
type ImgKind = 'semillas' | 'capsulas' | 'gotas' | 'generic';

function parseImageRequest(raw: string): ImgKind | null {
  const t = (raw || '').toLowerCase().trim();

  // pedidos explícitos
  const asked =
    /(^|\b)(imagen|foto|mostrame|mandame|enviame|pasame)\b/.test(t) ||
    /\b(ver|muestra|mostra)\b.*\b(foto|imagen)\b/.test(t);

  if (!asked) return null;

  // categorías
  if (/\bsemilla(s)?\b/.test(t)) return 'semillas';
  if (/\bc[aá]psula(s)?\b/.test(t)) return 'capsulas';
  if (/\bgota(s)?\b/.test(t)) return 'gotas';

  return 'generic';
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

// ====== Anti-duplicados (unchanged) ======
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
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false
  });

  // Conexión/QR/Reintento
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('Escaneá este QR para vincular tu sesión:');
      qrcode.generate(qr, { small: true });

      // Guardar PNG en /public/qr.png
     const qrPath = path.join(process.cwd(), 'public', 'qr.png');
     await QRCode.toFile(qrPath, qr, { margin: 2, width: 300 });
     console.log(`QR actualizado en ${qrPath}`);

    }

    if (connection === 'open') {
      console.log('✅ Conectado a WhatsApp');
    } else if (connection === 'close') {
      const code = (lastDisconnect?.error as any)?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.warn('Conexión cerrada. Código:', code, 'Reintentar:', shouldReconnect);
      if (shouldReconnect) void iniciarWhatsApp();
      else console.error('Sesión cerrada (logged out). Borra ./auth para re-vincular.');
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

      // ====== NUEVO: Sólo enviar imágenes si el usuario las pide ======
      const imgKind = parseImageRequest(text);
      if (imgKind) {
        // Mapas a tus URLs configuradas
        const map: Record<ImgKind, { url?: string; caption: string }> = {
          semillas: { url: cfg.IMG1, caption: 'Semillas – presentación de referencia' },
          capsulas: { url: cfg.IMG2, caption: 'Cápsulas – presentación de referencia' },
          gotas:    { url: cfg.IMG3, caption: 'Gotas – presentación de referencia' },
          generic:  { url: cfg.IMG1 || cfg.IMG2 || cfg.IMG3, caption: 'Presentación de referencia' }
        };

        const chosen = map[imgKind];
        if (chosen.url) {
          await sock.sendMessage(from, { image: { url: chosen.url }, caption: chosen.caption });
        } else {
          // Si no hay URL configurada, responde con texto aclaratorio
          await sock.sendMessage(from, { text: 'Por ahora no tengo una imagen cargada para esa presentación. ¿Querés que te comparta info en texto?' });
        }
        return; // IMPORTANTE: no responder también con IA
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
