import { Module } from '@nestjs/common';
import { KillSwitchController } from './kill-switch.controller';
import { KillSwitchService } from './kill-switch.service';
import { AuthModule } from '../auth/auth.module';

@Module({
    imports: [AuthModule],
    controllers: [KillSwitchController],
    providers: [KillSwitchService],
})
export class KillSwitchModule { }