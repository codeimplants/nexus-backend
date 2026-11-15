import { createHmac, randomBytes } from 'crypto';

/**
 * RFC 6238 TOTP (SHA-1, 6 digits, 30 s), the format Google Authenticator,
 * Microsoft Authenticator and 1Password all read. Small enough to own rather
 * than pull in a dependency.
 */
const STEP_SECONDS = 30;
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateSecret(): string {
    const bytes = randomBytes(20);
    let bits = '';
    for (const b of bytes) bits += b.toString(2).padStart(8, '0');
    let out = '';
    for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
    return out;
}

function base32Decode(secret: string): Buffer {
    let bits = '';
    for (const c of secret.replace(/=+$/, '').toUpperCase()) {
        const v = B32.indexOf(c);
        if (v < 0) throw new Error('Invalid base32 secret');
        bits += v.toString(2).padStart(5, '0');
    }
    const bytes: number[] = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
    return Buffer.from(bytes);
}

function codeAt(secret: string, step: number): string {
    const msg = Buffer.alloc(8);
    msg.writeBigUInt64BE(BigInt(step));
    const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
    const off = h[h.length - 1] & 0x0f;
    const num = (h.readUInt32BE(off) & 0x7fffffff) % 10 ** DIGITS;
    return String(num).padStart(DIGITS, '0');
}

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

/**
 * Returns the matched step (allowing one step of clock drift either way), or
 * null. Steps at or before `lastStep` are refused so a code is single-use.
 */
export function verifyTotp(secret: string, code: string, lastStep?: number | null): number | null {
    if (!/^\d{6}$/.test(code ?? '')) return null;
    const now = currentStep();
    for (const step of [now - 1, now, now + 1]) {
        if (lastStep != null && step <= lastStep) continue;
        if (codeAt(secret, step) === code) return step;
    }
    return null;
}

export function otpauthUrl(secret: string, account: string, issuer = 'Nexus'): string {
    const label = encodeURIComponent(`${issuer}:${account}`);
    return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}
