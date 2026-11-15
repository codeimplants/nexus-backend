import {
    IsIn,
    IsInt,
    IsNotEmpty,
    IsOptional,
    IsString,
    Matches,
    MaxLength,
    Min,
} from 'class-validator';

/**
 * Allowed values, kept here so the API, the seed and the UI agree on one list.
 *
 * These are plain strings in the database rather than Postgres enums (matching
 * Admin.role and FeatureFlag.platform), so adding a severity or category is a
 * code change and not a migration. The trade-off is that validation has to be
 * enforced here — without these guards a typo writes a row the UI then filters
 * into oblivion.
 */
export const HARDENING_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
export const HARDENING_STATUSES = ['OPEN', 'IN_PROGRESS', 'BLOCKED', 'DONE'] as const;
export const HARDENING_CATEGORIES = [
    'INFRA',
    'SECURITY',
    'DATA',
    'CI_CD',
    'OBSERVABILITY',
    'COMPLIANCE',
    'PROCESS',
] as const;

/** Same shape as FeatureFlag keys: lowercase, hyphen or underscore separated. */
const KEY_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

export class CreateHardeningItemDto {
    @IsString()
    @IsNotEmpty()
    @MaxLength(80)
    @Matches(KEY_PATTERN, {
        message:
            'key must be lowercase letters, digits, hyphens or underscores, e.g. "external-uptime-monitoring"',
    })
    key: string;

    @IsString()
    @IsNotEmpty()
    @MaxLength(200)
    title: string;

    @IsIn(HARDENING_SEVERITIES as unknown as string[], {
        message: `severity must be one of: ${HARDENING_SEVERITIES.join(', ')}`,
    })
    severity: string;

    @IsIn(HARDENING_CATEGORIES as unknown as string[], {
        message: `category must be one of: ${HARDENING_CATEGORIES.join(', ')}`,
    })
    category: string;

    @IsOptional()
    @IsIn(HARDENING_STATUSES as unknown as string[], {
        message: `status must be one of: ${HARDENING_STATUSES.join(', ')}`,
    })
    status?: string;

    @IsString()
    @IsNotEmpty()
    @MaxLength(4000)
    gap: string;

    @IsString()
    @IsNotEmpty()
    @MaxLength(4000)
    risk: string;

    /**
     * Generous limit: a brief short enough to fit a tweet is a brief the reader
     * has to reconstruct the context for, which defeats the purpose.
     */
    @IsString()
    @IsNotEmpty()
    @MaxLength(8000)
    aiBrief: string;

    @IsOptional()
    @IsString()
    @MaxLength(300)
    scope?: string;

    @IsOptional()
    @IsString()
    @MaxLength(200)
    owner?: string;

    @IsOptional()
    @IsString()
    @MaxLength(4000)
    evidence?: string;

    @IsOptional()
    @IsInt()
    @Min(0)
    sortOrder?: number;

    @IsOptional()
    @IsString()
    @MaxLength(8000)
    notes?: string;
}

/**
 * Everything is optional, and `key` is absent on purpose.
 *
 * The key is how an item is referred to in a commit message, in chat and in
 * another item's brief. Renaming one silently breaks those references, so an item
 * that needs a different key is deleted and recreated — the same reasoning as
 * UpdateFeatureFlagDto omitting `key`.
 *
 * `completedAt` and `completedBy` are also absent: the service sets them from the
 * status transition and the caller's identity, so they cannot drift from it.
 */
export class UpdateHardeningItemDto {
    @IsOptional()
    @IsString()
    @IsNotEmpty()
    @MaxLength(200)
    title?: string;

    @IsOptional()
    @IsIn(HARDENING_SEVERITIES as unknown as string[], {
        message: `severity must be one of: ${HARDENING_SEVERITIES.join(', ')}`,
    })
    severity?: string;

    @IsOptional()
    @IsIn(HARDENING_STATUSES as unknown as string[], {
        message: `status must be one of: ${HARDENING_STATUSES.join(', ')}`,
    })
    status?: string;

    @IsOptional()
    @IsIn(HARDENING_CATEGORIES as unknown as string[], {
        message: `category must be one of: ${HARDENING_CATEGORIES.join(', ')}`,
    })
    category?: string;

    @IsOptional()
    @IsString()
    @MaxLength(4000)
    gap?: string;

    @IsOptional()
    @IsString()
    @MaxLength(4000)
    risk?: string;

    @IsOptional()
    @IsString()
    @MaxLength(8000)
    aiBrief?: string;

    @IsOptional()
    @IsString()
    @MaxLength(300)
    scope?: string;

    /** Empty string clears the owner — "unclaim" has to be expressible. */
    @IsOptional()
    @IsString()
    @MaxLength(200)
    owner?: string;

    @IsOptional()
    @IsString()
    @MaxLength(4000)
    evidence?: string;

    @IsOptional()
    @IsInt()
    @Min(0)
    sortOrder?: number;

    @IsOptional()
    @IsString()
    @MaxLength(8000)
    notes?: string;
}
