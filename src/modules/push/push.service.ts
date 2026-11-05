import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

/**
 * Push notifications to the Nexus admin app (iOS + Android) through Expo's push service,
 * which forwards to APNs and FCM, so one call reaches both platforms.
 *
 * Settings (.env):
 *   EXPO_ACCESS_TOKEN  optional; needed only if "enhanced push security" is on in the Expo project
 *
 * Expo answers each message with a ticket. A DeviceNotRegistered ticket means the app
 * was uninstalled or the token rotated, so that row is deleted rather than retried forever.
 */

const EXPO_URL = 'https://exp.host/--/api/v2/push/send';
const TOKEN_RE = /^Expo(nent)?PushToken\[[^\]]+\]$/;
const CHUNK = 100; // Expo's per-request limit

export interface PushMessage {
    title: string;
    body: string;
    /** Read by the app when the notification is tapped, e.g. { screen: 'server' }. */
    data?: Record<string, unknown>;
    priority?: 'default' | 'high';
}

export interface PushResult { devices: number; sent: number; errors: string[] }

interface Ticket { status: 'ok' | 'error'; id?: string; message?: string; details?: { error?: string } }

@Injectable()
export class PushService {
    private readonly logger = new Logger(PushService.name);

    constructor(private readonly prisma: PrismaService) { }

    async register(adminId: string, token: string, platform: string, deviceName?: string) {
        if (!TOKEN_RE.test(token)) throw new BadRequestException('Not an Expo push token');
        // A phone can change hands (sign out, sign in as someone else): the token moves to the new admin.
        await this.prisma.adminPushToken.upsert({
            where: { token },
            create: { adminId, token, platform, deviceName },
            update: { adminId, platform, deviceName, lastSeenAt: new Date() },
        });
        return { registered: true };
    }

    /** Only the owner can remove their phone, so one admin cannot silence another. */
    async unregister(adminId: string, token: string) {
        const { count } = await this.prisma.adminPushToken.deleteMany({ where: { token, adminId } });
        return { removed: count > 0 };
    }

    mine(adminId: string) {
        return this.prisma.adminPushToken.findMany({
            where: { adminId },
            select: { id: true, platform: true, deviceName: true, createdAt: true, lastSeenAt: true },
            orderBy: { lastSeenAt: 'desc' },
        });
    }

    /**
     * Every active full admin. Server alerts show every app on the VPS, so like the
     * Server tab they go to ADMIN only. Roles other than COLLABORATOR and LEAD_GEN
     * count as ADMIN, matching JwtGuard.normalizeRole.
     */
    async sendToAdmins(msg: PushMessage) {
        const rows = await this.prisma.adminPushToken.findMany({
            where: { admin: { isActive: true, role: { notIn: ['COLLABORATOR', 'LEAD_GEN'] } } },
            select: { token: true },
        });
        return this.send(rows.map((r) => r.token), msg);
    }

    async sendToAdmin(adminId: string, msg: PushMessage) {
        const rows = await this.prisma.adminPushToken.findMany({ where: { adminId }, select: { token: true } });
        return this.send(rows.map((r) => r.token), msg);
    }

    /** Returns how many Expo accepted and the errors, one line each. Throws only if Expo is unreachable. */
    async send(tokens: string[], msg: PushMessage): Promise<PushResult> {
        const errors: string[] = [];
        const dead: string[] = [];
        let sent = 0;
        for (let i = 0; i < tokens.length; i += CHUNK) {
            const batch = tokens.slice(i, i + CHUNK);
            const res = await fetch(EXPO_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    ...(process.env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}),
                },
                body: JSON.stringify(batch.map((to) => ({
                    to,
                    title: msg.title,
                    body: msg.body,
                    data: msg.data ?? {},
                    sound: 'default',
                    priority: msg.priority ?? 'high',
                    channelId: 'alerts', // the Android channel the app creates
                }))),
            });
            if (!res.ok) throw new Error(`Expo push HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
            const { data } = (await res.json()) as { data: Ticket[] };
            data.forEach((t, j) => {
                if (t.status === 'ok') sent++;
                else if (t.details?.error === 'DeviceNotRegistered') dead.push(batch[j]);
                else errors.push(t.message ?? t.details?.error ?? 'unknown error');
            });
        }
        if (dead.length) {
            await this.prisma.adminPushToken.deleteMany({ where: { token: { in: dead } } });
            this.logger.log(`Removed ${dead.length} push token(s) Expo reported as no longer registered.`);
        }
        return { devices: tokens.length, sent, errors };
    }
}
