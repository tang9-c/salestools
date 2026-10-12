import { createHash, timingSafeEqual } from 'node:crypto';

export function verifyAdminKey(plaintext: string, expectedHash: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(plaintext) || !/^[a-f0-9]{64}$/.test(expectedHash)) return false;
  return timingSafeEqual(createHash('sha256').update(plaintext).digest(), Buffer.from(expectedHash, 'hex'));
}
