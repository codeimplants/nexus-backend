import { Module } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { RolesGuard } from '../../common/guards/roles.guard';
import { MessagingReportsController } from './messaging-reports.controller';
import { MessagingReportsService } from './messaging-reports.service';

@Module({
    imports: [AuthModule],
    controllers: [MessagingReportsController],
    providers: [MessagingReportsService, PrismaService, RolesGuard],
})
export class MessagingReportsModule { }
