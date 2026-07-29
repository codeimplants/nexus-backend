import { Module } from '@nestjs/common';
import { FirebaseAnalyticsService } from './firebase-analytics.service';
import { PrismaService } from '../../database/prisma.service';

@Module({
    providers: [FirebaseAnalyticsService, PrismaService],
    exports: [FirebaseAnalyticsService],
})
export class FirebaseAnalyticsModule { }
