import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { HARDENING_SEED } from './hardening.seed';

/**
 * Puts the audit's reference rows into the register on boot, without ever
 * overwriting what the team has since changed.
 *
 * `upsert({ where: { key }, update: {}, create: ... })` is the whole design. An
 * item already present is left byte-for-byte alone, so a status moved to
 * IN_PROGRESS, an owner claimed or a note added survives every subsequent deploy.
 * Only genuinely new keys are inserted.
 *
 * This runs on every start of every environment. It is a couple of dozen upserts
 * against a unique index, so the cost is negligible; the alternative (a one-shot
 * data migration) would mean a new migration for every item added, and would not
 * reach a database restored from an older dump.
 *
 * Failure here must never stop the app booting. Nexus is the console used to
 * diagnose outages, so a seeding problem taking it down would be the worst
 * possible trade — hence the try/catch and the single logged error.
 */
@Injectable()
export class HardeningSeedService implements OnModuleInit {
    private readonly logger = new Logger(HardeningSeedService.name);

    constructor(private prisma: PrismaService) { }

    async onModuleInit() {
        try {
            let inserted = 0;
            for (const row of HARDENING_SEED) {
                const result = await this.prisma.hardeningItem.upsert({
                    where: { key: row.key },
                    // Deliberately empty: never clobber a team edit.
                    update: {},
                    create: row,
                });
                // `upsert` does not report which branch ran, so compare timestamps:
                // a row created just now has createdAt within this tick.
                if (Date.now() - result.createdAt.getTime() < 5_000) inserted++;
            }
            if (inserted > 0) {
                this.logger.log(
                    `Hardening register seeded: ${inserted} new item(s), ${HARDENING_SEED.length} total defined`,
                );
            }
        } catch (error) {
            // One loud line, not a crash. See the class comment.
            this.logger.error(
                `Hardening register seeding failed (the register may be empty or stale): ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
}
