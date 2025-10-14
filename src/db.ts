import { MongoClient } from 'mongodb';
import { cfg } from './config.js';

let client: MongoClient | null = null;
let connecting: Promise<MongoClient> | null = null;

export function hasMongoConfig() {
  return Boolean(cfg.MONGO_URI && cfg.MONGO_URI.trim());
}

async function createClient(): Promise<MongoClient> {
  if (!hasMongoConfig()) {
    throw new Error('MONGO_URI no está configurado');
  }
  const uri = cfg.MONGO_URI.trim();
  const mongoClient = new MongoClient(uri, {
    maxPoolSize: 10,
  });
  await mongoClient.connect();
  return mongoClient;
}

export async function getMongoClient(): Promise<MongoClient> {
  if (client) return client;
  if (connecting) return connecting;
  connecting = createClient()
    .then((c) => {
      client = c;
      connecting = null;
      return c;
    })
    .catch((err) => {
      connecting = null;
      throw err;
    });
  return connecting;
}

export async function getMongoDb() {
  const mongoClient = await getMongoClient();
  return mongoClient.db(cfg.MONGO_DB_NAME || 'wa-ai');
}

export async function closeMongo() {
  if (connecting) {
    await connecting.catch(() => null);
  }
  if (client) {
    await client.close().catch(() => null);
    client = null;
  }
}
