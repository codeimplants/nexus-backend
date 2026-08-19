export interface VersionRule {
    killSwitch: boolean;
    blockedVersions: string[];
    latestVersion: string;
    updateType: string;
    messageConfig: any;
    isActive: boolean;
    priority: number;
    rolloutPercentage: number;
    startDate?: Date;
    endDate?: Date;
}

export interface MaintenanceMode {
    isEnabled: boolean;
    title: string;
    message: string;
    estimatedEnd?: Date;
}

interface EvaluationContext {
    currentVersion?: string;
    buildNumber?: string;
    deviceId?: string;
}

export class VersionEngine {
    /**
     * Main evaluation method
     */
    static evaluate(
        rule: VersionRule | null,
        context: EvaluationContext,
        maintenanceMode?: MaintenanceMode,
        storeUrl?: string,
    ) {
        // 1. Check Global App Maintenance Mode First
        if (maintenanceMode?.isEnabled) {
            return {
                status: 'MAINTENANCE',
                title: maintenanceMode.title,
                message: maintenanceMode.message,
                estimatedEnd: maintenanceMode.estimatedEnd,
                blockVersion: true,
            };
        }

        // No rule found - allow access
        if (!rule) {
            return { status: 'NONE' };
        }

        // 2. Check Rule Status (Active/Dates/Rollout)
        if (!rule.isActive) {
            return { status: 'NONE' };
        }

        if (!this.isRuleActive(rule)) {
            return { status: 'NONE' };
        }

        if (!this.shouldApplyRule(rule, context.deviceId)) {
            return { status: 'NONE' };
        }

        // 3. Rule-based Maintenance (Matches Update Type 'maintenance')
        // This applies regardless of the user's current version
        if (rule.updateType === 'maintenance') {
            return {
                status: 'MAINTENANCE',
                title: rule.messageConfig?.title || rule.messageConfig?.maintenanceTitle || 'Under Maintenance',
                message: rule.messageConfig?.message || rule.messageConfig?.maintenanceMessage || 'We are currently performing maintenance. Please check back soon.',
                customMessage: rule.messageConfig,
                blockVersion: true,
                storeUrl,
            };
        }

        // 4. Kill Switch (Highest priority rule violation)
        if (rule.killSwitch) {
            return {
                status: 'KILL_SWITCH',
                title: rule.messageConfig?.title || 'App Disabled',
                message: rule.messageConfig?.message || 'This app is currently unavailable.',
                customMessage: rule.messageConfig,
                blockVersion: true,
            };
        }

        // 5. Blocked Versions
        if (context.currentVersion && rule.blockedVersions?.includes(context.currentVersion)) {
            return {
                status: 'BLOCKED',
                title: rule.messageConfig?.blockedTitle || 'Version Blocked',
                message:
                    rule.messageConfig?.blockedMessage ||
                    'This version is no longer supported. Please update to continue.',
                customMessage: rule.messageConfig,
                blockVersion: true,
                storeUrl,
            };
        }



        // 6. GUARD — only act on a reported version we can believe.
        //
        // Everything below this point decides whether to nag or lock a user purely
        // on the version string the client sent. A client that reports the wrong
        // version therefore gets an update prompt it can never satisfy: it updates,
        // reports the same wrong version, and is prompted again — with nothing to
        // install in the store, because it is already up to date. That loop is
        // unfixable from the user’s side, and fixable from ours only by switching
        // the rule off for everyone.
        //
        // Sonebill iOS 1.0.16 did exactly that. The SDK ships no VCAppInfo native
        // module for iOS, so its detection fell through to expo-constants, which
        // returns the *expo app config* version — defaulted from package.json to
        // "0.0.1" — and not CFBundleShortVersionString. Every iOS install reported
        // 0.0.1, sat below every rule, and was force-updated on loop.
        //
        // So: a version we cannot trust suppresses SOFT/FORCE and nothing else.
        // Kill switch, maintenance and the explicit blocked list are evaluated
        // above and stay reachable — they are the remedy for a bad release and
        // must never depend on the client getting version detection right.
        const trust = this.trustReportedVersion(context.currentVersion);
        if (!trust.trusted) {
            return {
                status: 'NONE',
                latestVersion: rule.latestVersion,
                untrustedVersion: trust.reason,
            };
        }

        // Handle updates when below latest version but above min version
        const isBelowLatest = this.compareVersions(context.currentVersion, rule.latestVersion) < 0;

        if (isBelowLatest) {
            if (rule.updateType === 'soft') {
                return {
                    status: 'SOFT_UPDATE',
                    title: rule.messageConfig?.softTitle || rule.messageConfig?.title || 'Update Available',
                    message:
                        rule.messageConfig?.softMessage ||
                        rule.messageConfig?.message ||
                        'A new version is available. Update for the best experience.',
                    buttonText: rule.messageConfig?.softButtonText || rule.messageConfig?.buttonText || 'Update',
                    customMessage: rule.messageConfig,
                    latestVersion: rule.latestVersion,
                    blockVersion: false,
                    storeUrl,
                };
            }

            if (rule.updateType === 'force') {
                return {
                    status: 'FORCE_UPDATE',
                    title: rule.messageConfig?.forceTitle || rule.messageConfig?.title || 'Update Required',
                    message:
                        rule.messageConfig?.forceMessage ||
                        rule.messageConfig?.message ||
                        'Please update to the latest version to continue.',
                    buttonText: rule.messageConfig?.forceButtonText || rule.messageConfig?.buttonText || 'Update Now',
                    customMessage: rule.messageConfig,
                    latestVersion: rule.latestVersion,
                    blockVersion: true,
                    storeUrl,
                };
            }
        }

        // All checks passed
        return {
            status: 'NONE',
            latestVersion: rule.latestVersion
        };
    }

    /**
     * Compare two semantic versions
     * Returns: -1 if v1 < v2, 0 if v1 === v2, 1 if v1 > v2
     */
    static compareVersions(v1: string | undefined | null, v2: string | undefined | null): number {
        if (!v1 && !v2) return 0;
        if (!v1) return -1; // Unknown current version is below anything
        if (!v2) return 1;  // Anything is above unknown latest version

        const v1Clean = v1.replace(/[^0-9.]/g, '');
        const v2Clean = v2.replace(/[^0-9.]/g, '');

        const v1Parts = v1Clean.split('.').map(Number);
        const v2Parts = v2Clean.split('.').map(Number);
        const maxLength = Math.max(v1Parts.length, v2Parts.length);

        for (let i = 0; i < maxLength; i++) {
            const v1Part = v1Parts[i] || 0;
            const v2Part = v2Parts[i] || 0;

            if (v1Part > v2Part) return 1;
            if (v1Part < v2Part) return -1;
        }

        return 0;
    }

    /**
     * Decide whether a client-reported version is worth comparing against.
     *
     * Only ever used to *suppress* update decisions, never to create one, so
     * every uncertain case answers "untrusted" and the user is left alone. The
     * cost of a false negative is one missed update nag; the cost of a false
     * positive is an install locked out of the app with no way to comply.
     *
     * Untrusted when:
     *  - nothing was sent. The SDK omits currentVersion whenever its detection
     *    chain comes up empty, which says nothing about how old the install is.
     *  - no digits survive parsing, so compareVersions() would read it as 0.
     *  - it is 0.0.x. That is the scaffold default — react-native init writes
     *    "0.0.1" into package.json, and it is what leaks through when a version
     *    is read from project metadata instead of from the installed binary.
     *    Nothing gets through a store review at 0.0.x while a live rule targets
     *    a real release, so this is a detection failure every time.
     */
    static trustReportedVersion(
        currentVersion?: string,
    ): { trusted: true } | { trusted: false; reason: string } {
        if (!currentVersion || !currentVersion.trim()) {
            return { trusted: false, reason: 'client sent no version' };
        }

        const parts = currentVersion
            .replace(/[^0-9.]/g, '')
            .split('.')
            .filter((part) => part !== '');

        if (parts.length === 0) {
            return {
                trusted: false,
                reason: `client sent an unparseable version "${currentVersion}"`,
            };
        }

        const major = Number(parts[0]);
        const minor = Number(parts[1] ?? 0);

        if (major === 0 && minor === 0) {
            return {
                trusted: false,
                reason:
                    `client reported the scaffold placeholder version "${currentVersion}" — it is ` +
                    `reading its version from project metadata, not from the installed binary`,
            };
        }

        return { trusted: true };
    }

    /**
     * Check if rule is active based on start/end dates
     */
    private static isRuleActive(rule: VersionRule): boolean {
        const now = new Date();

        if (rule.startDate && now < new Date(rule.startDate)) {
            return false;
        }

        if (rule.endDate && now > new Date(rule.endDate)) {
            return false;
        }

        return true;
    }

    /**
     * Gradual rollout logic based on percentage
     * Uses deviceId hash to determine if rule should apply
     */
    private static shouldApplyRule(rule: VersionRule, deviceId?: string): boolean {
        // If 100%, always apply
        if (rule.rolloutPercentage >= 100) {
            return true;
        }

        // If no deviceId, apply based on random chance
        if (!deviceId) {
            return Math.random() * 100 < rule.rolloutPercentage;
        }

        // Hash deviceId to get consistent percentage
        const hash = this.simpleHash(deviceId);
        const devicePercentage = (hash % 100) + 1;

        return devicePercentage <= rule.rolloutPercentage;
    }

    /**
     * Simple string hash function
     */
    private static simpleHash(str: string): number {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = (hash << 5) - hash + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return Math.abs(hash);
    }

    /**
     * Evaluate multiple rules and return highest priority match
     */
    static evaluateMultiple(
        rules: VersionRule[],
        context: EvaluationContext,
        maintenanceMode?: MaintenanceMode,
        storeUrl?: string,
    ) {
        // Sort by priority (descending)
        const sortedRules = [...rules].sort((a, b) => b.priority - a.priority);

        // Carried out of the loop so a suppressed decision is still explainable.
        // Every rule sees the same context, so the first reason is the only one.
        let untrustedVersion: string | undefined;

        // Evaluate each rule in priority order
        for (const rule of sortedRules) {
            const result = this.evaluate(rule, context, maintenanceMode, storeUrl);
            untrustedVersion ??= (result as { untrustedVersion?: string }).untrustedVersion;
            if (result.status !== 'NONE') {
                return result;
            }
        }

        // Return latestVersion from the highest priority rule if available, even if NONE
        const topRule = sortedRules.find(r => r.isActive);
        return {
            status: 'NONE',
            latestVersion: topRule?.latestVersion,
            untrustedVersion,
        };
    }
}
