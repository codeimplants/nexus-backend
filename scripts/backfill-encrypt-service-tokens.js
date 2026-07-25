// One-off backfill: encrypts any App.backendServiceToken saved before
// SERVICE_TOKEN_KEY encryption was added. Safe to re-run — already-encrypted
// values are left untouched. Requires `npm run build` first (reads dist/) and
// SERVICE_TOKEN_KEY set in the target environment's .env.
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { encryptServiceToken, decryptServiceToken } = require('../dist/common/crypto/service-token-cipher');

function looksEncrypted(stored) {
    const parts = stored.split(':');
    if (parts.length !== 3) return false;
    try {
        return Buffer.from(parts[0], 'base64').length === 12 && Buffer.from(parts[1], 'base64').length === 16;
    } catch {
        return false;
    }
}

(async () => {
    const prisma = new PrismaClient();
    const apps = await prisma.app.findMany({
        where: { backendServiceToken: { not: null } },
        select: { id: true, name: true, backendServiceToken: true },
    });

    let migrated = 0;
    for (const app of apps) {
        if (looksEncrypted(app.backendServiceToken)) {
            console.log(`skip  ${app.name} (${app.id}) — already encrypted`);
            continue;
        }
        const encrypted = encryptServiceToken(app.backendServiceToken);
        if (decryptServiceToken(encrypted) !== app.backendServiceToken) {
            throw new Error(`round-trip mismatch for ${app.name} (${app.id}) — aborting, nothing written for it`);
        }
        await prisma.app.update({ where: { id: app.id }, data: { backendServiceToken: encrypted } });
        console.log(`encrypted  ${app.name} (${app.id})`);
        migrated += 1;
    }
    console.log(`done — ${migrated} token(s) encrypted, ${apps.length - migrated} already ok`);
    await prisma.$disconnect();
})();
