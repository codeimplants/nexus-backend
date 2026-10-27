import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { User } from '../../common/decorators/user.decorator';
import { PaymentsReportsService } from './payments-reports.service';

/**
 * The dashboard's Payments tab (All apps → Payments → Payments Summary).
 *
 * ADMIN only: it spans every app's revenue, including apps a COLLABORATOR or
 * LEAD_GEN is not assigned to, and lists who paid by each app's user id.
 */
@Controller('admin/payments')
@UseGuards(JwtGuard, RolesGuard)
@Roles('ADMIN')
export class PaymentsReportsController {
    constructor(private readonly reports: PaymentsReportsService) { }

    /** Totals, one row per app, and a day-by-day (or month-by-month) series. Dates are IST days, inclusive. */
    @Get('summary')
    summary(
        @Query('from') from: string | undefined,
        @Query('to') to: string | undefined,
        @User() user: { id: string },
    ) {
        return this.reports.summary({ from, to }, user.id);
    }

    /** The people who paid one app, most money first. */
    @Get('apps/:slug/customers')
    appCustomers(
        @Param('slug') slug: string,
        @Query('from') from: string | undefined,
        @Query('to') to: string | undefined,
        @Query('limit') limit: string | undefined,
        @User() user: { id: string },
    ) {
        return this.reports.appCustomers(slug, { from, to, limit }, user.id);
    }
}
