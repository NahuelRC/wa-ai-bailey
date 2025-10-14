// routes.ts
import express, { NextFunction, Request, Response, RequestHandler } from 'express';
import path from 'path';

import { cfg } from './config.js';
import { signJwt, verifyJwt } from './jwt.js';
import {
  createUser,
  findUserById,
  findUserByUsername,
  toPublicUser,
  updateUserPrompt,
  verifyUserPassword,
} from './userStore.js';
import type { StoredUser } from './userStore.js';
import { clearSessionData, ensureSessionDirs } from './sessionManager.js';
import { getNextAllowedUpdateAt, getWhatsAppQr, MIN_REFRESH_MS } from './qrState.js';
import { iniciarWhatsApp, logoutWhatsApp, isConversationPaused, setConversationPaused } from './wa.js';
import { ensureSystemPromptInitialized, loadSystemPrompt, saveSystemPrompt } from './promptStore.js';
import { invalidateSystemPromptCache } from './ai.js';
import { listConversationsForUser, getConversationForUser, setConversationPausedInDb } from './conversationStore.js';

interface AuthenticatedRequest extends Request {
  authUserId?: string;
  authUser?: StoredUser;
}

function sendError(res: Response, status: number, message: string) {
  res.status(status).json({ ok: false, message });
}

function createToken(userId: string, username: string) {
  const expiresInSeconds = cfg.JWT_EXPIRES_IN_HOURS * 3600;
  return signJwt({ sub: userId, username }, cfg.JWT_SECRET, expiresInSeconds);
}

const requireAuth: RequestHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return sendError(res, 401, 'Token no provisto');
    }

    const token = header.slice('Bearer '.length).trim();
    const result = verifyJwt(token, cfg.JWT_SECRET);
    if (!result.valid) {
      return sendError(res, 401, result.error);
    }

    const user = await findUserById(result.payload.sub);
    if (!user) {
      return sendError(res, 401, 'Usuario no encontrado');
    }

    req.authUserId = user.id;
    req.authUser = user;
    next();
  } catch (err) {
    console.error('Error en autenticación', err);
    sendError(res, 500, 'Error de autenticación');
  }
};

export function createRoutes() {
  const app = express();

  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => res.send('ok'));

  app.post('/api/register', async (req: Request, res: Response) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || username.trim().length < 3) {
      return sendError(res, 400, 'El usuario debe tener al menos 3 caracteres');
    }
    if (typeof password !== 'string' || password.length < 6) {
      return sendError(res, 400, 'La contraseña debe tener al menos 6 caracteres');
    }

    try {
      const user = await createUser(username.trim(), password);
      const token = createToken(user.id, user.username);
      res.status(201).json({ ok: true, token, user: toPublicUser(user) });
    } catch (err) {
      if (err instanceof Error && err.message.includes('existe')) {
        return sendError(res, 409, err.message);
      }
      return sendError(res, 500, 'No se pudo crear el usuario');
    }
  });

  app.post('/api/login', async (req: Request, res: Response) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      return sendError(res, 400, 'Credenciales inválidas');
    }

    const user = await findUserByUsername(username.trim());
    if (!user) {
      return sendError(res, 401, 'Usuario o contraseña incorrectos');
    }

    if (!(await verifyUserPassword(user, password))) {
      return sendError(res, 401, 'Usuario o contraseña incorrectos');
    }

    const token = createToken(user.id, user.username);
    res.json({ ok: true, token, user: toPublicUser(user) });
  });

  app.get('/api/me', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const user = req.authUser as StoredUser;
    res.json({ ok: true, user: toPublicUser(user) });
  });

  app.get('/api/me/qr', requireAuth, (_req: AuthenticatedRequest, res: Response) => {
    const current = getWhatsAppQr();
    if (!current) {
      return sendError(res, 503, 'QR no disponible todavía');
    }
    res.json({
      ok: true,
      qr: current.dataUrl,
      format: 'image',
      updatedAt: current.updatedAt,
      nextRefreshAt: getNextAllowedUpdateAt(),
      minRefreshMs: MIN_REFRESH_MS,
    });
  });

  app.put('/api/me/prompt', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const user = req.authUser as StoredUser;
    const { prompt } = req.body ?? {};
    if (typeof prompt !== 'string') {
      return sendError(res, 400, 'Prompt inválido');
    }

    const cleanPrompt = prompt.trim();
    const updated = await updateUserPrompt(user.id, cleanPrompt);
    if (!updated) {
      return sendError(res, 500, 'No se pudo actualizar el prompt');
    }

    try {
      await saveSystemPrompt(cleanPrompt, user.id);
      invalidateSystemPromptCache(user.id);
    } catch (err) {
      console.error('No se pudo actualizar el prompt del sistema en Mongo', err);
    }

    res.json({ ok: true, user: toPublicUser(updated) });
  });

  app.get('/api/prompt/system', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.authUser as StoredUser;
      await ensureSystemPromptInitialized(user.id);
      const prompt = await loadSystemPrompt(user.id);
      res.json({ ok: true, prompt });
    } catch (err) {
      console.error('No se pudo cargar el prompt del sistema', err);
      sendError(res, 500, 'No se pudo cargar el prompt del sistema');
    }
  });

  app.get('/api/conversations', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.authUser as StoredUser;
      const conversations = await listConversationsForUser(user.id);
      const payload = conversations.map(conv => {
        const phone = conv.phone;
        const phoneNumber = phone?.includes('@') ? phone.split('@')[0] : phone;
        const lastTurn = conv.lastTurn;
        const lastMessage = lastTurn?.aiText || lastTurn?.userText || '';
        const lastDirection = lastTurn?.aiText ? 'assistant' : lastTurn?.userText ? 'user' : null;
        const updatedAt = conv.updatedAt ? conv.updatedAt.toISOString() : null;
        const createdAt = conv.createdAt ? conv.createdAt.toISOString() : null;
        const storedPaused = conv.paused ?? false;
        return {
          phone,
          phoneNumber,
          lastMessage,
          lastDirection,
          updatedAt,
          createdAt,
          paused: storedPaused,
          runtimePaused: phone ? isConversationPaused(phone) : storedPaused,
        };
      });
      res.json({ ok: true, conversations: payload });
    } catch (err) {
      console.error('No se pudieron listar conversaciones', err);
      sendError(res, 500, 'No se pudieron listar las conversaciones');
    }
  });

  app.post('/api/conversations/toggle', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { phone, paused } = req.body ?? {};
      if (typeof phone !== 'string' || !phone.trim()) {
        return sendError(res, 400, 'Conversación inválida');
      }
      const phoneId = phone.trim();
      const user = req.authUser as StoredUser;
      const convo = await getConversationForUser(user.id, phoneId);
      if (!convo) {
        return sendError(res, 404, 'Conversación no encontrada');
      }

      const shouldPause = paused === true || paused === 'true' || paused === 1 || paused === '1';
      const saved = await setConversationPausedInDb(user.id, phoneId, shouldPause);
      if (!saved) {
        return sendError(res, 500, 'No se pudo actualizar la conversación');
      }

      setConversationPaused(phoneId, shouldPause);
      res.json({ ok: true, phone: phoneId, paused: shouldPause, runtimePaused: isConversationPaused(phoneId) });
    } catch (err) {
      console.error('No se pudo actualizar el estado de la conversación', err);
      sendError(res, 500, 'No se pudo actualizar la conversación');
    }
  });

  app.post('/api/logout', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
    try {
      await logoutWhatsApp();
      clearSessionData();
      ensureSessionDirs();
      iniciarWhatsApp().catch(err => console.error('No se pudo reiniciar WhatsApp', err));
      res.json({ ok: true });
    } catch (err) {
      console.error('Error al cerrar sesión', err);
      sendError(res, 500, 'No se pudo cerrar sesión');
    }
  });

  // Servir carpeta public (incluye la app web)
  const publicDir = path.join(process.cwd(), 'public');
  app.use(express.static(publicDir));

  app.use((_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  return app;
}
