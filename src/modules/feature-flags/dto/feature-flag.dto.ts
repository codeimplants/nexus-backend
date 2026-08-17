import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * Platforms a flag row may target. "all" is the default and means every platform.
 *
 * Narrower than the `Platform` enum in the SDK DTO on purpose: that enum still
 * lists windows/macos/linux, but `VersionCheckDto` already restricts incoming
 * checks to android/ios/web, so a flag targeting the others could never match
 * anything and would only look like it worked.
 */
export const FLAG_PLATFORMS = ['all', 'android', 'ios', 'web'] as const;

/**
 * Keys are read by client code, appear in analytics, and are typed by hand in the
 * dashboard — so they are constrained to a shape that cannot be ambiguous. A key
 * differing only by case or a stray space from the one the app looks for is a flag
 * that silently never applies.
 */
const KEY_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

export class CreateFeatureFlagDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(KEY_PATTERN, {
    message:
      'key must be lowercase letters, digits, hyphens or underscores, e.g. "tutorials" or "old_gold"',
  })
  key: string;

  @IsOptional()
  @IsIn(FLAG_PLATFORMS as unknown as string[], {
    message: `platform must be one of: ${FLAG_PLATFORMS.join(', ')}`,
  })
  platform?: string;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;
}

export class UpdateFeatureFlagDto {
  /**
   * `key` is deliberately absent. An app reads a flag by key, so renaming one
   * means the app stops finding it — which presents as the feature quietly
   * reverting to its built-in default rather than as an error. Delete and
   * recreate, so the change is explicit.
   */
  @IsOptional()
  @IsIn(FLAG_PLATFORMS as unknown as string[], {
    message: `platform must be one of: ${FLAG_PLATFORMS.join(', ')}`,
  })
  platform?: string;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;
}
