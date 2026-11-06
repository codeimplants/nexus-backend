import { Module } from '@nestjs/common';
import { SdkController } from './sdk.controller';
import { SdkService } from './sdk.service';
import { SessionSweeperService } from './session-sweeper.service';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';

@Module({
    // For FeatureFlagsService, which attaches flags to the version-check response.
    imports: [FeatureFlagsModule],
    controllers: [SdkController],
    providers: [SdkService, SessionSweeperService],
})
export class SdkModule { }
