"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createWA = createWA;
const whatsapp_web_js_1 = require("whatsapp-web.js");
const puppeteer_1 = __importDefault(require("puppeteer"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const ai_1 = require("./ai");
const config_1 = require("./config");
// Evita que Chrome escriba chrome_debug.log (lock en Windows)
if (process.platform === 'win32') {
    process.env.CHROME_LOG_FILE = 'NUL';
}
function createWA() {
    const client = new whatsapp_web_js_1.Client({
        authStrategy: new whatsapp_web_js_1.LocalAuth({
            dataPath: './.wadata',
            clientId: 'default',
            rmMaxRetries: 15, // <-- mantenemos este
            // rmRetryDelay: 500, // <-- quitar, tu tipo no lo soporta
        }),
        puppeteer: {
            headless: true,
            executablePath: puppeteer_1.default.executablePath(),
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-extensions',
                '--no-first-run',
                '--no-default-browser-check',
            ],
        },
    });
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
    client.on('message', async (msg) => {
        try {
            const text = (msg.body || '').trim();
            const t = text.toLowerCase();
            if (t.includes('semillas')) {
                if (config_1.cfg.IMG1) {
                    const media = await whatsapp_web_js_1.MessageMedia.fromUrl(config_1.cfg.IMG1);
                    await client.sendMessage(msg.from, media, { caption: 'semillas ✅' });
                }
                else {
                    await msg.reply('No tengo configurada IMG1_URL en el .env');
                }
                return;
            }
            if (t.includes('gotas')) {
                if (config_1.cfg.IMG2) {
                    const media = await whatsapp_web_js_1.MessageMedia.fromUrl(config_1.cfg.IMG2);
                    await client.sendMessage(msg.from, media, { caption: 'gotas ✅' });
                }
                else {
                    await msg.reply('No tengo configurada IMG2_URL en el .env');
                }
                return;
            }
            if (t.includes('pastillas')) {
                if (config_1.cfg.IMG3) {
                    const media = await whatsapp_web_js_1.MessageMedia.fromUrl(config_1.cfg.IMG3);
                    await client.sendMessage(msg.from, media, { caption: 'pastillas ✅' });
                }
                else {
                    await msg.reply('No tengo configurada IMG3_URL en el .env');
                }
                return;
            }
            const reply = await (0, ai_1.aiReply)(text, msg.from);
            if (reply)
                await msg.reply(reply);
        }
        catch (e) {
            console.error('Error en handler:', e);
            try {
                await msg.reply('Ups, hubo un problema. Intentá de nuevo.');
            }
            catch { }
        }
    });
    // Cierre limpio: evita logout (que intenta borrar la sesión)
    process.on('SIGINT', async () => {
        try {
            await client.destroy();
        }
        finally {
            process.exit(0);
        }
    });
    return client;
}
//# sourceMappingURL=wa.js.map