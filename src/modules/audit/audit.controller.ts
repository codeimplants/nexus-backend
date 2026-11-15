import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuditService } from './audit.service';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';

/** Who changed what. Super admin only. */
@Controller('admin/audit')
@UseGuards(JwtGuard, RolesGuard)
@Roles('SUPER_ADMIN')
export class AuditController {
    constructor(private audit: AuditService) { }

    /** GET /admin/audit?adminId=&entity=&sensitive=true&from=&to=&take=&skip= */
    @Get()
    find(
        @Query('adminId') adminId?: string,
        @Query('entity') entity?: string,
        @Query('sensitive') sensitive?: string,
        @Query('from') from?: string,
        @Query('to') to?: string,
        @Query('take') take?: string,
        @Query('skip') skip?: string,
    ) {
        const date = (v?: string) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v) : undefined);
        return this.audit.find({
            adminId,
            entity,
            sensitive: sensitive === 'true',
            from: date(from),
            to: date(to),
            take: take ? Number(take) || undefined : undefined,
            skip: skip ? Number(skip) || undefined : undefined,
        });
    }
}
