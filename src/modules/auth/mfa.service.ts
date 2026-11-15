import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../database/prisma.service';
import { decryptServiceToken, encryptServiceToken } from '../../common/crypto/service-token-cipher';
import { generateSecret, otpauthUrl, verifyTotp } from '../../common/mfa/totp';

/** How long one authenticator code unlocks changes for. */
export const MFA_TOKEN_TTL_SECONDS = 10 * 60;
export const MFA_TOKEN_TYPE = 'mfa';

/**
 * Step-up for changes. Signing in (phone OTP + refresh token) only lets an
 * account read; a write also needs an `X-MFA-Token`, minted here from a code
 * in the account owner's own authenticator app. JwtGuard enforces it.
 */
@Injectable()
export class MfaService {
    constructor(
        private prisma: PrismaService,
        private jwt: JwtService,
    ) { }

    async status(adminId: string) {
        const a = await this.prisma.admin.findUnique({ where: { id: adminId }, select: { mfaEnabledAt: true } });
        return { enabled: !!a?.mfaEnabledAt, enabledAt: a?.mfaEnabledAt ?? null };
    }

    /** Start (or restart) setup. Refused once enabled: reset first. */
    async setup(adminId: string) {
        const a = await this.prisma.admin.findUniqueOrThrow({
            where: { id: adminId },
            select: { phone: true, email: true, name: true, mfaEnabledAt: true },
        });
        if (a.mfaEnabledAt) throw new ConflictException('Authenticator is already set up; reset it to set up again');

        const secret = generateSecret();
        await this.prisma.admin.update({
            where: { id: adminId },
            data: { mfaSecret: encryptServiceToken(secret), mfaLastStep: null },
        });
        const account = a.name ?? a.phone ?? a.email;
        // The frontend renders otpauthUrl as a QR code; secret is for manual entry.
        return { otpauthUrl: otpauthUrl(secret, account), secret };
    }

    /** Confirm setup with the first code from the app. */
    async enable(adminId: string, code: string) {
        const a = await this.prisma.admin.findUniqueOrThrow({ where: { id: adminId } });
        if (a.mfaEnabledAt) throw new ConflictException('Authenticator is already set up');
        if (!a.mfaSecret) throw new BadRequestException('Start setup first');
        const step = verifyTotp(decryptServiceToken(a.mfaSecret), code, a.mfaLastStep);
        if (step == null) throw new UnauthorizedException('Invalid code');
        await this.prisma.admin.update({
            where: { id: adminId },
            data: { mfaEnabledAt: new Date(), mfaLastStep: step },
        });
        return { enabled: true, ...this.issue(adminId) };
    }

    /** Exchange a fresh authenticator code for a short-lived change token. */
    async verify(adminId: string, code: string) {
        const a = await this.prisma.admin.findUniqueOrThrow({ where: { id: adminId } });
        if (!a.mfaEnabledAt || !a.mfaSecret) throw new BadRequestException('Set up your authenticator first');
        const step = verifyTotp(decryptServiceToken(a.mfaSecret), code, a.mfaLastStep);
        if (step == null) throw new UnauthorizedException('Invalid or already used code');
        // Conditional write: two requests with the same code cannot both pass.
        const { count } = await this.prisma.admin.updateMany({
            where: { id: adminId, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: step } }] },
            data: { mfaLastStep: step },
        });
        if (count === 0) throw new UnauthorizedException('Invalid or already used code');
        return this.issue(adminId);
    }

    /** Clear an account's authenticator (own reset via phone OTP, or by the super admin). */
    async clear(adminId: string) {
        await this.prisma.admin.update({
            where: { id: adminId },
            data: { mfaSecret: null, mfaEnabledAt: null, mfaLastStep: null },
        });
        return { enabled: false };
    }

    private issue(adminId: string) {
        return {
            mfaToken: this.jwt.sign({ id: adminId, typ: MFA_TOKEN_TYPE }, { expiresIn: MFA_TOKEN_TTL_SECONDS }),
            expiresInSeconds: MFA_TOKEN_TTL_SECONDS,
        };
    }
}
