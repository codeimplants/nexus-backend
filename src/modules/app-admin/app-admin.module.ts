import { Module } from '@nestjs/common';
import { AppAdminController } from './app-admin.controller';
import { AppAdminService } from './app-admin.service';
import { AuthModule } from '../auth/auth.module';

@Module({
    // AuthModule is required, not optional: this module's controller is guarded
    // by JwtGuard, which injects JwtService. Without this import Nest cannot
    // resolve it and the whole application fails to boot.
    imports: [AuthModule],
    controllers: [AppAdminController],
    providers: [AppAdminService],
    // AnalyticsModule uses this to resolve pseudonymous ids to real contacts.
    exports: [AppAdminService],
})
export class AppAdminModule { }
