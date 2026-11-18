import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PushModule } from '../push/push.module';
import { LedgerAccessController, LedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';
import { LedgerAccessGuard } from './ledger-access.guard';
import { LedgerRemindersService } from './ledger-reminders.service';

/**
 * The partners' books: clients and what they owe, recurring costs and when they
 * renew, who paid or holds each rupee, and who owes whom.
 *
 * AuthModule for JwtGuard's dependencies; PushModule for reminders. PrismaService
 * comes from the global DatabaseModule and is deliberately not listed here (a
 * second instance means a second connection pool; see database.module.ts).
 */
@Module({
    imports: [AuthModule, PushModule],
    controllers: [LedgerController, LedgerAccessController],
    providers: [LedgerService, LedgerAccessGuard, LedgerRemindersService],
})
export class LedgerModule { }
