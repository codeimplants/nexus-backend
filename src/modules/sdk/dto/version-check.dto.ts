import { IsString, IsOptional, IsNotEmpty, IsEnum, IsIn } from 'class-validator';

export enum Platform {
  ANDROID = 'android',
  IOS = 'ios',
  WEB = 'web',
  WINDOWS = 'windows',
  MACOS = 'macos',
  LINUX = 'linux',
}

export enum Environment {
  PROD = 'prod',
  STAGING = 'staging',
  DEV = 'dev',
}

export class VersionCheckDto {
  @IsString()
  @IsOptional()
  appId?: string;

  @IsIn([Platform.ANDROID, Platform.IOS, Platform.WEB], {
    message: 'platform must be android, ios, or web',
  })
  @IsNotEmpty()
  platform: Platform;

  @IsString()
  @IsOptional()
  currentVersion?: string;

  @IsString()
  @IsOptional()
  buildNumber?: string;

  @IsEnum(Environment)
  @IsNotEmpty()
  environment: Environment;

  @IsString()
  @IsOptional()
  deviceId?: string;

  @IsString()
  @IsOptional()
  osVersion?: string;

  @IsOptional()
  metadata?: Record<string, any>;
}

export interface VersionCheckResponse {
  status: 'NONE' | 'SOFT_UPDATE' | 'FORCE_UPDATE' | 'KILL_SWITCH' | 'BLOCKED' | 'MAINTENANCE';
  latestVersion?: string;
  minVersion?: string;
  updateType?: 'soft' | 'force' | 'maintenance' | 'none';
  killSwitch?: boolean;
  blockVersion?: boolean;
  maintenanceMode?: boolean;

  // Message configuration
  title?: string;
  message?: string;
  buttonText?: string;
  customMessage?: any;

  // Store URLs
  storeUrl?: string;
  storeUrls?: {
    android?: string;
    ios?: string;
    web?: string;
  };

  /**
   * Feature switches for this app and platform, as `{ key: boolean }`.
   *
   * A new response field, which the frozen contract explicitly permits — and the
   * reason flags can reach already-published binaries at all: the SDK sets
   * `VCDecision.raw` to this entire response, so a client reads
   * `decision.raw.featureFlags` with no SDK release.
   *
   * Omitted entirely when the app has no flags, rather than sent as `{}`, so the
   * payload every shipped binary parses does not grow for apps not using them.
   *
   * Nexus can only turn a feature OFF: clients treat a flag as authoritative when
   * it is `false` and otherwise fall back to their own configuration. Absent data
   * must never disable anything — see the client-side registry for why.
   */
  featureFlags?: Record<string, boolean>;

  /**
   * Set when a version rule was live but was deliberately not applied, because
   * the currentVersion the client sent could not be trusted — see
   * VersionEngine.trustReportedVersion(). Absent on every normal response.
   *
   * Additive, which the frozen contract permits, and deliberately sent to the
   * client rather than only logged: the SDK puts the whole response on
   * VCDecision.raw, so a build with debug logging on says exactly why it is not
   * being offered an update. Finding that out took a day the first time.
   */
  untrustedVersion?: string;

  // Metadata
  deviceTracked?: boolean;
  analytics?: boolean;
}
