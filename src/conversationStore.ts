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
        },
        $set: {
          updatedAt: new Date(),
          userId: userKey,
          phone: phoneId,
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
