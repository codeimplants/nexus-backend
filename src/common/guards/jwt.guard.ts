import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../database/prisma.service';

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
    private normalizeRole(role: string): 'ADMIN' | 'COLLABORATOR' | 'LEAD_GEN' {
        if (role === 'COLLABORATOR') return 'COLLABORATOR';
        if (role === 'LEAD_GEN') return 'LEAD_GEN';
        return 'ADMIN';
    }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest();
        const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.headers.authorization?.split(' ')[1];
        if (!token) throw new UnauthorizedException('Missing or invalid token');

        let decoded: JwtPayload;
        try {
            decoded = this.jwt.verify<JwtPayload>(token);
        } catch {
            throw new UnauthorizedException('Invalid or expired token');
        }

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
            select: { id: true, email: true, role: true, isActive: true },
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
        return true;
    }
}
