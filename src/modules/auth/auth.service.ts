import {
    Injectable,
    UnauthorizedException,
    ForbiddenException,
    BadRequestException,
    ServiceUnavailableException,
    HttpException,
    HttpStatus,
    Logger,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { MessagingApiError } from '@codeimplants/messaging-node';
import { messagingClient } from '../../common/messaging';

const SALT_ROUNDS = 12;
const OTP_TTL_MS = 5 * 60 * 1000;

/** `******3210`: enough to tell two admins apart in a log, not enough to text one. */
const maskPhone = (phone: string) => `******${String(phone).slice(-4)}`;
/** Idle lifetime of a console session; every refresh slides it forward. */
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const hashRefreshToken = (token: string) =>
    crypto.createHash('sha256').update(token).digest('hex');

@Injectable()
export class AuthService {
    private readonly logger = new Logger(AuthService.name);

    constructor(
        private prisma: PrismaService,
        private jwt: JwtService
    ) { }

    private normalizeRole(role: string): 'ADMIN' | 'COLLABORATOR' | 'LEAD_GEN' {
        // Only known lesser roles map to themselves. Everything else (SUPER_ADMIN,
        // legacy values) maps to ADMIN — so a NEW restricted role MUST be listed
        // here explicitly, or it would be silently promoted to full access.
        if (role === 'COLLABORATOR') return 'COLLABORATOR';
        if (role === 'LEAD_GEN') return 'LEAD_GEN';
        return 'ADMIN';
    }

    private toUserPayload(admin: { id: string; email: string; name: string | null; role: string }) {
        return {
            id: admin.id,
            email: admin.email,
            name: admin.name,
            role: this.normalizeRole(admin.role),
        };
    }

    private signToken(admin: { id: string; email: string; role: string }) {
        return this.jwt.sign({
            id: admin.id,
            email: admin.email,
            role: this.normalizeRole(admin.role),
        });
    }

    /**
     * Mint an opaque refresh token. Only its SHA-256 is persisted, so a database
     * leak does not hand out live sessions. `familyId` ties every rotation of one
     * login together so reuse of a stale token can revoke the whole chain.
     */
    private async createRefreshToken(adminId: string, familyId: string, userAgent?: string) {
        const token = crypto.randomBytes(48).toString('base64url');
        await this.prisma.refreshToken.create({
            data: {
                adminId,
                familyId,
                tokenHash: hashRefreshToken(token),
                expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
                userAgent: userAgent?.slice(0, 255),
            },
        });
        return token;
    }

    /** Access JWT (short-lived) + refresh token (new family) + user. */
    private async issueSession(
        admin: { id: string; email: string; name: string | null; role: string },
        userAgent?: string,
    ) {
        return {
            token: this.signToken(admin),
            refreshToken: await this.createRefreshToken(admin.id, crypto.randomUUID(), userAgent),
            user: this.toUserPayload(admin),
        };
    }

    /**
     * Exchange a refresh token for a new access + refresh pair (rotation).
     *
     * A token that is already revoked is a replay: either an attacker or the
     * real client is holding a copy that should no longer exist. We can't tell
     * which, so the whole family is revoked and both must sign in again.
     */
    async refresh(refreshToken: string, userAgent?: string) {
        if (!refreshToken) throw new UnauthorizedException('Missing refresh token');

        const row = await this.prisma.refreshToken.findUnique({
            where: { tokenHash: hashRefreshToken(refreshToken) },
            include: {
                admin: { select: { id: true, email: true, name: true, role: true, isActive: true } },
            },
        });
        if (!row) throw new UnauthorizedException('Invalid refresh token');

        if (row.revokedAt) {
            this.logger.warn(`Refresh token reuse for admin ${row.adminId}; revoking family ${row.familyId}`);
            await this.revokeFamily(row.familyId);
            throw new UnauthorizedException('Session revoked, please sign in again');
        }
        if (row.expiresAt.getTime() < Date.now()) {
            throw new UnauthorizedException('Session expired, please sign in again');
        }
        if (!row.admin.isActive) {
            await this.revokeFamily(row.familyId);
            throw new UnauthorizedException('Account is deactivated');
        }

        // Conditional update: if two requests race with the same token, only one
        // wins the rotation; the loser sees count 0 and is treated as a replay.
        const { count } = await this.prisma.refreshToken.updateMany({
            where: { id: row.id, revokedAt: null },
            data: { revokedAt: new Date() },
        });
        if (count === 0) {
            await this.revokeFamily(row.familyId);
            throw new UnauthorizedException('Session revoked, please sign in again');
        }

        return {
            token: this.signToken(row.admin),
            refreshToken: await this.createRefreshToken(row.adminId, row.familyId, userAgent),
            user: this.toUserPayload(row.admin),
        };
    }

    /** Explicit logout: kill this login (every rotation of it). Idempotent. */
    async logout(refreshToken?: string) {
        if (refreshToken) {
            const row = await this.prisma.refreshToken.findUnique({
                where: { tokenHash: hashRefreshToken(refreshToken) },
                select: { familyId: true },
            });
            if (row) await this.revokeFamily(row.familyId);
        }
        return { success: true };
    }

    private revokeFamily(familyId: string) {
        return this.prisma.refreshToken.updateMany({
            where: { familyId, revokedAt: null },
            data: { revokedAt: new Date() },
        });
    }

    // Note: toUserPayload/signToken derive role via normalizeRole, so both the
    // JWT and the /me payload already carry LEAD_GEN without further changes.

    // ---------------------------------------------------------------------
    // Phone + OTP (primary console login)
    //
    // Code Implants Messaging (src/common/messaging.ts) sends and checks every
    // code, as it does for the apps. Its otpId is the sessionId, and a stateless
    // HMAC (`fullhash`) still binds phone+sessionId+expiry, so the login screen
    // did not change and no code is stored here. Only phones belonging to an
    // active admin are ever texted.
    //
    // dev and preprod use messaging dev, which sends nothing and makes every
    // code 123456; prod uses messaging prod and real SMS.
    //
    // Without MESSAGING_API_KEY, OTP login is refused. The 2Factor code this
    // replaced fell back to a fixed 123456 whenever its key was missing, prod
    // included, so one missing line in .env let anyone who knew an admin's
    // number into the console. When messaging is unreachable, the way in is
    // password login (ALLOW_PASSWORD_LOGIN), not a weaker code.
    // ---------------------------------------------------------------------

    private requireMessaging() {
        const client = messagingClient();
        if (!client) {
            this.logger.error('MESSAGING_API_KEY is not set, so OTP login is unavailable');
            throw new ServiceUnavailableException('OTP service unavailable');
        }
        return client;
    }

    private signOtpHash(phone: string, sessionId: string, expires: number): string {
        const hash = crypto
            .createHmac('sha256', process.env.HASH_KEY || '234')
            .update(`${phone}.${sessionId}.${expires}`)
            .digest('hex');
        return `${hash}.${expires}`;
    }

    private verifyOtpHash(
        phone: string,
        sessionId: string,
        fullhash: string,
    ): void {
        const [, expiresRaw] = (fullhash ?? '').split('.');
        const expires = Number(expiresRaw);
        if (!expiresRaw || Number.isNaN(expires)) {
            throw new BadRequestException('Malformed verification hash');
        }
        if (Date.now() > expires) {
            throw new UnauthorizedException('OTP has expired, please request a new one');
        }

        const expected = this.signOtpHash(phone, sessionId, expires);
        const a = Buffer.from(expected);
        const b = Buffer.from(fullhash);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            throw new UnauthorizedException('Invalid verification hash');
        }
    }

    /** Look up an admin by phone; only active admins may log in. */
    private async requireAdminByPhone(phone: string) {
        const admin = await this.prisma.admin.findUnique({
            where: { phone },
            select: { id: true, email: true, name: true, role: true, isActive: true },
        });
        // Do not send an SMS to a number that is not a registered admin.
        if (!admin) throw new UnauthorizedException('This number is not registered for admin access');
        if (!admin.isActive) throw new UnauthorizedException('Account is deactivated');
        return admin;
    }

    async requestOtp(phone: string) {
        if (!phone) throw new BadRequestException('Phone is required');
        await this.requireAdminByPhone(phone);
        const messaging = this.requireMessaging();

        const expires = Date.now() + OTP_TTL_MS;
        let sent: Awaited<ReturnType<typeof messaging.otp.send>>;
        try {
            sent = await messaging.otp.send({ phone, purpose: 'login' });
        } catch (error) {
            if (error instanceof MessagingApiError && error.isQuotaRefusal) {
                const wait = error.retryAfterSeconds ?? 60;
                throw new HttpException(
                    {
                        statusCode: HttpStatus.TOO_MANY_REQUESTS,
                        error: 'Too Many Requests',
                        message:
                            error.code === 'cooldown_active'
                                ? `Please wait ${wait} seconds before requesting another code.`
                                : 'Too many codes requested for this number. Please try again later.',
                        retryAfterSeconds: wait,
                    },
                    HttpStatus.TOO_MANY_REQUESTS,
                );
            }
            this.logger.error(
                `OTP send failed for ${maskPhone(phone)}: ` +
                    (error instanceof MessagingApiError ? `${error.status} ${error.code} ${error.message}` : String(error)),
            );
            throw new ServiceUnavailableException('Failed to send OTP, please try again');
        }
        this.logger.log(`OTP session ${sent.otpId} created for ${maskPhone(phone)}`);

        return {
            phone,
            sessionId: sent.otpId,
            fullhash: this.signOtpHash(phone, sent.otpId, expires),
            success: true,
            // Messaging returns the code only where it sends nothing (dev and
            // preprod), never in prod, so showing it on the login screen leaks
            // nothing that is not already fixed and known.
            ...(sent.devCode ? { otp: sent.devCode, note: `Lower environment - use OTP ${sent.devCode}` } : {}),
        };
    }

    async verifyOtp(
        input: { phone: string; sessionId: string; fullhash: string; otp: string },
        userAgent?: string,
    ) {
        const { phone, sessionId, fullhash, otp } = input;
        if (!phone || !sessionId || !fullhash || !otp) {
            throw new BadRequestException('phone, sessionId, fullhash and otp are required');
        }

        this.verifyOtpHash(phone, sessionId, fullhash);
        const messaging = this.requireMessaging();

        // Every way a code can fail comes back as a result; only a transport
        // failure (messaging unreachable, a bad key) throws.
        let result: Awaited<ReturnType<typeof messaging.otp.verify>>;
        try {
            result = await messaging.otp.verify({ otpId: sessionId, code: String(otp) });
        } catch (error) {
            this.logger.error(
                `OTP verify failed for ${maskPhone(phone)}: ` +
                    (error instanceof MessagingApiError ? `${error.status} ${error.code} ${error.message}` : String(error)),
            );
            throw new ServiceUnavailableException('OTP service unavailable');
        }
        if (!result.verified) {
            // A session from before the move (a 2Factor id or DEV_SESSION_) is
            // `not_found` here, so it fails as an invalid code.
            this.logger.warn(`OTP rejected for ${maskPhone(phone)} session ${sessionId}: ${result.reason}`);
            if (result.reason === 'expired') {
                throw new UnauthorizedException('OTP has expired, please request a new one');
            }
            if (result.reason === 'attempts_exhausted' || result.reason === 'no_longer_valid') {
                throw new UnauthorizedException('This code can no longer be used, please request a new one');
            }
            throw new UnauthorizedException('Invalid OTP');
        }

        const admin = await this.requireAdminByPhone(phone);
        return this.issueSession(admin, userAgent);
    }

    // ---------------------------------------------------------------------
    // Email + password (secondary, behind ALLOW_PASSWORD_LOGIN)
    // ---------------------------------------------------------------------

    async login(email: string, password: string, userAgent?: string) {
        if (process.env.ALLOW_PASSWORD_LOGIN === 'false') {
            throw new ForbiddenException('Password login is disabled; use phone + OTP');
        }

        const admin = await this.prisma.admin.findUnique({
            where: { email },
            select: { id: true, email: true, name: true, password: true, role: true, isActive: true },
        });
        if (!admin) throw new UnauthorizedException('Invalid credentials');
        if (!admin.isActive) throw new UnauthorizedException('Account is deactivated');

        const match = await bcrypt.compare(password, admin.password);
        if (!match) throw new UnauthorizedException('Invalid credentials');

        const { password: _, isActive: __, ...rest } = admin;
        return this.issueSession(rest, userAgent);
    }

    // register() was here. It minted an admin with role: 'ADMIN' hardcoded and
    // handed back a token, and its only caller was an unguarded POST
    // /auth/register. Removed rather than guarded: UsersService.create already
    // covers this behind JwtGuard + RolesGuard('ADMIN'), and a method that
    // silently grants full administrator rights is one wiring mistake away from
    // being exposed again.

    async me(userId: string) {
        const admin = await this.prisma.admin.findUnique({
            where: { id: userId },
            select: { id: true, email: true, name: true, role: true, isActive: true },
        });
        if (!admin || !admin.isActive) throw new UnauthorizedException('User not found or deactivated');
        return this.toUserPayload(admin);
    }
}
