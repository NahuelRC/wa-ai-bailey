import 'dotenv/config';

export const cfg = {
  PORT: Number(process.env.PORT || 3000),
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  IMG1: process.env.IMG1_URL || '',
  IMG2: process.env.IMG2_URL || '',
  IMG3: process.env.IMG3_URL || '',
};
