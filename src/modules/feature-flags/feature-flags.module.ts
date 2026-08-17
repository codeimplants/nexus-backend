import { Module } from '@nestjs/common';
import { FeatureFlagsController } from './feature-flags.controller';
import { FeatureFlagsService } from './feature-flags.service';
import { PrismaService } from '../../database/prisma.service';
import { AuthModule } from '../auth/auth.module';

@Module({
    imports: [AuthModule],
    controllers: [FeatureFlagsController],
    // Exported because SdkModule injects it to attach flags to the version-check
    // response — that is the only path by which flags reach an app.
    providers: [FeatureFlagsService, PrismaService],
    exports: [FeatureFlagsService],
})
export class FeatureFlagsModule { }
