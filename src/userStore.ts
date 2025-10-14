import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getMongoDb, hasMongoConfig } from './db.js';

export interface StoredUser {
  id: string;
  username: string;
  passwordHash: string;
  salt: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
}

const DATA_DIR = path.join(process.cwd(), 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const USERS_COLLECTION = 'users';

interface UserDocument extends StoredUser {
  _id: string;
  usernameLower: string;
}

let ensuredIndexes = false;

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readUsersFromFile(): StoredUser[] {
  try {
    const raw = fs.readFileSync(USERS_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as StoredUser[];
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function writeUsersToFile(users: StoredUser[]) {
  ensureDataDir();
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf-8');
}

function hashPassword(password: string, salt: string): string {
  return crypto.pbkdf2Sync(password, salt, 100_000, 64, 'sha512').toString('hex');
}

async function getUserCollection() {
  const db = await getMongoDb();
  const collection = db.collection<UserDocument>(USERS_COLLECTION);
  if (!ensuredIndexes) {
    await collection.createIndex({ usernameLower: 1 }, { unique: true }).catch(() => {});
    ensuredIndexes = true;
  }
  return collection;
}

function normalizeUsername(username: string) {
  return username.trim().toLowerCase();
}

function createStoredUser(username: string, password: string): StoredUser {
  const cleanUsername = username.trim();
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(password, salt);
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    username: cleanUsername,
    passwordHash,
    salt,
    prompt: '',
    createdAt: now,
    updatedAt: now,
  };
}

function docToStoredUser(doc: UserDocument | null): StoredUser | undefined {
  if (!doc) return undefined;
  const { _id, usernameLower, ...rest } = doc;
  return { ...rest, id: doc.id ?? doc._id };
}

export async function createUser(username: string, password: string): Promise<StoredUser> {
  if (hasMongoConfig()) {
    const collection = await getUserCollection();
    const usernameLower = normalizeUsername(username);
    const existing = await collection.findOne({ usernameLower });
    if (existing) {
      throw new Error('El usuario ya existe');
    }
    const user = createStoredUser(username, password);
    await collection.insertOne({ _id: user.id, ...user, usernameLower });
    return user;
  }

  const users = readUsersFromFile();
  if (users.some(u => u.username.toLowerCase() === username.trim().toLowerCase())) {
    throw new Error('El usuario ya existe');
  }
  const user = createStoredUser(username, password);
  users.push(user);
  writeUsersToFile(users);
  return user;
}

export async function findUserByUsername(username: string): Promise<StoredUser | undefined> {
  if (hasMongoConfig()) {
    const collection = await getUserCollection();
    const doc = await collection.findOne({ usernameLower: normalizeUsername(username) });
    return docToStoredUser(doc);
  }
  const users = readUsersFromFile();
  return users.find(u => u.username.toLowerCase() === username.trim().toLowerCase());
}

export async function findUserById(id: string): Promise<StoredUser | undefined> {
  if (hasMongoConfig()) {
    const collection = await getUserCollection();
    const doc = await collection.findOne({ _id: id });
    if (!doc) return undefined;
    return docToStoredUser({ ...doc, id: id });
  }
  const users = readUsersFromFile();
  return users.find(u => u.id === id);
}

export async function verifyUserPassword(user: StoredUser, password: string): Promise<boolean> {
  const hash = hashPassword(password, user.salt);
  const inputBuffer = Buffer.from(hash, 'hex');
  const storedBuffer = Buffer.from(user.passwordHash, 'hex');
  if (inputBuffer.length !== storedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(inputBuffer, storedBuffer);
}

export async function updateUserPrompt(id: string, prompt: string): Promise<StoredUser | undefined> {
  if (hasMongoConfig()) {
    const collection = await getUserCollection();
    const now = new Date().toISOString();
    await collection.updateOne(
      { _id: id },
      { $set: { prompt, updatedAt: now } },
      { upsert: false }
    );
    const updatedDoc = await collection.findOne({ _id: id });
    return docToStoredUser(updatedDoc ?? null);
  }

  const users = readUsersFromFile();
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) return undefined;
  const updated: StoredUser = {
    ...users[idx],
    prompt,
    updatedAt: new Date().toISOString(),
  };
  users[idx] = updated;
  writeUsersToFile(users);
  return updated;
}

export async function listUsers(): Promise<StoredUser[]> {
  if (hasMongoConfig()) {
    const collection = await getUserCollection();
    const docs = await collection.find().toArray();
    return docs.map(doc => docToStoredUser(doc)!).filter(Boolean) as StoredUser[];
  }
  return readUsersFromFile();
}

export async function getPrimaryUserId(): Promise<string | null> {
  if (hasMongoConfig()) {
    const collection = await getUserCollection();
    const doc = await collection.find().sort({ createdAt: 1 }).limit(1).next();
    return doc ? doc._id : null;
  }
  const users = readUsersFromFile();
  return users.length ? users[0].id : null;
}

export interface PublicUser {
  id: string;
  username: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
}

export function toPublicUser(user: StoredUser): PublicUser {
  const { id, username, prompt, createdAt, updatedAt } = user;
  return { id, username, prompt, createdAt, updatedAt };
}
