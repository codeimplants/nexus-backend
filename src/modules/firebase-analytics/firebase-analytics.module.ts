import { Module } from '@nestjs/common';
import { FirebaseAnalyticsService } from './firebase-analytics.service';

@Module({
    providers: [FirebaseAnalyticsService],
    exports: [FirebaseAnalyticsService],
})
export class FirebaseAnalyticsModule { }
