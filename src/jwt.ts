import crypto from 'crypto';

function base64UrlEncode(data: Buffer | string): string {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(data: string): Buffer {
  const padLength = (4 - (data.length % 4)) % 4;
  const padded = data + '='.repeat(padLength);
  const normalized = padded.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64');
}

export interface JwtPayload {
  sub: string;
  username: string;
  iat: number;
  exp?: number;
  [key: string]: unknown;
}

export function signJwt(payload: Omit<JwtPayload, 'iat' | 'exp'> & { exp?: number }, secret: string, expiresInSeconds?: number): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const issuedAt = Math.floor(Date.now() / 1000);
  const fullPayload: JwtPayload = {
    ...payload,
    iat: issuedAt,
  } as JwtPayload;

  if (expiresInSeconds && expiresInSeconds > 0) {
    fullPayload.exp = issuedAt + Math.floor(expiresInSeconds);
  } else if (typeof payload.exp === 'number') {
    fullPayload.exp = payload.exp;
  }

  const headerEncoded = base64UrlEncode(JSON.stringify(header));
  const payloadEncoded = base64UrlEncode(JSON.stringify(fullPayload));
  const signature = crypto.createHmac('sha256', secret).update(`${headerEncoded}.${payloadEncoded}`).digest();
  const signatureEncoded = base64UrlEncode(signature);
  return `${headerEncoded}.${payloadEncoded}.${signatureEncoded}`;
}

export function verifyJwt(token: string, secret: string): { valid: true; payload: JwtPayload } | { valid: false; error: string } {
  if (!token || typeof token !== 'string') {
    return { valid: false, error: 'Token vacío' };
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return { valid: false, error: 'Token con formato inválido' };
  }

  const [headerEncoded, payloadEncoded, signatureEncoded] = parts;
  let payloadJson: JwtPayload;

  try {
    const expectedSignature = crypto.createHmac('sha256', secret).update(`${headerEncoded}.${payloadEncoded}`).digest();
    const expectedSignatureEncoded = base64UrlEncode(expectedSignature);
    if (!crypto.timingSafeEqual(Buffer.from(expectedSignatureEncoded), Buffer.from(signatureEncoded))) {
      return { valid: false, error: 'Firma inválida' };
    }

    const payloadBuffer = base64UrlDecode(payloadEncoded);
    payloadJson = JSON.parse(payloadBuffer.toString()) as JwtPayload;
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : 'Token inválido' };
  }

  if (payloadJson.exp && Math.floor(Date.now() / 1000) >= payloadJson.exp) {
    return { valid: false, error: 'Token expirado' };
  }

  return { valid: true, payload: payloadJson };
}
