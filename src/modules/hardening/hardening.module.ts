import { Module } from '@nestjs/common';
import { HardeningController } from './hardening.controller';
import { HardeningService } from './hardening.service';
import { HardeningSeedService } from './hardening-seed.service';
import { AuthModule } from '../auth/auth.module';

/**
 * Platform Hardening register.
 *
 * AuthModule is imported for JwtGuard's dependencies, matching FeatureFlagsModule.
 *
 * PrismaService is deliberately NOT listed in providers. DatabaseModule is
 * @Global and exports the single instance; listing it here would build a second
 * PrismaClient with its own connection pool, which is how prod once held 31
 * Postgres connections from one process and exhausted a 100-connection server.
 * See database.module.ts.
 */
@Module({
    imports: [AuthModule],
    controllers: [HardeningController],
    providers: [HardeningService, HardeningSeedService],
})
export class HardeningModule { }
