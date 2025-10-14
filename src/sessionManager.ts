import fs from 'fs';
import path from 'path';

const WORKDIR = process.cwd();

const ENV_SESSION_DIR = process.env.WA_SESSION_DIR?.trim();
const ENV_AUTH_DIR = process.env.WA_AUTH_DIR?.trim();

const SESSION_DIR = ENV_SESSION_DIR || path.join(WORKDIR, '.wadata');
const AUTH_DIR = ENV_AUTH_DIR || ENV_SESSION_DIR || path.join(WORKDIR, 'auth');

function safeRm(target: string) {
  try {
    if (!target) return;
    if (!fs.existsSync(target)) return;
    fs.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    console.warn('[SESSION] No se pudo eliminar', target, err);
  }
}

export function getSessionDir() {
  return SESSION_DIR;
}

export function getAuthDir() {
  return AUTH_DIR;
}

export function ensureSessionDirs() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

export function clearSessionData() {
  safeRm(AUTH_DIR);
  if (AUTH_DIR !== SESSION_DIR) {
    safeRm(SESSION_DIR);
  }
}
