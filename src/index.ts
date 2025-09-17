import { cfg } from './config';
import { createRoutes } from './routes';
import { createWA } from './wa';

async function main() {
  const app = createRoutes();
  app.listen(cfg.PORT, () => console.log(`🌐 HTTP en :${cfg.PORT} | /health | /qr`));

  const wa = createWA();
  await wa.initialize();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
