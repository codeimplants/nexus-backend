import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { VersionEngine, VersionRule, MaintenanceMode } from '../versions/version.engine';
import { VersionCheckDto, VersionCheckResponse } from './dto/version-check.dto';
import { IngestEventsDto, SdkEventDto, SdkEventNames } from './dto/event.dto';
import { IdentifyDto } from './dto/identify.dto';
import { DeviceRegisterDto } from './dto/device.dto';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';

@Injectable()
export class SdkService {
    private readonly logger = new Logger(SdkService.name);

    constructor(
        private prisma: PrismaService,
        private featureFlags: FeatureFlagsService,
    ) { }

    /** Validate an API key and return the owning app (id only). Throws on invalid/inactive. */
    private async requireApp(apiKey: string): Promise<{ id: string }> {
        if (!apiKey) {
            throw new UnauthorizedException('Missing API Key');
        }
        const app = await this.prisma.app.findUnique({
            where: { apiKey },
            select: { id: true, isActive: true },
        });
        if (!app) {
            throw new UnauthorizedException('Invalid API Key');
        }
        if (!app.isActive) {
            throw new UnauthorizedException('App is deactivated');
        }
        return { id: app.id };
    }

    /**
     * Version checks that arrived with neither a usable API key nor a resolvable
     * package name, counted since boot. A non-zero value means some build in the
     * wild cannot be identified at all — see getDiagnostics().
     */
    private unidentifiedVersionChecks = 0;

    /**
     * Version checks whose reported currentVersion could not be trusted, counted
     * since boot. Non-zero means some build in the wild is misreporting its own
     * version, and every version rule is silently doing nothing for it — see
     * VersionEngine.trustReportedVersion().
     */
    private untrustedVersionChecks = 0;

    /** Snapshot for the dashboard's misconfiguration warnings. */
    getDiagnostics(): { unidentifiedVersionChecks: number; untrustedVersionChecks: number } {
        return {
            unidentifiedVersionChecks: this.unidentifiedVersionChecks,
            untrustedVersionChecks: this.untrustedVersionChecks,
        };
    }

    /**
     * Resolve the app for a version check: API key first, package name second.
     *
     * App.appId carries no unique constraint, so the package-name path uses
     * findMany and takes the oldest active match. Two active apps sharing a
     * package name is a data-entry mistake, so it is warned about rather than
     * silently resolved one way or the other.
     */
    private async resolveAppForVersionCheck(apiKey: string, packageName?: string) {
        const include = { maintenanceMode: true, storeUrls: true };

        if (apiKey) {
            const app = await this.prisma.app.findUnique({ where: { apiKey }, include });
            if (!app) throw new UnauthorizedException('Invalid API Key');
            if (!app.isActive) throw new UnauthorizedException('App is deactivated');
            return app;
        }

        if (packageName) {
            const matches = await this.prisma.app.findMany({
                where: { appId: packageName, isActive: true },
                include,
                orderBy: { createdAt: 'asc' },
            });
            if (matches.length > 1) {
                this.logger.warn(
                    `Package name "${packageName}" matches ${matches.length} active apps; using the oldest. Give each app a distinct appId.`,
                );
            }
            if (matches.length > 0) {
                this.logger.log(
                    `Version check identified by package name "${packageName}" — no API key was sent. ` +
                    `Version control works, but engagement tracking does not: that build cannot call /sdk/events.`,
                );
                return matches[0];
            }
        }

        // Neither identifier worked. Reaching here always means no API key was
        // sent, since an invalid key throws above.
        //
        // Log periodically rather than per request: sonebill produced 880 of these
        // in twelve days and every one was an unread single line. A running total
        // at intervals is greppable and hard to mistake for routine noise.
        this.unidentifiedVersionChecks += 1;
        if (this.unidentifiedVersionChecks % 100 === 1) {
            this.logger.warn(
                `${this.unidentifiedVersionChecks} version check(s) since boot could not be attributed to any app ` +
                `(no API key, and package name "${packageName ?? 'not sent'}" matched nothing). ` +
                `Some build in the wild is misconfigured, or an app is missing its appId in nexus.`,
            );
        }
        throw new UnauthorizedException('Missing API Key');
    }

    async checkVersion(
        apiKey: string,
        data: VersionCheckDto,
    ): Promise<VersionCheckResponse> {
        try {
            // 1. Identify the app.
            //
            // The API key is preferred, but version/check deliberately also accepts
            // the package name (data.appId, which the SDK auto-detects natively via
            // VCAppInfo / react-native-device-info and sends without any config).
            //
            // Why: force-update and the kill switch are the only remedy for a bad
            // release, and they must not depend on a value that a build can ship
            // empty. Sonebill 1.0.15 did exactly that — an unset VITE_VC_API_KEY
            // compiled to '', so every check 401'd and the app was unreachable.
            // The package name is compiled into the binary by the platform itself
            // and cannot be misconfigured.
            //
            // This fallback is limited to version/check, which only reveals whether
            // a newer version exists. Writes (/sdk/device, /sdk/events,
            // /sdk/user/identify) still require the key via requireApp().
            const app = await this.resolveAppForVersionCheck(apiKey, data.appId);

            // 2. Track device (async, non-blocking)
            this.trackDevice(app.id, data).catch((err) => {
                this.logger.error('Failed to track device', err);
            });

            // 3. Get version rules for the platform/environment
            const rules = await this.prisma.versionRule.findMany({
                where: {
                    appId: app.id,
                    platform: { in: [data.platform, 'all'] },
                    environment: data.environment,
                    isActive: true,
                },
                orderBy: {
                    priority: 'desc',
                },
            });

            // Map Prisma rules to VersionRule interface, transforming null dates to undefined
            const mappedRules: VersionRule[] = rules.map(rule => ({
                killSwitch: rule.killSwitch,
                blockedVersions: rule.blockedVersions,
                latestVersion: rule.latestVersion,
                updateType: rule.updateType,
                messageConfig: rule.messageConfig,
                isActive: rule.isActive,
                priority: rule.priority,
                rolloutPercentage: rule.rolloutPercentage,
                startDate: rule.startDate || undefined,
                endDate: rule.endDate || undefined,
            }));

            // 4. Get store URL for the platform
            const storeUrl = app.storeUrls.find(
                (url) => url.platform === data.platform,
            )?.storeUrl;

            // 5. Evaluate version using the engine
            const evaluationContext = {
                currentVersion: data.currentVersion,
                buildNumber: data.buildNumber,
                deviceId: data.deviceId,
            };

            // Map maintenance mode to interface
            const maintenanceMode: MaintenanceMode | undefined = app.maintenanceMode ? {
                isEnabled: app.maintenanceMode.isEnabled,
                title: app.maintenanceMode.title,
                message: app.maintenanceMode.message,
                estimatedEnd: app.maintenanceMode.estimatedEnd || undefined,
            } : undefined;

            let result;

            if (mappedRules.length > 0) {
                result = VersionEngine.evaluateMultiple(
                    mappedRules,
                    evaluationContext,
                    maintenanceMode,
                    storeUrl,
                );
            } else {
                result = VersionEngine.evaluate(
                    null,
                    evaluationContext,
                    maintenanceMode,
                    storeUrl,
                );
            }

            // 5b. A rule was in play but the client's own version was not usable,
            // so no update was served. Logged loudly and rate-limited, because the
            // visible symptom on the device is the opposite of the cause: the app
            // looks fine, while a rule that reads as active in the dashboard is
            // quietly reaching nobody on that platform.
            const untrustedVersion = (result as { untrustedVersion?: string }).untrustedVersion;
            if (untrustedVersion) {
                this.untrustedVersionChecks += 1;
                if (this.untrustedVersionChecks % 100 === 1) {
                    this.logger.warn(
                        `${this.untrustedVersionChecks} version check(s) since boot were answered NONE ` +
                        `because the reported version could not be trusted (latest: ${data.platform}/` +
                        `${data.environment} — ${untrustedVersion}). Version rules cannot reach these ` +
                        `installs at all; fix version detection in the client build.`,
                    );
                }
            }

            // 6. Log analytics (async, non-blocking)
            this.logAnalytics(app.id, data, result.status).catch((err) => {
                this.logger.error('Failed to log analytics', err);
            });

            // 7. Feature flags for this app and platform.
            //
            // Deliberately best-effort and non-fatal. This endpoint's job is
            // force-update and the kill switch — the only remedy for a bad release
            // — so a failure while reading a convenience field must never take it
            // down. A flag that fails to load is simply absent, and clients read
            // absent as "use your own default", never as "off".
            let featureFlags: Record<string, boolean> | undefined;
            try {
                featureFlags = await this.featureFlags.forSdk(app.id, data.platform);
            } catch (err) {
                this.logger.error('Failed to read feature flags; serving without them', err);
            }

            // 8. Return response
            return {
                ...result,
                ...(featureFlags ? { featureFlags } : {}),
                deviceTracked: !!data.deviceId,
                analytics: true,
            } as VersionCheckResponse;
        } catch (error) {
            this.logger.error('Error checking version', error);
            throw error;
        }
    }

    /**
     * Track or update device information
     */
    private async trackDevice(
        appId: string,
        data: VersionCheckDto,
    ): Promise<void> {
        if (!data.deviceId) return;

        // Promote device make/model from metadata to first-class columns (kept in
        // metadata too for backward-compat). Accept a few common key spellings.
        const meta = (data.metadata ?? {}) as Record<string, any>;
        const make = meta.make ?? meta.brand ?? undefined;
        const model = meta.model ?? meta.deviceModel ?? undefined;
        const manufacturer = meta.manufacturer ?? undefined;

        try {
            await this.prisma.device.upsert({
                where: {
                    appId_deviceId: {
                        appId,
                        deviceId: data.deviceId,
                    },
                },
                create: {
                    appId,
                    deviceId: data.deviceId,
                    platform: data.platform,
                    osVersion: data.osVersion,
                    appVersion: data.currentVersion as any,
                    buildNumber: data.buildNumber,
                    make,
                    model,
                    manufacturer,
                    metadata: data.metadata,
                    lastCheckIn: new Date(),
                    firstSeen: new Date(),
                },
                update: {
                    appVersion: data.currentVersion as any,
                    buildNumber: data.buildNumber,
                    osVersion: data.osVersion,
                    ...(make ? { make } : {}),
                    ...(model ? { model } : {}),
                    ...(manufacturer ? { manufacturer } : {}),
                    lastCheckIn: new Date(),
                    metadata: data.metadata,
                    isActive: true,
                },
            });
        } catch (error) {
            this.logger.error('Failed to track device', error);
            // Don't throw - device tracking is non-critical
        }
    }

    /**
     * VersionEngine returns its outcome as an uppercase status; AppAnalytics'
     * eventType is stored/queried as lowercase snake_case (see analytics.service.ts).
     * Keep this map as the single source of truth for that translation.
     */
    private static readonly EVENT_TYPE_BY_STATUS: Record<string, string> = {
        NONE: 'version_check',
        SOFT_UPDATE: 'update_soft',
        FORCE_UPDATE: 'update_force',
        KILL_SWITCH: 'kill_switch',
        BLOCKED: 'blocked',
        MAINTENANCE: 'maintenance',
    };

    /**
     * Log analytics event
     */
    private async logAnalytics(
        appId: string,
        data: VersionCheckDto,
        status: string,
    ): Promise<void> {
        try {
            const eventType = SdkService.EVENT_TYPE_BY_STATUS[status] ?? status;
            await this.prisma.appAnalytics.create({
                data: {
                    appId,
                    platform: data.platform,
                    environment: data.environment,
                    version: data.currentVersion as any,
                    eventType,
                    deviceId: data.deviceId,
                    metadata: {
                        buildNumber: data.buildNumber,
                        osVersion: data.osVersion,
                        ...data.metadata,
                    },
                },
            });
        } catch (error) {
            this.logger.error('Failed to log analytics', error);
            // Don't throw - analytics is non-critical
        }
    }

    // ---------------------------------------------------------------------
    // Engagement ingest
    // ---------------------------------------------------------------------

    /**
     * Register/refresh a device. Backs "installed devices" and the make/model
     * split — the version-check client sends no deviceId, so this is the only
     * path that actually populates Device for mobile clients.
     */
    async registerDevice(apiKey: string, data: DeviceRegisterDto) {
        const app = await this.requireApp(apiKey);
        const now = new Date();

        await this.prisma.device.upsert({
            where: { appId_deviceId: { appId: app.id, deviceId: data.deviceId } },
            create: {
                appId: app.id,
                deviceId: data.deviceId,
                platform: data.platform,
                osVersion: data.osVersion,
                appVersion: data.appVersion,
                buildNumber: data.buildNumber,
                make: data.make,
                model: data.model,
                manufacturer: data.manufacturer,
                metadata: data.metadata as any,
                lastCheckIn: now,
                firstSeen: now,
            },
            update: {
                platform: data.platform,
                ...(data.osVersion ? { osVersion: data.osVersion } : {}),
                ...(data.appVersion ? { appVersion: data.appVersion } : {}),
                ...(data.buildNumber ? { buildNumber: data.buildNumber } : {}),
                ...(data.make ? { make: data.make } : {}),
                ...(data.model ? { model: data.model } : {}),
                ...(data.manufacturer ? { manufacturer: data.manufacturer } : {}),
                ...(data.metadata ? { metadata: data.metadata as any } : {}),
                lastCheckIn: now,
                isActive: true,
            },
        });

        return { registered: true };
    }

    /**
     * Ingest a batch of engagement events. APP_OPEN opens a foreground session;
     * APP_BACKGROUND closes the latest open session for the device, computes its
     * duration, and rolls the completed session into the per-user DailyUsage
     * bucket. Other events only refresh the end user's last-active time.
     * Best-effort: one bad event never fails the batch.
     */
    async ingestEvents(apiKey: string, body: IngestEventsDto) {
        const app = await this.requireApp(apiKey);
        let accepted = 0;
        for (const event of body.events) {
            try {
                await this.handleEvent(app.id, event);
                accepted += 1;
            } catch (error) {
                this.logger.error(`Failed to ingest event "${event.name}"`, error);
            }
        }
        return { accepted, received: body.events.length };
    }

    private async handleEvent(appId: string, event: SdkEventDto): Promise<void> {
        const at = event.ts ? new Date(event.ts) : new Date();
        const endUserId = event.externalUserId
            ? await this.resolveEndUserId(appId, event.externalUserId, event.platform)
            : null;

        if (endUserId) {
            await this.touchEndUser(endUserId, at);
        }

        switch (event.name) {
            case SdkEventNames.APP_OPEN:
                await this.prisma.usageSession.create({
                    data: {
                        appId,
                        endUserId,
                        deviceId: event.deviceId,
                        platform: event.platform,
                        appVersion: event.appVersion,
                        startedAt: at,
                    },
                });
                break;

            case SdkEventNames.APP_BACKGROUND:
                await this.closeSession(appId, event.deviceId, at);
                break;

            default:
                // login_success / screen_view / etc. — user last-active already touched above.
                break;
        }
    }

    /** Close the most recent still-open session for a device and roll it up. */
    private async closeSession(appId: string, deviceId: string, endedAt: Date): Promise<void> {
        const open = await this.prisma.usageSession.findFirst({
            where: { appId, deviceId, endedAt: null },
            orderBy: { startedAt: 'desc' },
        });
        if (!open) return;

        const durationSec = Math.max(
            0,
            Math.round((endedAt.getTime() - open.startedAt.getTime()) / 1000),
        );

        await this.prisma.usageSession.update({
            where: { id: open.id },
            data: { endedAt, durationSec },
        });

        // Attribute the completed session to the user's day (session start day).
        if (open.endUserId) {
            await this.addToDailyUsage(appId, open.endUserId, open.startedAt, durationSec);
        }
    }

    /**
     * Link a device to a logged-in end user. Upserts the EndUser (registeredAt is
     * set on first insert) and backfills the device's still-open session so its
     * usage is attributed once the session closes.
     */
    async identifyUser(apiKey: string, body: IdentifyDto) {
        const app = await this.requireApp(apiKey);
        const endUserId = await this.resolveEndUserId(
            app.id,
            body.externalUserId,
            body.platform,
            body.authMethod,
        );

        // Link the device to this user (device row is created by version/check).
        await this.prisma.device.updateMany({
            where: { appId: app.id, deviceId: body.deviceId },
            data: { endUserId },
        });

        // Backfill an anonymous open session started before login.
        await this.prisma.usageSession.updateMany({
            where: { appId: app.id, deviceId: body.deviceId, endedAt: null, endUserId: null },
            data: { endUserId },
        });

        return { identified: true };
    }

    /** Upsert an EndUser by (appId, externalUserId) and return its id. */
    private async resolveEndUserId(
        appId: string,
        externalUserId: string,
        platform?: string,
        authMethod?: string,
    ): Promise<string> {
        const user = await this.prisma.endUser.upsert({
            where: { appId_externalUserId: { appId, externalUserId } },
            create: { appId, externalUserId, platform, authMethod },
            // Only fill platform/authMethod if not already known; never overwrite registeredAt.
            update: {
                ...(platform ? { platform } : {}),
                ...(authMethod ? { authMethod } : {}),
            },
            select: { id: true },
        });
        return user.id;
    }

    private async touchEndUser(endUserId: string, at: Date): Promise<void> {
        await this.prisma.endUser.update({
            where: { id: endUserId },
            data: { lastActiveAt: at },
        });
    }

    /** Increment the per-user, per-day usage rollup for a completed session. */
    private async addToDailyUsage(
        appId: string,
        endUserId: string,
        sessionStart: Date,
        durationSec: number,
    ): Promise<void> {
        const date = this.utcDay(sessionStart);
        await this.prisma.dailyUsage.upsert({
            where: { appId_endUserId_date: { appId, endUserId, date } },
            create: {
                appId,
                endUserId,
                date,
                totalDurationSec: durationSec,
                openCount: 1,
                sessionCount: 1,
            },
            update: {
                totalDurationSec: { increment: durationSec },
                openCount: { increment: 1 },
                sessionCount: { increment: 1 },
            },
        });
    }

    /** Midnight-UTC bucket for a timestamp (matches the @db.Date column). */
    private utcDay(d: Date): Date {
        return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    }

    /**
     * Get app statistics
     */
    async getAppStats(apiKey: string) {
        if (!apiKey) {
            throw new UnauthorizedException('Missing API Key');
        }

        const app = await this.prisma.app.findUnique({
            where: { apiKey },
            include: {
                _count: {
                    select: {
                        devices: true,
                        analytics: true,
                        rules: true,
                    },
                },
            },
        });

        if (!app) {
            throw new UnauthorizedException('Invalid API Key');
        }

        // Get active devices (checked in last 7 days)
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const activeDevices = await this.prisma.device.count({
            where: {
                appId: app.id,
                lastCheckIn: {
                    gte: sevenDaysAgo,
                },
            },
        });

        return {
            totalDevices: app._count.devices,
            activeDevices,
            totalAnalytics: app._count.analytics,
            totalRules: app._count.rules,
        };
    }
}