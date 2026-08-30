import {
    All,
    Body,
    Controller,
    ForbiddenException,
    HttpCode,
    Param,
    Post,
    Req,
    UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AppAdminService } from './app-admin.service';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { AppAccessGuard } from '../../common/guards/app-access.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { User } from '../../common/decorators/user.decorator';

/**
 * App-specific admin activities, federated to each app's own backend.
 *
 * e.g. GET /admin/apps/:id/backend/api/dukandar/stats
 *        → GET <App.backendBaseUrl>/api/dukandar/stats
 *
 * Blocked for LEAD_GEN — this can drive write actions on the app backend, and
 * lead-gen users are read-only. Their Leads/Users phone enrichment runs
 * server-side in AnalyticsService, not through this route.
 */
@Controller('admin/apps/:id')
@UseGuards(JwtGuard, AppAccessGuard, RolesGuard)
@Roles('ADMIN', 'COLLABORATOR')
export class AppAdminController {
    constructor(private appAdmin: AppAdminService) { }

    /**
     * Purge users (single or bulk) via the app's own deletion process.
     * ADMIN-only — method-level @Roles overrides the class allow-list. Use
     * { dryRun: true } to preview the matched set before deleting.
     */
    @Post('users/purge')
    @HttpCode(200)
    @Roles('ADMIN')
    purgeUsers(
        @Param('id') id: string,
        @Body() body: { externalUserIds?: string[]; inactiveDays?: number; dryRun?: boolean },
        @User() user: { id: string; email?: string },
    ) {
        return this.appAdmin.purgeUsers(id, body, user);
    }

    /**
     * Drop telemetry for users the app's backend has already deleted on its own
     * side. ADMIN-only. Distinct from users/purge, which asks the backend to do
     * the deleting — here it has already happened, so that DELETE would 404.
     */
    @Post('users/purge-deleted')
    @HttpCode(200)
    @Roles('ADMIN')
    purgeDeletedUsers(@Param('id') id: string, @Body() body: { dryRun?: boolean }) {
        return this.appAdmin.purgeDeletedUsers(id, body ?? {});
    }

    /**
     * `X-Impersonate-User-Id` on an inbound request is forwarded to the app's
     * backend, which is how the console's read-only "view as" renders one
     * user's own records. Deliberately taken from a header rather than the path
     * or query: every existing caller keeps working untouched, and a request
     * that omits it cannot accidentally become an impersonated one.
     *
     * Nothing is trusted from the browser beyond the id itself — the acting
     * admin comes from the JWT, and the service rejects any impersonated
     * method other than GET.
     */
    @All('backend/*')
    proxy(
        @Param('id') id: string,
        @Req() req: Request,
        @Body() body: unknown,
        @User() user: { id: string; email?: string; role?: string },
    ) {
        // Express 4 exposes the wildcard segment as params[0].
        const subPath = (req.params as Record<string, string>)['0'] ?? '';
        const impersonateUserId = req.headers['x-impersonate-user-id'];

        // Reads stay open to COLLABORATOR; writes do not. Every deliberate
        // destructive route on this controller is already @Roles('ADMIN'), and
        // this wildcard reaches the same app backends by another path — a
        // COLLABORATOR could POST the app's own bulk-delete through here and
        // get exactly what purgeUsers refuses them. The class-level allow-list
        // cannot express this, because it cannot see the HTTP method.
        if (req.method.toUpperCase() !== 'GET' && user?.role !== 'ADMIN') {
            throw new ForbiddenException(
                'Only an ADMIN may send write requests to an app backend',
            );
        }
        return this.appAdmin.proxy(
            id,
            req.method,
            subPath,
            req.query as Record<string, any>,
            body,
            {
                impersonateUserId:
                    typeof impersonateUserId === 'string' && impersonateUserId.trim()
                        ? impersonateUserId.trim()
                        : undefined,
                admin: user,
            },
        );
    }
}
