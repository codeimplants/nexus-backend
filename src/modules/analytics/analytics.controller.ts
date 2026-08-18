import { BadRequestException, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AnalyticsService, EndUserSort, SortOrder, UsageGranularity } from './analytics.service';
import { FirebaseAnalyticsService } from '../firebase-analytics/firebase-analytics.service';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { AppAccessGuard } from '../../common/guards/app-access.guard';
import { User } from '../../common/decorators/user.decorator';

const GRANULARITIES: UsageGranularity[] = ['day', 'week', 'month', 'year'];
const END_USER_SORTS: EndUserSort[] = [
    'lastActive',
    'registered',
    'name',
    'phone',
    'timeSpent',
    'opens',
    'activeDays',
];

@Controller('admin/analytics')
@UseGuards(JwtGuard)
export class AnalyticsController {
    constructor(
        private analytics: AnalyticsService,
        private firebaseAnalytics: FirebaseAnalyticsService,
    ) { }

    @Get('overview')
    getOverview(@User() user: { id: string; role: string }) {
        return this.analytics.getOverview({ userId: user.id, role: user.role });
    }

    @Get('apps/:appId')
    @UseGuards(AppAccessGuard)
    getByApp(@Param('appId') appId: string) {
        return this.analytics.getByApp(appId);
    }

    // ---- Engagement / user statistics (per app, guarded by AppAccessGuard) ----

    @Get('apps/:appId/audience')
    @UseGuards(AppAccessGuard)
    getAudience(@Param('appId') appId: string, @Query('days') days?: string) {
        return this.analytics.getAudience(appId, days ? Number(days) : undefined);
    }

    /** Distinct users per day over the window — the DAU chart behind the
     * rolling "Active (30d)" figure that /audience returns. */
    @Get('apps/:appId/active-series')
    @UseGuards(AppAccessGuard)
    getActiveSeries(@Param('appId') appId: string, @Query('days') days?: string) {
        return this.analytics.getActiveSeries(appId, days ? Number(days) : undefined);
    }

    @Get('apps/:appId/growth')
    @UseGuards(AppAccessGuard)
    getGrowth(@Param('appId') appId: string, @Query('churnDays') churnDays?: string) {
        return this.analytics.getGrowth(appId, churnDays ? Number(churnDays) : undefined);
    }

    @Get('apps/:appId/users')
    @UseGuards(AppAccessGuard)
    getUsers(
        @Param('appId') appId: string,
        @Query('limit') limit?: string,
        @Query('offset') offset?: string,
        @Query('days') days?: string,
        @Query('inactiveDays') inactiveDays?: string,
        @Query('search') search?: string,
        @Query('sort') sort?: string,
        @Query('order') order?: string,
    ) {
        // An unknown sort falls back to the default rather than 400ing: the
        // column set is a UI detail, and a stale bookmark should still render
        // the table instead of an error.
        const column = END_USER_SORTS.includes(sort as EndUserSort)
            ? (sort as EndUserSort)
            : undefined;
        return this.analytics.getUsers(appId, {
            limit: limit ? Number(limit) : undefined,
            offset: offset ? Number(offset) : undefined,
            days: days ? Number(days) : undefined,
            inactiveDays: inactiveDays ? Number(inactiveDays) : undefined,
            search,
            sort: column,
            order: order === 'asc' || order === 'desc' ? (order as SortOrder) : undefined,
        });
    }

    @Get('apps/:appId/users/:userId/usage')
    @UseGuards(AppAccessGuard)
    getUserUsage(
        @Param('appId') appId: string,
        @Param('userId') userId: string,
        @Query('granularity') granularity?: string,
        @Query('from') from?: string,
        @Query('to') to?: string,
    ) {
        const g = (granularity ?? 'day') as UsageGranularity;
        if (!GRANULARITIES.includes(g)) {
            throw new BadRequestException(`granularity must be one of ${GRANULARITIES.join(', ')}`);
        }
        return this.analytics.getUserUsage(
            appId,
            userId,
            g,
            from ? new Date(from) : undefined,
            to ? new Date(to) : undefined,
        );
    }

    @Get('apps/:appId/leads')
    @UseGuards(AppAccessGuard)
    getLeads(
        @Param('appId') appId: string,
        @Query('minMinutes') minMinutes?: string,
        @Query('minSessions') minSessions?: string,
        @Query('minActiveDays') minActiveDays?: string,
        @Query('days') days?: string,
    ) {
        return this.analytics.getLeads(appId, {
            minMinutes: minMinutes ? Number(minMinutes) : undefined,
            minSessions: minSessions ? Number(minSessions) : undefined,
            minActiveDays: minActiveDays ? Number(minActiveDays) : undefined,
            days: days ? Number(days) : undefined,
        });
    }

    // ---- Firebase (GA4) federation — real numbers pulled from each app's own
    // Firebase project; empty/"connected: false" until App.ga4PropertyId is set
    // and the shared reporting service account is granted access on it. ----

    @Get('apps/:appId/firebase/overview')
    @UseGuards(AppAccessGuard)
    getFirebaseOverview(@Param('appId') appId: string, @Query('days') days?: string) {
        return this.firebaseAnalytics.getOverview(appId, days ? Number(days) : undefined);
    }

    @Get('apps/:appId/firebase/top-screens')
    @UseGuards(AppAccessGuard)
    getFirebaseTopScreens(
        @Param('appId') appId: string,
        @Query('days') days?: string,
        @Query('limit') limit?: string,
    ) {
        return this.firebaseAnalytics.getTopScreens(
            appId,
            days ? Number(days) : undefined,
            limit ? Number(limit) : undefined,
        );
    }

    @Get('apps/:appId/firebase/retention')
    @UseGuards(AppAccessGuard)
    getFirebaseRetention(@Param('appId') appId: string) {
        return this.firebaseAnalytics.getRetention(appId);
    }

    @Get('version-checks')
    getVersionChecks(
        @User() user: { id: string; role: string },
        @Query('eventType') eventType?: string,
    ) {
        return this.analytics.getVersionChecks({ userId: user.id, role: user.role }, eventType);
    }

    @Get('platform-distribution')
    getPlatformDistribution(@User() user: { id: string; role: string }) {
        return this.analytics.getPlatformDistribution({ userId: user.id, role: user.role });
    }
}
