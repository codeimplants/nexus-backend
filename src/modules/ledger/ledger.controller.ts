import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { User } from '../../common/decorators/user.decorator';
import { LedgerService } from './ledger.service';
import { LedgerAccessGuard } from './ledger-access.guard';
import { LedgerRemindersService } from './ledger-reminders.service';
import {
    CreateChargeDto,
    CreateClientDto,
    CreateExpenseDto,
    CreatePartnerDto,
    CreatePlanDto,
    CreateReceiptDto,
    CreateSettlementDto,
    CreateShareScheduleDto,
    CreateSubscriptionDto,
    RenewSubscriptionDto,
    UpdateClientDto,
    UpdatePartnerDto,
    UpdatePlanDto,
    UpdateSubscriptionDto,
} from './dto/ledger.dto';

interface RequestUser {
    id: string;
    email: string;
    name?: string | null;
    role: string;
}

type LedgerRequest = { ledgerPartner?: { id: string; name: string } | null };

/** Who made a change, for the row's createdBy: their partner name, else their account. */
const actorOf = (req: LedgerRequest, user: RequestUser) => req.ledgerPartner?.name ?? user?.name ?? user?.email;

/**
 * The partners' books. Every route needs JwtGuard (signed in; writes need a
 * writer role and an authenticator code) and LedgerAccessGuard (super admin or
 * a linked partner). AuditInterceptor records every write, flagged sensitive.
 *
 * Route params are named for what they are (`clientId`, not `id`): elsewhere in
 * this codebase AppAccessGuard reads `req.params.id` as an app id.
 */
@Controller('admin/ledger')
@UseGuards(JwtGuard, LedgerAccessGuard)
export class LedgerController {
    constructor(
        private ledger: LedgerService,
        private reminders: LedgerRemindersService,
    ) { }

    /** Everything the page's top half shows: renewals, who owes whom, clients, totals, the year by month. */
    @Get('overview')
    overview(@Req() req: LedgerRequest, @Query('year') year?: string) {
        const y = year ? Number(year) : undefined;
        if (y !== undefined && (!Number.isInteger(y) || y < 2000 || y > 2100)) throw new BadRequestException('year must be like 2026');
        return this.ledger.overview(req.ledgerPartner?.id ?? null, y);
    }

    @Get('reminders/preview')
    previewReminders() {
        return this.reminders.preview();
    }

    // Partners and shares -----------------------------------------------------

    @Get('admins')
    admins() {
        return this.ledger.linkableAdmins();
    }

    @Post('partners')
    createPartner(@Body() body: CreatePartnerDto) {
        return this.ledger.createPartner(body);
    }

    @Patch('partners/:partnerId')
    updatePartner(@Param('partnerId') partnerId: string, @Body() body: UpdatePartnerDto) {
        return this.ledger.updatePartner(partnerId, body);
    }

    @Get('shares')
    shares() {
        return this.ledger.listShares();
    }

    @Post('shares')
    createShares(@Body() body: CreateShareScheduleDto, @Req() req: LedgerRequest, @User() user: RequestUser) {
        return this.ledger.createShareSchedule(body, actorOf(req, user));
    }

    @Delete('shares/:scheduleId')
    deleteShares(@Param('scheduleId') scheduleId: string) {
        return this.ledger.deleteShareSchedule(scheduleId);
    }

    // Clients -------------------------------------------------------------------

    @Get('clients')
    clients() {
        return this.ledger.listClients();
    }

    @Get('clients/:clientId')
    client(@Param('clientId') clientId: string) {
        return this.ledger.clientDetail(clientId);
    }

    @Post('clients')
    createClient(@Body() body: CreateClientDto) {
        return this.ledger.createClient(body);
    }

    @Patch('clients/:clientId')
    updateClient(@Param('clientId') clientId: string, @Body() body: UpdateClientDto) {
        return this.ledger.updateClient(clientId, body);
    }

    @Post('plans')
    createPlan(@Body() body: CreatePlanDto) {
        return this.ledger.createPlan(body);
    }

    @Patch('plans/:planId')
    updatePlan(@Param('planId') planId: string, @Body() body: UpdatePlanDto) {
        return this.ledger.updatePlan(planId, body);
    }

    @Post('charges')
    createCharge(@Body() body: CreateChargeDto, @Req() req: LedgerRequest, @User() user: RequestUser) {
        return this.ledger.createCharge(body, actorOf(req, user));
    }

    @Delete('charges/:chargeId')
    deleteCharge(@Param('chargeId') chargeId: string) {
        return this.ledger.deleteCharge(chargeId);
    }

    @Get('receipts')
    receipts() {
        return this.ledger.listReceipts();
    }

    @Post('receipts')
    createReceipt(@Body() body: CreateReceiptDto, @Req() req: LedgerRequest, @User() user: RequestUser) {
        return this.ledger.createReceipt(body, actorOf(req, user));
    }

    @Delete('receipts/:receiptId')
    deleteReceipt(@Param('receiptId') receiptId: string) {
        return this.ledger.deleteReceipt(receiptId);
    }

    // Recurring costs ---------------------------------------------------------------

    @Get('subscriptions')
    subscriptions() {
        return this.ledger.listSubscriptions();
    }

    @Post('subscriptions')
    createSubscription(@Body() body: CreateSubscriptionDto) {
        return this.ledger.createSubscription(body);
    }

    @Patch('subscriptions/:subscriptionId')
    updateSubscription(@Param('subscriptionId') subscriptionId: string, @Body() body: UpdateSubscriptionDto) {
        return this.ledger.updateSubscription(subscriptionId, body);
    }

    @Delete('subscriptions/:subscriptionId')
    deleteSubscription(@Param('subscriptionId') subscriptionId: string) {
        return this.ledger.deleteSubscription(subscriptionId);
    }

    @Post('subscriptions/:subscriptionId/renew')
    renew(@Param('subscriptionId') subscriptionId: string, @Body() body: RenewSubscriptionDto, @Req() req: LedgerRequest, @User() user: RequestUser) {
        return this.ledger.renewSubscription(subscriptionId, body, actorOf(req, user));
    }

    // Expenses and transfers ---------------------------------------------------------

    @Get('expenses')
    expenses() {
        return this.ledger.listExpenses();
    }

    @Post('expenses')
    createExpense(@Body() body: CreateExpenseDto, @Req() req: LedgerRequest, @User() user: RequestUser) {
        return this.ledger.createExpense(body, actorOf(req, user));
    }

    @Delete('expenses/:expenseId')
    deleteExpense(@Param('expenseId') expenseId: string) {
        return this.ledger.deleteExpense(expenseId);
    }

    @Get('settlements')
    settlements() {
        return this.ledger.listSettlements();
    }

    @Post('settlements')
    createSettlement(@Body() body: CreateSettlementDto, @Req() req: LedgerRequest, @User() user: RequestUser) {
        return this.ledger.createSettlement(body, actorOf(req, user));
    }

    @Delete('settlements/:settlementId')
    deleteSettlement(@Param('settlementId') settlementId: string) {
        return this.ledger.deleteSettlement(settlementId);
    }
}

/**
 * GET /admin/ledger-access: may this account open the Ledger? Separate from the
 * controller above because that one refuses non-partners outright, and the
 * sidebar needs a yes/no, not a 403.
 */
@Controller('admin/ledger-access')
@UseGuards(JwtGuard)
export class LedgerAccessController {
    constructor(private ledger: LedgerService) { }

    @Get()
    access(@User() user: RequestUser) {
        return this.ledger.access(user.id, user.role);
    }
}
