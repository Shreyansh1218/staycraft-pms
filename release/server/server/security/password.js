import crypto from 'node:crypto';
import { promisify } from 'node:util';
const scryptAsync = promisify(crypto.scrypt);
const KEY_LENGTH = 64;
export const MAX_PASSWORD_LENGTH = 256;
export async function hashPassword(plainPassword) {
    if (!plainPassword || plainPassword.length > MAX_PASSWORD_LENGTH) {
        throw new Error(`Password length must be between 1 and ${MAX_PASSWORD_LENGTH} characters.`);
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const derivedKey = (await scryptAsync(plainPassword, salt, KEY_LENGTH));
    return `scrypt:${salt}:${derivedKey.toString('hex')}`;
}
export function createDummyPasswordHash() {
    const salt = crypto.randomBytes(16).toString('hex');
    const derivedKey = crypto.scryptSync(crypto.randomBytes(24).toString('hex'), salt, KEY_LENGTH);
    return `scrypt:${salt}:${derivedKey.toString('hex')}`;
}
export async function verifyPassword(plainPassword, storedHash) {
    if (!plainPassword || plainPassword.length > MAX_PASSWORD_LENGTH) {
        return false;
    }
    const parts = storedHash.split(':');
    if (parts.length !== 3 || parts[0] !== 'scrypt')
        return false;
    const [, salt, hashHex] = parts;
    if (!salt || !hashHex || hashHex.length !== KEY_LENGTH * 2)
        return false;
    const expectedBuffer = Buffer.from(hashHex, 'hex');
    if (expectedBuffer.length !== KEY_LENGTH)
        return false;
    const derivedKey = (await scryptAsync(plainPassword, salt, expectedBuffer.length));
    if (derivedKey.length !== expectedBuffer.length)
        return false;
    return crypto.timingSafeEqual(derivedKey, expectedBuffer);
}
export function generateSessionToken() {
    return crypto.randomBytes(32).toString('hex');
}
export function hashSessionToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}
export function generatePasswordResetToken() {
    return crypto.randomBytes(32).toString('hex');
}
export function hashPasswordResetToken(token) {
    return crypto
        .createHash('sha256')
        .update(token.trim().toLowerCase())
        .digest('hex');
}
