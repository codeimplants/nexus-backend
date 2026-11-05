import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { ServerReportsService } from './server-reports.service';
import { ServerAlertsService } from './server-alerts.service';

/**
 * The dashboard's Server tab (All apps → Server).
 *
 * ADMIN only: it shows every app on the VPS, including ones a COLLABORATOR
 * is not assigned to, plus Linux accounts and process command lines.
 */
@Controller('admin/server')
@UseGuards(JwtGuard, RolesGuard)
@Roles('ADMIN')
export class ServerReportsController {
    constructor(private readonly reports: ServerReportsService, private readonly alerts: ServerAlertsService) { }

    /** The whole picture: server, every app, traffic, and what is out of the ordinary. */
    @Get('overview')
    overview() {
        return this.reports.overview();
    }

    /** Requests per IST day, whole server and per app (prod). */
    @Get('traffic')
    traffic(@Query('days') days?: string) {
        return this.reports.traffic(days);
    }

    /** One app's memory every 10 minutes. */
    @Get('apps/:id/history')
    history(@Param('id') id: string, @Query('hours') hours?: string) {
        return this.reports.appHistory(id, hours);
    }

    /** Sends a test alert email to ALERT_EMAIL_TO. */
    @Post('alerts/test')
    testAlert() {
        return this.alerts.test();
    }
}
