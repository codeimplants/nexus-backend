import { Injectable, Logger } from '@nestjs/common';
import { BetaAnalyticsDataClient } from '@google-analytics/data';
import { PrismaService } from '../../database/prisma.service';

/**
 * Server-side pull of each app's own Firebase Analytics (GA4) data, so a
 * per-app Nexus dashboard can show real Firebase-sourced usage metrics
 * (active users, top screens, retention) without Nexus re-deriving any of
 * that from raw ingested events — screen views, session engagement and
 * retention are Firebase's job, not this platform's.
 *
 * Auth model: ONE shared Nexus-wide GA4 reporting service account (its key
 * lives outside the DB, at GA4_SERVICE_ACCOUNT_KEY_PATH), not a credential per
 * app. Each app's GA4 property grants that one service account's email
 * "Viewer" access via Firebase Console > Property Access Management — Nexus
 * only needs to know the property id (App.ga4PropertyId), which isn't a
 * secret.
 */
@Injectable()
export class FirebaseAnalyticsService {
    private readonly logger = new Logger(FirebaseAnalyticsService.name);
    private client: BetaAnalyticsDataClient | null | undefined;

    constructor(private prisma: PrismaService) { }

    /** Never throws — returns null when unconfigured so dashboards degrade to an empty state, not a 500. */
    private getClient(): BetaAnalyticsDataClient | null {
        if (this.client !== undefined) return this.client;
        const keyFile = process.env.GA4_SERVICE_ACCOUNT_KEY_PATH;
        if (!keyFile) {
            this.logger.warn('GA4_SERVICE_ACCOUNT_KEY_PATH is not set; Firebase Analytics widgets will report as disconnected');
            this.client = null;
            return null;
        }
        this.client = new BetaAnalyticsDataClient({ keyFilename: keyFile });
        return this.client;
    }

    private async resolvePropertyId(appId: string): Promise<string | null> {
        const app = await this.prisma.app.findUnique({
            where: { id: appId },
            select: { ga4PropertyId: true },
        });
        return app?.ga4PropertyId ?? null;
    }

    async getOverview(appId: string, days = 30) {
        const propertyId = await this.resolvePropertyId(appId);
        const client = this.getClient();
        if (!propertyId || !client) {
            return { connected: false, propertyId, activeUsers: null, engagedSessions: null, averageEngagementTimeSec: null };
        }

        try {
            const [response] = await client.runReport({
                property: `properties/${propertyId}`,
                dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
                metrics: [{ name: 'activeUsers' }, { name: 'engagedSessions' }, { name: 'userEngagementDuration' }],
            });
            const values = response.rows?.[0]?.metricValues ?? [];
            const activeUsers = Number(values[0]?.value ?? 0);
            const engagedSessions = Number(values[1]?.value ?? 0);
            const engagementDurationSec = Number(values[2]?.value ?? 0);
            return {
                connected: true,
                propertyId,
                activeUsers,
                engagedSessions,
                averageEngagementTimeSec: activeUsers > 0 ? Math.round(engagementDurationSec / activeUsers) : 0,
            };
        } catch (error) {
            this.logger.warn(`GA4 overview failed for app ${appId}: ${String(error)}`);
            return { connected: false, propertyId, activeUsers: null, engagedSessions: null, averageEngagementTimeSec: null };
        }
    }

    async getTopScreens(appId: string, days = 30, limit = 20) {
        const propertyId = await this.resolvePropertyId(appId);
        const client = this.getClient();
        if (!propertyId || !client) {
            return { connected: false, propertyId, screens: [] as { screen: string; views: number }[] };
        }

        try {
            const [response] = await client.runReport({
                property: `properties/${propertyId}`,
                dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
                dimensions: [{ name: 'unifiedScreenName' }],
                metrics: [{ name: 'screenPageViews' }],
                orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
                limit,
            });
            const screens = (response.rows ?? []).map((row) => ({
                screen: row.dimensionValues?.[0]?.value ?? 'unknown',
                views: Number(row.metricValues?.[0]?.value ?? 0),
            }));
            return { connected: true, propertyId, screens };
        } catch (error) {
            this.logger.warn(`GA4 top-screens failed for app ${appId}: ${String(error)}`);
            return { connected: false, propertyId, screens: [] as { screen: string; views: number }[] };
        }
    }

    /** D-N retention off a rolling 30-day acquisition window, via GA4's own cohort report. */
    async getRetention(appId: string) {
        const propertyId = await this.resolvePropertyId(appId);
        const client = this.getClient();
        if (!propertyId || !client) {
            return { connected: false, propertyId, cohorts: [] as { dayOffset: number; activeUsers: number }[] };
        }

        try {
            const [response] = await client.runReport({
                property: `properties/${propertyId}`,
                dimensions: [{ name: 'cohort' }, { name: 'cohortNthDay' }],
                metrics: [{ name: 'cohortActiveUsers' }],
                cohortSpec: {
                    cohorts: [
                        {
                            name: 'cohort',
                            dimension: 'firstSessionDate',
                            dateRange: { startDate: '30daysAgo', endDate: 'today' },
                        },
                    ],
                    cohortsRange: {
                        granularity: 'DAILY',
                        startOffset: 0,
                        endOffset: 30,
                    },
                },
            });
            const cohorts = (response.rows ?? []).map((row) => ({
                dayOffset: Number(row.dimensionValues?.[1]?.value ?? 0),
                activeUsers: Number(row.metricValues?.[0]?.value ?? 0),
            }));
            return { connected: true, propertyId, cohorts };
        } catch (error) {
            this.logger.warn(`GA4 retention failed for app ${appId}: ${String(error)}`);
            return { connected: false, propertyId, cohorts: [] as { dayOffset: number; activeUsers: number }[] };
        }
    }
}
