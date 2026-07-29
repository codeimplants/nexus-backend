import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { PrismaService } from '../../database/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { AppAccessGuard } from '../../common/guards/app-access.guard';
import { AppAdminModule } from '../app-admin/app-admin.module';
import { FirebaseAnalyticsModule } from '../firebase-analytics/firebase-analytics.module';

@Module({
    imports: [AuthModule, AppAdminModule, FirebaseAnalyticsModule],
    controllers: [AnalyticsController],
    providers: [AnalyticsService, PrismaService, AppAccessGuard],
})
export class AnalyticsModule { }
