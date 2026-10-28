import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(crypto.scrypt);
const KEY_LENGTH = 64;
export const MAX_PASSWORD_LENGTH = 256;

export async function hashPassword(plainPassword: string): Promise<string> {
  if (!plainPassword || plainPassword.length > MAX_PASSWORD_LENGTH) {
    throw new Error(
      `Password length must be between 1 and ${MAX_PASSWORD_LENGTH} characters.`
    );
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = (await scryptAsync(plainPassword, salt, KEY_LENGTH)) as Buffer;
  return `scrypt:${salt}:${derivedKey.toString('hex')}`;
}

export function createDummyPasswordHash(): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(
    crypto.randomBytes(24).toString('hex'),
    salt,
    KEY_LENGTH
  );
  return `scrypt:${salt}:${derivedKey.toString('hex')}`;
}

export async function verifyPassword(plainPassword: string, storedHash: string): Promise<boolean> {
  if (!plainPassword || plainPassword.length > MAX_PASSWORD_LENGTH) {
    return false;
  }
  const parts = storedHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hashHex] = parts;
  if (!salt || !hashHex || hashHex.length !== KEY_LENGTH * 2) return false;
  const expectedBuffer = Buffer.from(hashHex, 'hex');
  if (expectedBuffer.length !== KEY_LENGTH) return false;
  const derivedKey = (await scryptAsync(plainPassword, salt, expectedBuffer.length)) as Buffer;
  if (derivedKey.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(derivedKey, expectedBuffer);
}

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generatePasswordResetToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function hashPasswordResetToken(token: string): string {
  return crypto
    .createHash('sha256')
    .update(token.trim().toLowerCase())
    .digest('hex');
}
