import {
    CanActivate,
    ExecutionContext,
    Injectable,
    ForbiddenException,
    NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

/**
 * Ensures the current user has access to the app (Admin: all, Collaborator: only assigned).
 * Expects appId in request params as 'id' or 'appId'.
 */
@Injectable()
export class AppAccessGuard implements CanActivate {
    constructor(private prisma: PrismaService) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest();
        const user = req.user;
        if (!user?.id) return false;

        const appId = req.params.id ?? req.params.appId;
        if (!appId) return true; // No app scoped (e.g. list route)

        const app = await this.prisma.app.findUnique({
            where: { id: appId },
            select: { id: true },
        });
        if (!app) throw new NotFoundException('App not found');

        if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') return true;

        const hasAccess = await this.prisma.appCollaborator.findUnique({
            where: {
                appId_adminId: { appId, adminId: user.id },
            },
        });
        if (!hasAccess) throw new ForbiddenException('You do not have access to this project');
        return true;
    }
}
