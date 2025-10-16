import { ObjectId } from 'mongodb';
import { getMongoDb, hasMongoConfig } from './db.js';

const COLLECTION = 'ventas';

export interface SaleRecord {
  userId: string;
  chatJid: string;
  telefono: string;
  timestamp: Date;
  nombre?: string;
  producto?: string;
  cantidad?: string;
  totalArs?: number | null;
  totalArsRaw?: string;
  direccion?: string;
  cp?: string;
  ciudad?: string;
  userMessage?: string;
  aiMessage?: string;
  metadata?: Record<string, unknown>;
}

interface SaleDocument extends SaleRecord {
  _id?: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export async function insertSale(record: SaleRecord): Promise<boolean> {
  if (!hasMongoConfig()) return false;
  const userId = record.userId?.trim();
  if (!userId) return false;
  try {
    const db = await getMongoDb();
    const collection = db.collection<SaleDocument>(COLLECTION);
    const now = new Date();
    await collection.insertOne({
      ...record,
      userId,
      createdAt: now,
      updatedAt: now,
    });
    return true;
  } catch (err) {
    console.error('No se pudo registrar la venta en Mongo:', err);
    return false;
  }
}

export interface SaleSummary {
  id: string;
  userId: string;
  chatJid: string;
  telefono: string;
  timestamp?: string;
  nombre?: string;
  producto?: string;
  cantidad?: string;
  totalArs?: number | null;
  totalArsRaw?: string;
  direccion?: string;
  cp?: string;
  ciudad?: string;
  userMessage?: string;
  aiMessage?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

type SaleUpdateInput = Partial<{
  nombre: string;
  producto: string;
  cantidad: string;
  totalArs: number | null;
  totalArsRaw: string;
  direccion: string;
  cp: string;
  ciudad: string;
  timestamp: Date;
}>;

function mapSaleDocument(doc: SaleDocument): SaleSummary {
  return {
    id: doc._id?.toHexString?.() ?? String(doc._id),
    userId: doc.userId,
    chatJid: doc.chatJid,
    telefono: doc.telefono,
    timestamp: doc.timestamp ? doc.timestamp.toISOString() : undefined,
    nombre: doc.nombre,
    producto: doc.producto,
    cantidad: doc.cantidad,
    totalArs: typeof doc.totalArs === 'number' && Number.isFinite(doc.totalArs) ? doc.totalArs : null,
    totalArsRaw: doc.totalArsRaw,
    direccion: doc.direccion,
    cp: doc.cp,
    ciudad: doc.ciudad,
    userMessage: doc.userMessage,
    aiMessage: doc.aiMessage,
    metadata: doc.metadata,
    createdAt: doc.createdAt?.toISOString?.(),
    updatedAt: doc.updatedAt?.toISOString?.(),
  };
}

export async function listSalesForUser(userId: string, limit = 500): Promise<SaleSummary[]> {
  if (!hasMongoConfig()) return [];
  const userKey = userId?.trim();
  if (!userKey) return [];
  try {
    const db = await getMongoDb();
    const collection = db.collection<SaleDocument>(COLLECTION);
    const docs = await collection
      .find({ userId: userKey })
      .sort({ timestamp: -1, createdAt: -1 })
      .limit(limit)
      .toArray();
    return docs.map(mapSaleDocument);
  } catch (err) {
    console.error('No se pudieron listar ventas en Mongo:', err);
    return [];
  }
}

export async function updateSaleForUser(
  userId: string,
  saleId: string,
  updates: SaleUpdateInput
): Promise<SaleSummary | null> {
  if (!hasMongoConfig()) return null;
  const userKey = userId?.trim();
  if (!userKey) return null;
  let objectId: ObjectId;
  try {
    objectId = new ObjectId(saleId);
  } catch {
    return null;
  }

  const db = await getMongoDb();
  const collection = db.collection<SaleDocument>(COLLECTION);
  const set: Partial<SaleDocument> = { updatedAt: new Date() };

  if (updates.nombre !== undefined) set.nombre = updates.nombre;
  if (updates.producto !== undefined) set.producto = updates.producto;
  if (updates.cantidad !== undefined) set.cantidad = updates.cantidad;
  if (updates.totalArs !== undefined) set.totalArs = updates.totalArs;
  if (updates.totalArsRaw !== undefined) set.totalArsRaw = updates.totalArsRaw;
  if (updates.direccion !== undefined) set.direccion = updates.direccion;
  if (updates.cp !== undefined) set.cp = updates.cp;
  if (updates.ciudad !== undefined) set.ciudad = updates.ciudad;
  if (updates.timestamp instanceof Date && !Number.isNaN(updates.timestamp.valueOf())) {
    set.timestamp = updates.timestamp;
  }

  const result = await collection.updateOne(
    { _id: objectId, userId: userKey },
    { $set: set }
  );
  if (!result.matchedCount) return null;

  const doc = await collection.findOne({ _id: objectId, userId: userKey });
  return doc ? mapSaleDocument(doc) : null;
}
