import { getMongoDb, hasMongoConfig } from './db.js';

const COLLECTION = 'conversations';
const HISTORY_MAX_LENGTH = 100;

export interface ConversationTurn {
  userText: string;
  aiText: string;
  aiMedia?: { url: string; caption?: string }[];
  aiOrder?: Record<string, unknown>;
  createdAt: Date;
}

interface ConversationDocument {
  _id: string;
  userId: string;
  phone: string;
  history?: ConversationTurn[];
  createdAt?: Date;
  updatedAt?: Date;
  paused?: boolean;
}

export interface ConversationSummary {
  phone: string;
  userId: string;
  createdAt?: Date;
  updatedAt?: Date;
  lastTurn?: ConversationTurn;
  paused?: boolean;
}

export async function getConversationForUser(userId: string, phone: string): Promise<ConversationDocument | null> {
  const userKey = userId?.trim() || 'global';
  const phoneId = phone?.trim();
  if (!phoneId) return null;
  if (!hasMongoConfig()) return null;
  try {
    const db = await getMongoDb();
    const collection = db.collection<ConversationDocument>(COLLECTION);
    return await collection.findOne({ userId: userKey, phone: phoneId });
  } catch (err) {
    console.error('No se pudo verificar la conversación en Mongo:', err);
    return null;
  }
}

export async function appendConversationTurn(
  userId: string,
  phone: string,
  data: ConversationTurn
) {
  const userKey = userId?.trim() || 'global';
  const phoneId = phone?.trim();
  if (!phoneId) return;
  if (!hasMongoConfig()) return;
  try {
    const db = await getMongoDb();
    const collection = db.collection<ConversationDocument>(COLLECTION);
    const docId = `${userKey}::${phoneId}`;
    await collection.updateOne(
      { _id: docId },
      {
        $push: {
          history: {
            $each: [data],
            $slice: -HISTORY_MAX_LENGTH,
          },
        },
        $setOnInsert: {
          createdAt: new Date(),
          userId: userKey,
          phone: phoneId,
          paused: false,
        },
        $set: {
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );
  } catch (err) {
    console.error('No se pudo guardar la conversación en Mongo:', err);
  }
}

export async function getRecentConversationHistory(phone: string, limit = 10) {
  return getRecentConversationHistoryForUser('global', phone, limit);
}

export async function getRecentConversationHistoryForUser(userId: string, phone: string, limit = 10) {
  const userKey = userId?.trim() || 'global';
  const phoneId = phone?.trim();
  if (!phoneId) return [];
  if (!hasMongoConfig()) return [];
  try {
    const db = await getMongoDb();
    const collection = db.collection<ConversationDocument>(COLLECTION);
    const docId = `${userKey}::${phoneId}`;
    const doc = await collection.findOne({ _id: docId });
    if (!doc?.history?.length) return [];
    return doc.history.slice(-limit);
  } catch (err) {
    console.error('No se pudo obtener el historial en Mongo:', err);
    return [];
  }
}

export async function listConversationsForUser(userId: string, limit = 50): Promise<ConversationSummary[]> {
  const userKey = userId?.trim() || 'global';
  if (!hasMongoConfig()) return [];
  try {
    const db = await getMongoDb();
    const collection = db.collection<ConversationDocument>(COLLECTION);
    const docs = await collection
      .find(
        { userId: userKey },
        {
          sort: { updatedAt: -1 },
          limit,
          projection: { history: { $slice: -1 }, phone: 1, userId: 1, createdAt: 1, updatedAt: 1, paused: 1 },
        }
      )
      .toArray();
    return docs.map(doc => ({
      phone: doc.phone,
      userId: doc.userId,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      lastTurn: doc.history && doc.history.length ? doc.history[doc.history.length - 1] : undefined,
      paused: Boolean(doc.paused),
    }));
  } catch (err) {
    console.error('No se pudo listar conversaciones en Mongo:', err);
    return [];
  }
}

export async function setConversationPausedInDb(userId: string, phone: string, paused: boolean): Promise<boolean> {
  const userKey = userId?.trim() || 'global';
  const phoneId = phone?.trim();
  if (!phoneId) return false;
  if (!hasMongoConfig()) return false;
  try {
    const db = await getMongoDb();
    const collection = db.collection<ConversationDocument>(COLLECTION);
    const result = await collection.updateOne(
      { userId: userKey, phone: phoneId },
      { $set: { paused, updatedAt: new Date() } }
    );
    return result.matchedCount > 0;
  } catch (err) {
    console.error('No se pudo actualizar el estado de la conversación en Mongo:', err);
    return false;
  }
}
