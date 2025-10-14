import { getMongoDb, hasMongoConfig } from './db.js';
import { cfg } from './config.js';
import { defaultSystemPrompt } from './prompts/defaultSystemPrompt.js';

const PROMPT_COLLECTION = 'prompts';

interface PromptDocument {
  _id: string;
  userId: string;
  content: string;
  updatedAt?: Date;
}

function resolvePromptId(userId?: string) {
  const trimmed = userId?.trim();
  if (trimmed) return trimmed;
  return cfg.MONGO_PROMPT_ID?.trim() || 'global';
}

export async function getSystemPromptFromDb(userId?: string): Promise<string | null> {
  if (!hasMongoConfig()) return null;
  try {
    const db = await getMongoDb();
    const collection = db.collection<PromptDocument>(PROMPT_COLLECTION);
    const doc = await collection.findOne({ _id: resolvePromptId(userId) });
    return doc?.content ?? null;
  } catch (err) {
    console.error('No se pudo obtener el prompt desde Mongo:', err);
    return null;
  }
}

export async function ensureSystemPromptInitialized(userId?: string) {
  if (!hasMongoConfig()) return;
  try {
    const db = await getMongoDb();
    const collection = db.collection<PromptDocument>(PROMPT_COLLECTION);
    const promptId = resolvePromptId(userId);
    await collection.updateOne(
      { _id: promptId },
      { $setOnInsert: { content: defaultSystemPrompt, updatedAt: new Date(), userId: promptId } },
      { upsert: true }
    );
  } catch (err) {
    console.error('No se pudo inicializar el prompt en Mongo:', err);
  }
}

export async function saveSystemPrompt(content: string, userId?: string) {
  if (!hasMongoConfig()) {
    throw new Error('MongoDB no está configurado');
  }
  const db = await getMongoDb();
  const collection = db.collection<PromptDocument>(PROMPT_COLLECTION);
  const promptId = resolvePromptId(userId);
  await collection.updateOne(
    { _id: promptId },
    { $set: { content, updatedAt: new Date(), userId: promptId } },
    { upsert: true }
  );
}

export async function loadSystemPrompt(userId?: string): Promise<string> {
  const fromDb = await getSystemPromptFromDb(userId);
  return fromDb?.trim() ? fromDb : defaultSystemPrompt;
}
