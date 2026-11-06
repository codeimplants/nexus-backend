import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PushModule } from '../push/push.module';
import { PaymentsReportsModule } from '../payments-reports/payments-reports.module';
import { MessagingReportsModule } from '../messaging-reports/messaging-reports.module';
import { AppAlerts } from './app-alerts';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ServerReportsController } from './server-reports.controller';
import { ServerReportsService } from './server-reports.service';
import { ServerAlertsService } from './server-alerts.service';

@Module({
    imports: [AuthModule, PushModule, PaymentsReportsModule, MessagingReportsModule],
    controllers: [ServerReportsController],
    providers: [ServerReportsService, ServerAlertsService, AppAlerts, RolesGuard],
})
export class ServerReportsModule { }
