import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PaymentsReportsController } from './payments-reports.controller';
import { PaymentsReportsService } from './payments-reports.service';

@Module({
    imports: [AuthModule],
    controllers: [PaymentsReportsController],
    providers: [PaymentsReportsService, RolesGuard],
    exports: [PaymentsReportsService],
})
export class PaymentsReportsModule { }
