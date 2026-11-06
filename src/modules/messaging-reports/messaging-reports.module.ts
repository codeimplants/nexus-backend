import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RolesGuard } from '../../common/guards/roles.guard';
import { MessagingReportsController } from './messaging-reports.controller';
import { MessagingReportsService } from './messaging-reports.service';

@Module({
    imports: [AuthModule],
    controllers: [MessagingReportsController],
    providers: [MessagingReportsService, RolesGuard],
    exports: [MessagingReportsService],
})
export class MessagingReportsModule { }
