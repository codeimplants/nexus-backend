import {
    CanActivate,
    ExecutionContext,
    Injectable,
    ForbiddenException,
    NotFoundException,
    BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

/**
 * Checks that the user has access to the app specified in request body (e.g. body.appId).
 * Use for POST /admin/rules when appId is in body.
 */
@Injectable()
export class BodyAppAccessGuard implements CanActivate {
    constructor(private prisma: PrismaService) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest();
        const user = req.user;
        if (!user?.id) return false;

        const appId = req.body?.appId;
        if (!appId) throw new BadRequestException('appId is required');

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
