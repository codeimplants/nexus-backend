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

    async verifyOtp(input: { phone: string; sessionId: string; fullhash: string; otp: string }) {
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
        return {
            token: this.signToken(admin),
            user: this.toUserPayload(admin),
        };
    }

    // ---------------------------------------------------------------------
    // Email + password (secondary, behind ALLOW_PASSWORD_LOGIN)
    // ---------------------------------------------------------------------

    async login(email: string, password: string) {
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

        const token = this.signToken(admin);
        const { password: _, isActive: __, ...rest } = admin;
        return {
            token,
            user: this.toUserPayload(rest),
        };
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
