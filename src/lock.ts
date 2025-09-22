import * as fs from 'fs';
import * as path from 'path';


export function acquireProcessLock(dir: string) {
  const lockPath = path.join(dir, 'process.lock');
  try {
    if (fs.existsSync(lockPath)) {
      return { ok: false, lockPath };
    }
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    return { ok: true, lockPath };
  } catch {
    return { ok: false, lockPath };
  }
}

export function releaseProcessLock(lockPath: string) {
  try { if (lockPath && fs.existsSync(lockPath)) fs.unlinkSync(lockPath); } catch {}
}
