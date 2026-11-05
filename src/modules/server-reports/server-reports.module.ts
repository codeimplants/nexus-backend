import { Module } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ServerReportsController } from './server-reports.controller';
import { ServerReportsService } from './server-reports.service';
import { ServerAlertsService } from './server-alerts.service';

@Module({
    imports: [AuthModule],
    controllers: [ServerReportsController],
    providers: [ServerReportsService, ServerAlertsService, PrismaService, RolesGuard],
})
export class ServerReportsModule { }
