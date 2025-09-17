import express from 'express';
import path from 'path';

export function createRoutes() {
  const app = express();
  app.get('/health', (_, res) => res.json({ ok: true, time: new Date() }));
  app.get('/qr', (req, res) => res.sendFile(path.join(process.cwd(), 'public/qr.png')));
  return app;
}
