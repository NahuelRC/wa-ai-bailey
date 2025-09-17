import { Client, LocalAuth, MessageMedia } from 'whatsapp-web.js';
import puppeteer from 'puppeteer';
import * as fs from 'fs';
import * as path from 'path';
import { aiReply } from './ai';
import { cfg } from './config';

// ---------- Guardrails / Anti-ban ----------
const STOP_RE = /^(STOP|BAJA|ALTO|CANCELAR)$/i;
const HUMANO_RE = /^(HUMANO|AGENTE|ASESOR)$/i;

const lastReplyAt = new Map<string, number>(); // rate-limit por contacto
const REPLY_COOLDOWN_MS = 5000; // 5s entre respuestas por contacto
const BUSINESS_HOURS = { start: 9, end: 21 }; // horario local (AR aprox.)

function isBusinessHours(d = new Date()) {
  const h = d.getHours();
  return h >= BUSINESS_HOURS.start && h < BUSINESS_HOURS.end;
}
function canReplyNow(jid: string) {
  const now = Date.now();
  const last = lastReplyAt.get(jid) ?? 0;
  if (now - last < REPLY_COOLDOWN_MS) return false;
  lastReplyAt.set(jid, now);
  return true;
}
function sleep(ms: number) {
  return new Promise(res => setTimeout(res, ms));
}
function humanJitter() {
  // 1.2s a 3.5s para parecer humano
  return 1200 + Math.floor(Math.random() * 2300);
}

// ---------- Admin whitelist ----------
function normPhone(input: string) {
  return (input || '').replace(/\D/g, ''); // deja solo dígitos
}
const ADMIN_SET = new Set(
  (process.env.ADMIN_WHITELIST || '')
    .split(',')
    .map(s => normPhone(s))
    .filter(Boolean)
);

// Devuelve true si el JID (ej: 549341xxxxx@c.us) está en la whitelist
function isAdminJid(jid: string) {
  const num = normPhone(jid?.split('@')[0] || '');
  return ADMIN_SET.has(num);
}

// ¿Está autorizado a ejecutar comandos admin?
function isAuthorizedAdminAction(senderJid: string | undefined, fromMe: boolean) {
  // Si el mensaje lo enviaste vos (fromMe=true), siempre permitido.
  // Además, permitimos que NÚMEROS en ADMIN_WHITELIST puedan mandar comandos por chat directo.
  return !!fromMe || (senderJid ? isAdminJid(senderJid) : false);
}

// ---------- Mute automático (2 horas) + Mute manual (BOT OFF/ON) ----------
const mutedUntil = new Map<string, number>(); // jid -> timestamp ms (mute temporal)
const manualMute = new Set<string>();         // jid -> mute indefinido (BOT OFF)
const outgoingBotMsgIds = new Set<string>();  // ids salientes enviados por el bot (para no disparar mute humano)

function isMuted(jid: string) {
  if (manualMute.has(jid)) return true;
  const until = mutedUntil.get(jid);
  if (!until) return false;
  if (Date.now() < until) return true;
  mutedUntil.delete(jid);
  return false;
}
function markBotSentId(id: string | undefined) {
  if (id) outgoingBotMsgIds.add(id);
}
function fmt(ts?: number) {
  return ts ? new Date(ts).toLocaleString() : '-';
}

// Evita que Chrome escriba chrome_debug.log (locks en Windows)
if (process.platform === 'win32') {
  process.env.CHROME_LOG_FILE = 'NUL';
}

export function createWA() {
  const client = new Client({
    authStrategy: new LocalAuth({
      dataPath: './.wadata',
      clientId: 'default',
      rmMaxRetries: 15
    }),
    puppeteer: {
      headless: true,                              // compatible con tu versión
      executablePath: puppeteer.executablePath(),  // usa el Chromium de puppeteer
      args: [
        '--headless=new', // activa headless moderno si está disponible
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--no-first-run',
        '--no-default-browser-check'
      ]
    }
  });

  // ---- QR como PNG para /qr
  client.on('qr', async (qr) => {
    const { toDataURL } = await import('qrcode');
    const pubDir = path.join(process.cwd(), 'public');
    fs.mkdirSync(pubDir, { recursive: true });

    const file = path.join(pubDir, 'qr.png');
    const dataUrl = await toDataURL(qr);
    const base64 = dataUrl.split(',')[1];
    fs.writeFileSync(file, Buffer.from(base64, 'base64'));
    console.log('📷 QR actualizado → GET /qr');
  });

  client.on('ready', () => {
    console.log('🤖 Bot listo. WhatsApp Web puede usarse en paralelo (multi-device).');
  });

  client.on('disconnected', (reason) => {
    console.log('⚠️ Desconectado:', reason);
  });

  // ---- Comandos admin + detección de intervención HUMANA (fromMe)
  client.on('message_create', async (msg) => {
    try {
      // Solo nos interesan mensajes "fromMe" (enviados por el cliente)
      if (!msg.fromMe) return;

      const anyMsg: any = msg as any;
      const id = anyMsg?.id?._serialized ?? anyMsg?.id?.id ?? '';
      const jid = (msg.to || msg.from) as string;
      const text = (msg.body || '').trim();

      // Si este id lo envió el BOT, no dispare el mute ni procese comandos
      if (id && outgoingBotMsgIds.has(id)) {
        outgoingBotMsgIds.delete(id);
        return;
      }

      // Comandos admin (permitidos por ser fromMe)
      if (/^BOT\s*OFF$/i.test(text)) {
        manualMute.add(jid);
        mutedUntil.delete(jid);
        const sent = await client.sendMessage(jid, '🔇 Bot desactivado en este chat (mute manual). Usa "BOT ON" para reactivar.');
        markBotSentId((sent as any)?.id?._serialized);
        return; // no apliques mute 2h adicional
      }
      if (/^BOT\s*ON$/i.test(text)) {
        manualMute.delete(jid);
        mutedUntil.delete(jid);
        const sent = await client.sendMessage(jid, '🔔 Bot reactivado en este chat.');
        markBotSentId((sent as any)?.id?._serialized);
        return;
      }
      if (/^BOT\s*STATUS$/i.test(text)) {
        const manual = manualMute.has(jid);
        const until = mutedUntil.get(jid);
        const status = manual ? 'MUTE MANUAL (BOT OFF)' : (until && Date.now() < until ? `MUTE TEMPORAL hasta ${fmt(until)}` : 'ACTIVO');
        const sent = await client.sendMessage(jid, `ℹ️ Estado del bot aquí: ${status}`);
        markBotSentId((sent as any)?.id?._serialized);
        return;
      }

      // Intervención humana normal → mute temporal 2h
      const until = Date.now() + 2 * 60 * 60 * 1000;
      mutedUntil.set(jid, until);
      console.log(`🧑‍💻 Intervención humana en ${jid}. Bot muteado hasta ${fmt(until)}`);
    } catch (e) {
      console.error('message_create handler error', e);
    }
  });

  // ---- Entrantes (de clientes y/o admins por chat directo)
  client.on('message', async (msg) => {
    try {
      // Ignorar grupos y estados
      if (msg.from.endsWith('@g.us') || msg.from === 'status@broadcast') return;

      const text = (msg.body || '').trim();

      // === Comandos admin desde números whitelisted (en chat directo) ===
      if (/^BOT\s*(OFF|ON|STATUS)$/i.test(text) && isAuthorizedAdminAction(msg.from, false)) {
        if (/^BOT\s*OFF$/i.test(text)) {
          manualMute.add(msg.from);
          mutedUntil.delete(msg.from);
          const sent = await msg.reply('🔇 Bot desactivado en este chat (mute manual). Usa "BOT ON" para reactivar.');
          markBotSentId((sent as any)?.id?._serialized);
          return;
        }
        if (/^BOT\s*ON$/i.test(text)) {
          manualMute.delete(msg.from);
          mutedUntil.delete(msg.from);
          const sent = await msg.reply('🔔 Bot reactivado en este chat.');
          markBotSentId((sent as any)?.id?._serialized);
          return;
        }
        if (/^BOT\s*STATUS$/i.test(text)) {
          const manual = manualMute.has(msg.from);
          const until = mutedUntil.get(msg.from);
          const status = manual ? 'MUTE MANUAL (BOT OFF)' : (until && Date.now() < until ? `MUTE TEMPORAL hasta ${fmt(until)}` : 'ACTIVO');
          const sent = await msg.reply(`ℹ️ Estado del bot aquí: ${status}`);
          markBotSentId((sent as any)?.id?._serialized);
          return;
        }
      }

      // Mute por intervención humana o BOT OFF
      if (isMuted(msg.from)) return;

      // Opt-out / Handoff
      if (STOP_RE.test(text)) {
        const sent = await msg.reply('Hecho. No recibirás más respuestas automáticas. Si necesitás algo, escribí HUMANO.');
        markBotSentId((sent as any)?.id?._serialized);
        return;
      }
      if (HUMANO_RE.test(text)) {
        const sent = await msg.reply('Te derivo con un asesor. ¡Gracias! 🙌');
        markBotSentId((sent as any)?.id?._serialized);
        // Opcional: mutea temporalmente también
        mutedUntil.set(msg.from, Date.now() + 2 * 60 * 60 * 1000);
        return;
      }

      // Horario de atención (puedes desactivar si no lo querés)
      if (!isBusinessHours()) {
        const sent = await msg.reply('¡Gracias por escribir! Te respondemos dentro del horario de atención (9 a 21).');
        markBotSentId((sent as any)?.id?._serialized);
        return;
      }

      // Rate-limit
      if (!canReplyNow(msg.from)) return;

      // Jitter humano
      await sleep(humanJitter());

      // --- Triggers de imágenes
      const t = text.toLowerCase();
      if (t.includes('imagen1')) {
        if (cfg.IMG1) {
          const media = await MessageMedia.fromUrl(cfg.IMG1);
          const sent = await client.sendMessage(msg.from, media, { caption: 'Semillas ✅' });
          markBotSentId((sent as any)?.id?._serialized);
        } else {
          const sent = await msg.reply('No tengo configurada IMG1_URL en el .env');
          markBotSentId((sent as any)?.id?._serialized);
        }
        return;
      }
      if (t.includes('imagen2')) {
        if (cfg.IMG2) {
          const media = await MessageMedia.fromUrl(cfg.IMG2);
          const sent = await client.sendMessage(msg.from, media, { caption: 'Gotas ✅' });
          markBotSentId((sent as any)?.id?._serialized);
        } else {
          const sent = await msg.reply('No tengo configurada IMG2_URL en el .env');
          markBotSentId((sent as any)?.id?._serialized);
        }
        return;
      }
      if (t.includes('imagen3')) {
        if (cfg.IMG3) {
          const media = await MessageMedia.fromUrl(cfg.IMG3);
          const sent = await client.sendMessage(msg.from, media, { caption: 'Capsulas ✅' });
          markBotSentId((sent as any)?.id?._serialized);
        } else {
          const sent = await msg.reply('No tengo configurada IMG3_URL en el .env');
          markBotSentId((sent as any)?.id?._serialized);
        }
        return;
      }

      // --- Respuesta IA por defecto
      const reply = await aiReply(text, msg.from);
      if (reply) {
        const sent = await msg.reply(reply);
        markBotSentId((sent as any)?.id?._serialized);
      }
    } catch (e) {
      console.error('Error en handler:', e);
      try {
        const sent = await msg.reply('Ups, hubo un problema. Intentá de nuevo.');
        markBotSentId((sent as any)?.id?._serialized);
      } catch {}
    }
  });

  // Cierre limpio (no uses logout en dev; borra .wadata manual si querés forzar QR)
  process.on('SIGINT', async () => {
    try {
      await client.destroy();
    } finally {
      process.exit(0);
    }
  });

  return client;
}
