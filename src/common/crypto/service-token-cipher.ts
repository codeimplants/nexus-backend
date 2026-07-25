import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function key(): Buffer {
    const secret = process.env.SERVICE_TOKEN_KEY;
    if (!secret) throw new Error('SERVICE_TOKEN_KEY is not set');
    return createHash('sha256').update(secret).digest();
}

/** Encrypts an App.backendServiceToken for storage. Format: `iv:authTag:ciphertext`, each base64. */
export function encryptServiceToken(plaintext: string): string {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, key(), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [iv, authTag, ciphertext].map((b) => b.toString('base64')).join(':');
}

function looksEncrypted(stored: string): boolean {
    const parts = stored.split(':');
    if (parts.length !== 3) return false;
    try {
        return (
            Buffer.from(parts[0], 'base64').length === IV_LEN &&
            Buffer.from(parts[1], 'base64').length === TAG_LEN
        );
    } catch {
        return false;
    }
}

/**
 * Decrypts a stored backendServiceToken. Tokens saved before encryption was
 * added are still plain text — those are returned as-is rather than treated
 * as an error, so existing app integrations (e.g. Sone Bill) keep working
 * until they're next rotated through `encryptServiceToken`.
 */
export function decryptServiceToken(stored: string): string {
    if (!looksEncrypted(stored)) return stored;
    const [ivB64, tagB64, dataB64] = stored.split(':');
    const decipher = createDecipheriv(ALGO, key(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}
