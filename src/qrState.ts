import QRCode from 'qrcode';

export const MIN_REFRESH_MS = 5 * 60 * 1000;

interface StoredQr {
  raw: string;
  dataUrl: string;
  updatedAt: number;
}

let currentQr: StoredQr | null = null;

export async function updateWhatsAppQr(raw: string) {
  const now = Date.now();
  if (currentQr && now - currentQr.updatedAt < MIN_REFRESH_MS) {
    return currentQr;
  }

  const dataUrl = await QRCode.toDataURL(raw, { width: 400, margin: 2 });
  currentQr = { raw, dataUrl, updatedAt: now };
  return currentQr;
}

export function getWhatsAppQr() {
  return currentQr;
}

export function clearWhatsAppQr() {
  currentQr = null;
}

export function getNextAllowedUpdateAt() {
  if (!currentQr) return 0;
  return currentQr.updatedAt + MIN_REFRESH_MS;
}
