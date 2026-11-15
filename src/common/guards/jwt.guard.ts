import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../database/prisma.service';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Writes that every signed-in account may make, because they only touch the
 * caller's own session or device, never platform data.
 */
const SELF_SERVICE_WRITES: Array<{ method: string; path: RegExp }> = [
    { method: 'PATCH', path: /\/admin\/users\/me$/ },
    { method: 'POST', path: /\/push\/devices$/ },
    { method: 'DELETE', path: /\/push\/devices$/ },
    { method: 'POST', path: /\/push\/test$/ },
    { method: 'POST', path: /\/auth\/mfa\/(setup|enable|verify|reset)$/ },
];

/** Roles that may make changes, each with their own authenticator code. */
const WRITER_ROLES = new Set(['SUPER_ADMIN', 'ADMIN']);
const MFA_TOKEN_TYPE = 'mfa';

export interface JwtPayload {
    id: string;
    email: string;
    role: string;
}

@Injectable()
export class JwtGuard implements CanActivate {
    constructor(
        private jwt: JwtService,
        private prisma: PrismaService,
    ) { }

    /**
     * Mirrors AuthService.normalizeRole. Kept in step deliberately: only known
     * lesser roles map to themselves, so a NEW restricted role must be added
     * here too or it would be silently promoted to full access.
     */
    private normalizeRole(role: string): 'SUPER_ADMIN' | 'ADMIN' | 'COLLABORATOR' | 'LEAD_GEN' {
        if (role === 'SUPER_ADMIN') return 'SUPER_ADMIN';
        if (role === 'COLLABORATOR') return 'COLLABORATOR';
        if (role === 'LEAD_GEN') return 'LEAD_GEN';
        return 'ADMIN';
    }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest();
        const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.headers.authorization?.split(' ')[1];
        if (!token) throw new UnauthorizedException('Missing or invalid token');

        let decoded: JwtPayload & { typ?: string };
        try {
            decoded = this.jwt.verify<JwtPayload & { typ?: string }>(token);
        } catch {
            throw new UnauthorizedException('Invalid or expired token');
        }
        // An X-MFA-Token is signed with the same key; it must not work as a session.
        if (decoded.typ) throw new UnauthorizedException('Invalid or expired token');

        // A valid signature used to be the whole check, which meant the token
        // was the sole source of truth for seven days. Three things followed
        // from that, all of them wrong:
        //
        //   - deactivating an admin did nothing until their token expired,
        //     so PUT /admin/users/:id/deactivate did not actually lock anyone out;
        //   - deleting an admin likewise left their token working;
        //   - a token minted by the old unguarded POST /auth/register kept full
        //     access even after that route was removed.
        //
        // The account is now re-read on every request, so revocation is
        // immediate. That is one indexed primary-key lookup per admin request —
        // admin traffic is low, and correctness here is worth more than the
        // microseconds.
        const admin = await this.prisma.admin.findUnique({
            where: { id: decoded.id },
            select: { id: true, email: true, name: true, role: true, isActive: true, mfaEnabledAt: true },
        });

        if (!admin) throw new UnauthorizedException('Account no longer exists');
        if (!admin.isActive) throw new UnauthorizedException('Account is deactivated');

        // Role comes from the row, not the token, so a demotion takes effect on
        // the next request instead of at the next login.
        req.user = {
            id: admin.id,
            email: admin.email,
            role: this.normalizeRole(admin.role),
        };

        req.user.name = admin.name;

        // Changes need two things: a writer role, and a fresh code from the
        // account's own authenticator (X-MFA-Token, see MfaService). Enforced
        // here, on the guard every console route already uses, so a new write
        // endpoint is protected by default instead of by a decorator someone
        // has to remember. AuditInterceptor records every attempt.
        const method = String(req.method).toUpperCase();
        if (READ_METHODS.has(method)) return true;
        const path = String(req.originalUrl ?? req.url ?? '').split('?')[0];
        if (SELF_SERVICE_WRITES.some((w) => w.method === method && w.path.test(path))) return true;

        if (!WRITER_ROLES.has(req.user.role)) {
            throw new ForbiddenException('Read-only access: ask an admin to make this change');
        }
        if (!admin.mfaEnabledAt) {
            throw new ForbiddenException({ code: 'MFA_SETUP_REQUIRED', message: 'Set up your authenticator app before making changes' });
        }
        const mfaToken = req.headers['x-mfa-token'];
        let mfa: { id?: string; typ?: string } | null = null;
        try {
            mfa = mfaToken ? this.jwt.verify(String(mfaToken)) : null;
        } catch {
            mfa = null;
        }
        if (!mfa || mfa.typ !== MFA_TOKEN_TYPE || mfa.id !== admin.id) {
            throw new ForbiddenException({ code: 'MFA_REQUIRED', message: 'Enter the code from your authenticator app' });
        }
        req.user.mfaVerified = true;
        return true;
    }
}
