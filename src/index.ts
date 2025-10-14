import { cfg } from './config.js';
import { createRoutes } from './routes.js';
import { iniciarWhatsApp } from './wa.js';
import { acquireProcessLock, releaseProcessLock } from './lock.js' ;
import { clearSessionData, ensureSessionDirs, getSessionDir } from './sessionManager.js';
import { closeMongo } from './db.js';

async function main() {
  const sessionDir = getSessionDir();
  ensureSessionDirs();
  console.log(`[SESSION] usando carpeta: ${sessionDir}`);

  const { ok, lockPath } = acquireProcessLock(sessionDir);
  if (!ok) {
    console.error('Ya hay otra instancia usando esta sesión. Cerrando.');
    process.exit(1);
  }
  const release = () => {
    try { releaseProcessLock(lockPath); } catch {}
    try { clearSessionData(); } catch {}
    closeMongo().catch(() => {});
  };
  process.on('exit', release);
  process.on('SIGINT', () => { release(); process.exit(0); });
  process.on('SIGTERM', () => { release(); process.exit(0); });

  const app = createRoutes();
  app.listen(cfg.PORT, () => console.log(`🌐 HTTP en :${cfg.PORT} | /health`));

  await iniciarWhatsApp();
  console.log('🤖 Bot WhatsApp iniciado con Baileys');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
