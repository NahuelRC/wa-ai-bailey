// routes.ts
import express from 'express';
import path from 'path';

export function createRoutes() {
  const app = express();

  app.get('/health', (_req, res) => res.send('ok'));

  // Servir carpeta public (qr.png estará ahí)
  app.use(express.static(path.join(process.cwd(), 'public')));

  // Endpoint /qr (redirige a la imagen)
  app.get('/qr', (_req, res) => {
    res.send(`
      <html>
        <body style="display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;font-family:sans-serif;">
          <h2>Escaneá este QR en WhatsApp</h2>
          <img src="/qr.png" alt="QR de WhatsApp" />
        </body>
      </html>
    `);
  });

  return app;
}
