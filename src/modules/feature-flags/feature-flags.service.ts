import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { CreateFeatureFlagDto, UpdateFeatureFlagDto } from './dto/feature-flag.dto';

/** A row with this platform applies to every platform. */
export const ALL_PLATFORMS = 'all';

type FlagRow = {
  key: string;
  platform: string;
  isEnabled: boolean;
};

/**
 * Resolve rows into the flat `{ key: boolean }` map the SDK response carries.
 *
 * A platform-specific row beats an "all" row for the same key, so a flag can be
 * off on iOS while on elsewhere — which is needed in practice, because App Store
 * review and a staged Play rollout never land together.
 *
 * Exported and pure so it can be checked without a database.
 */
export const resolveFlagsForPlatform = (
  rows: FlagRow[],
  platform?: string,
): Record<string, boolean> => {
  const out: Record<string, boolean> = {};
  // Two passes rather than a sort: "all" first, then let specific rows overwrite.
  for (const row of rows) {
    if (row.platform === ALL_PLATFORMS) out[row.key] = row.isEnabled;
  }
  if (platform) {
    for (const row of rows) {
      if (row.platform === platform) out[row.key] = row.isEnabled;
    }
  }
  return out;
};

@Injectable()
export class FeatureFlagsService {
  constructor(private prisma: PrismaService) {}

  /** Every row for an app, for the dashboard. */
  list(appId: string) {
    return this.prisma.featureFlag.findMany({
      where: { appId },
      orderBy: [{ key: 'asc' }, { platform: 'asc' }],
    });
  }

  async create(appId: string, dto: CreateFeatureFlagDto) {
    try {
      return await this.prisma.featureFlag.create({
        data: {
          appId,
          key: dto.key.trim(),
          platform: dto.platform ?? ALL_PLATFORMS,
          isEnabled: dto.isEnabled ?? true,
          description: dto.description,
        },
      });
    } catch (error: any) {
      // P2002 = unique violation on (appId, key, platform).
      if (error?.code === 'P2002') {
        throw new ConflictException(
          `A flag "${dto.key}" already exists for platform "${dto.platform ?? ALL_PLATFORMS}" on this app`,
        );
      }
      throw error;
    }
  }

  /**
   * Both writes are scoped by appId as well as flag id, so a flag belonging to
   * another app cannot be reached through a URL for an app you do have access to.
   * AppAccessGuard authorises the app in the path; it cannot know whether the flag
   * in the path belongs to it, so that check has to live here.
   */
  async update(appId: string, flagId: string, dto: UpdateFeatureFlagDto) {
    const existing = await this.prisma.featureFlag.findFirst({
      where: { id: flagId, appId },
    });
    if (!existing) throw new NotFoundException('Feature flag not found');
    try {
      return await this.prisma.featureFlag.update({ where: { id: flagId }, data: dto });
    } catch (error: any) {
      if (error?.code === 'P2002') {
        throw new ConflictException(
          'Another flag already uses that key and platform on this app',
        );
      }
      throw error;
    }
  }

  async remove(appId: string, flagId: string) {
    const existing = await this.prisma.featureFlag.findFirst({
      where: { id: flagId, appId },
    });
    if (!existing) throw new NotFoundException('Feature flag not found');
    await this.prisma.featureFlag.delete({ where: { id: flagId } });
    return { deleted: true };
  }

  /**
   * What the SDK response should carry for one app and platform.
   *
   * Returns `undefined` rather than `{}` when the app has no flags, so the field
   * is omitted from the response entirely instead of adding an empty object to a
   * payload every published binary parses.
   */
  async forSdk(
    appId: string,
    platform?: string,
  ): Promise<Record<string, boolean> | undefined> {
    const rows = await this.prisma.featureFlag.findMany({
      where: {
        appId,
        // Only rows that could apply, so a many-platform app does not ship every
        // other platform's flags to every device.
        platform: platform ? { in: [ALL_PLATFORMS, platform] } : ALL_PLATFORMS,
      },
      select: { key: true, platform: true, isEnabled: true },
    });
    if (rows.length === 0) return undefined;
    return resolveFlagsForPlatform(rows, platform);
  }
}
