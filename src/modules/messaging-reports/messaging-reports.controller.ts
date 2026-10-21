import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { User } from '../../common/decorators/user.decorator';
import { MessagingReportsService } from './messaging-reports.service';

/**
 * The dashboard's Messages tab (All apps → Messages → OTP Usage Summary).
 *
 * ADMIN only: it spans every app, including ones a COLLABORATOR or LEAD_GEN is
 * not assigned to, and lists people by the last four digits of their phone.
 */
@Controller('admin/messaging')
@UseGuards(JwtGuard, RolesGuard)
@Roles('ADMIN')
export class MessagingReportsController {
    constructor(private readonly reports: MessagingReportsService) { }

    /** Totals, one row per app, and a day-by-day (or month-by-month) series. Dates are IST days, inclusive. */
    @Get('otp-summary')
    otpSummary(
        @Query('from') from: string | undefined,
        @Query('to') to: string | undefined,
        @User() user: { id: string },
    ) {
        return this.reports.otpSummary({ from, to }, user.id);
    }

    /** The people behind one app's codes, most first. */
    @Get('apps/:slug/users')
    appUsers(
        @Param('slug') slug: string,
        @Query('from') from: string | undefined,
        @Query('to') to: string | undefined,
        @Query('limit') limit: string | undefined,
        @User() user: { id: string },
    ) {
        return this.reports.appUsers(slug, { from, to, limit }, user.id);
    }
}
