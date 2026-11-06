// Registers an app in this Nexus environment (or updates it) and points its federation at the app's own
// backend: App.backendBaseUrl + an encrypted App.backendServiceToken, the way Sonebill is wired by hand
// under Applications -> Backend Integration. For apps whose deploy scripts mint the token themselves
// (feenix-backend scripts/connect-nexus.sh), so the secret never passes through a browser or a terminal.
//
//   APP_PACKAGE=com.codeimplants.feenix APP_NAME=Feenix BACKEND_URL=http://127.0.0.1:7150/admin/v1 \
//   SERVICE_TOKEN=... node scripts/connect-app-backend.js
//
// The token comes from the environment only, never argv (visible in `ps`). Requires `npm run build`
// (reads dist/) and SERVICE_TOKEN_KEY in this checkout's .env. Prints the app's row id and its SDK API key
// (the client key apps ship with, EXPO_PUBLIC_VC_API_KEY), never the service token.
require('dotenv').config();
const { randomUUID } = require('crypto');
const { PrismaClient } = require('@prisma/client');
const { encryptServiceToken, decryptServiceToken } = require('../dist/common/crypto/service-token-cipher');

const need = (name) => {
    const v = (process.env[name] || '').trim();
    if (!v) {
        console.error(`${name} is required`);
        process.exit(2);
    }
    return v;
};

(async () => {
    const pkg = need('APP_PACKAGE');
    const name = need('APP_NAME');
    const url = need('BACKEND_URL');
    const token = need('SERVICE_TOKEN');
    if (!/^https?:\/\//.test(url)) {
        console.error('BACKEND_URL must be an http(s) URL');
        process.exit(2);
    }
    const platforms = (process.env.APP_PLATFORMS || 'android,ios,web').split(',').map((s) => s.trim()).filter(Boolean);

    const encrypted = encryptServiceToken(token);
    if (decryptServiceToken(encrypted) !== token) throw new Error('service token round-trip mismatch; nothing written');

    const prisma = new PrismaClient();
    try {
        // App.appId has no unique constraint: like SdkService, the oldest active match is the app.
        const matches = await prisma.app.findMany({ where: { appId: pkg, isActive: true }, orderBy: { createdAt: 'asc' }, select: { id: true } });
        if (matches.length > 1) console.warn(`warning: ${matches.length} active apps with appId ${pkg}; updating the oldest`);

        const data = { backendBaseUrl: url, backendServiceToken: encrypted };
        const app = matches[0]
            ? await prisma.app.update({ where: { id: matches[0].id }, data, select: { id: true, apiKey: true, name: true } })
            : await prisma.app.create({ data: { ...data, name, appId: pkg, platforms, apiKey: randomUUID() }, select: { id: true, apiKey: true, name: true } });

        console.log(`${matches[0] ? 'updated' : 'created'} ${app.name} (${app.id}); backend ${url}`);
        console.log(`SDK API key: ${app.apiKey}`);
    } finally {
        await prisma.$disconnect();
    }
})().catch((e) => {
    console.error(String(e && e.message ? e.message : e));
    process.exit(1);
});
