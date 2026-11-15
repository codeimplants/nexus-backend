import {
    CanActivate,
    ExecutionContext,
    Injectable,
    ForbiddenException,
    NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

/**
 * Guard for rule-scoped routes. Reads rule id from param 'id', resolves appId from the rule, then checks user access.
 */
@Injectable()
export class RuleAccessGuard implements CanActivate {
    constructor(private prisma: PrismaService) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest();
        const user = req.user;
        if (!user?.id) return false;

        const ruleId = req.params.id;
        if (!ruleId) return true;

        const rule = await this.prisma.versionRule.findUnique({
            where: { id: ruleId },
            select: { appId: true },
        });
        if (!rule) throw new NotFoundException('Rule not found');

        if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') return true;

        const hasAccess = await this.prisma.appCollaborator.findUnique({
            where: {
                appId_adminId: { appId: rule.appId, adminId: user.id },
            },
        });
        if (!hasAccess) throw new ForbiddenException('You do not have access to this project');
        return true;
    }
}
