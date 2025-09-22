import 'dotenv/config';

function num(v: string | undefined, def: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export const cfg = {
  PORT: num(process.env.PORT, 3000),

  // OpenAI
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
  OPENAI_MODEL: (process.env.OPENAI_MODEL ?? 'gpt-4o-mini').trim(),
  OPENAI_BASE_URL: (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com').replace(/\/+$/, ''),

  // Imágenes (mantengo tus nombres)
  IMG1: process.env.IMG1_URL ?? '',
  IMG2: process.env.IMG2_URL ?? '',
  IMG3: process.env.IMG3_URL ?? '',

  // Otros (opcionales)
  ADMIN_WHITELIST: (process.env.ADMIN_WHITELIST ?? '')
    .split(',').map(s => s.trim()).filter(Boolean),
  WA_SESSION_DIR: process.env.WA_SESSION_DIR ?? '',
  DISABLE_HUMAN_MUTE: process.env.DISABLE_HUMAN_MUTE === '1',
  DISABLE_BUSINESS_HOURS: process.env.DISABLE_BUSINESS_HOURS === '1',
  WEB_VERSION: process.env.WEB_VERSION ?? ''
} as const;
