import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
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
import {
    addMonths,
    clientStatus,
    type ClientStatus,
    type Day,
    dayOf,
    daysBetween,
    dueDatesUpTo,
    monthlyEquivalent,
    nextPlanDue,
    partnerBalances,
    type PartnerBalance,
    renewalBucket,
    type RenewalBucket,
    settleUp,
    toDbDate,
    todayIst,
    type Weights,
} from './ledger-math';

const day = (d: Date | null | undefined): Day | null => (d ? dayOf(d) : null);
/** Trim a free-text field; empty means "clear it". */
const text = (v: string | null | undefined): string | null | undefined => (v === undefined ? undefined : v?.trim() || null);
/** Twelve months' worth of a repeating amount. */
const yearly = (amountPaise: number, cycleMonths: number) => (cycleMonths > 0 ? Math.round((amountPaise * 12) / cycleMonths) : 0);

export interface RenewalRow {
    id: string;
    name: string;
    category: string;
    vendor: string | null;
    amountPaise: number | null;
    isEstimate: boolean;
    cycleMonths: number;
    nextRenewal: Day | null;
    daysLeft: number | null;
    bucket: RenewalBucket;
    autoRenew: boolean;
    paymentMethod: string | null;
    defaultPayer: { id: string; name: string } | null;
    client: { id: string; name: string } | null;
    rebillPaise: number | null;
    notes: string | null;
}

export interface UpcomingDue {
    clientId: string;
    clientName: string;
    description: string;
    amountPaise: number;
    dueDate: Day;
}

export interface ClientRow {
    id: string;
    name: string;
    isActive: boolean;
    status: ClientStatus;
    activePlans: number;
    /** What their active repeating plans come to per year. */
    yearlyPaise: number;
    nextDue: UpcomingDue | null;
}

export interface MonthRow {
    month: string;
    billedPaise: number;
    receivedPaise: number;
    spentPaise: number;
    billedClients: number;
    paidClients: number;
}

export type BalanceRow = PartnerBalance & { name: string; isActive: boolean };

export interface LedgerOverview {
    today: Day;
    year: number;
    mePartnerId: string | null;
    partners: Array<{ id: string; name: string; isActive: boolean; adminId: string | null; adminName: string | null }>;
    renewals: RenewalRow[];
    balances: BalanceRow[];
    settleUp: Array<{ fromId: string; fromName: string; toId: string; toName: string; amountPaise: number }>;
    clients: ClientRow[];
    upcomingDues: UpcomingDue[];
    totals: {
        outstandingPaise: number;
        dueNext30Paise: number;
        payingClients: number;
        mrrPaise: number;
        arrPaise: number;
        recurringCostsYearlyPaise: number;
        /** Recurring costs whose amount is not known yet, so the yearly figure is short by them. */
        recurringCostsUnpriced: number;
        receivedToDatePaise: number;
        spentToDatePaise: number;
        profitToDatePaise: number;
    };
    months: MonthRow[];
    yearTotals: Omit<MonthRow, 'month'>;
    spendByCategory: Array<{ category: string; paise: number }>;
    /** Gaps that make the numbers above less trustworthy, said out loud. */
    warnings: string[];
}

@Injectable()
export class LedgerService {
    private readonly logger = new Logger(LedgerService.name);

    constructor(private prisma: PrismaService) { }

    // -----------------------------------------------------------------------
    // Who may see the books
    // -----------------------------------------------------------------------

    /**
     * The books are the partners' own: the super admin and any account linked
     * to an active partner. Other admins do not see them by default, because
     * an ADMIN role is about running the apps, not about sharing the money.
     */
    async access(adminId: string, role: string) {
        const partner = await this.prisma.ledgerPartner.findUnique({ where: { adminId }, select: { id: true, name: true, isActive: true } });
        const allowed = role === 'SUPER_ADMIN' || !!partner?.isActive;
        return { allowed, partner: partner?.isActive ? { id: partner.id, name: partner.name } : null };
    }

    // -----------------------------------------------------------------------
    // Billing: plans become charges as their due dates arrive
    // -----------------------------------------------------------------------

    /**
     * Produces every charge whose due date has arrived, for every active plan.
     *
     * Safe to run any number of times and from several places at once: the
     * plan's periodsBilled is advanced with a compare-and-set, so only one run
     * bills a given period, and (planId, dueDate) is unique besides.
     * Runs before every overview and once an hour, so nobody has to press a
     * "generate invoices" button and a missed day is caught up next time.
     */
    async billDuePlans(today: Day = todayIst()): Promise<number> {
        const plans = await this.prisma.ledgerPlan.findMany({
            where: { isActive: true, nextDueDate: { lte: toDbDate(today) } },
        });
        let created = 0;
        for (const plan of plans) {
            const schedule = {
                startDate: dayOf(plan.startDate),
                cycleMonths: plan.cycleMonths,
                periodsBilled: plan.periodsBilled,
                endDate: day(plan.endDate),
            };
            const dates = dueDatesUpTo(schedule, today);
            const next = nextPlanDue({ ...schedule, periodsBilled: plan.periodsBilled + dates.length });
            await this.prisma.$transaction(async (tx) => {
                const { count } = await tx.ledgerPlan.updateMany({
                    where: { id: plan.id, periodsBilled: plan.periodsBilled },
                    data: { periodsBilled: plan.periodsBilled + dates.length, nextDueDate: next ? toDbDate(next) : null },
                });
                if (count !== 1 || dates.length === 0) return; // another run got here first
                const result = await tx.ledgerCharge.createMany({
                    data: dates.map((d) => ({
                        clientId: plan.clientId,
                        planId: plan.id,
                        description: plan.product,
                        amountPaise: plan.amountPaise,
                        dueDate: toDbDate(d),
                        createdBy: 'billing',
                    })),
                    skipDuplicates: true,
                });
                created += result.count;
            });
        }
        if (created > 0) this.logger.log(`Ledger billing: ${created} charge(s) produced`);
        return created;
    }

    // -----------------------------------------------------------------------
    // The overview: everything the page's top half shows, from one read
    // -----------------------------------------------------------------------

    async overview(mePartnerId: string | null, year?: number, today: Day = todayIst()): Promise<LedgerOverview> {
        await this.billDuePlans(today);
        const yr = year ?? Number(today.slice(0, 4));

        const [partners, schedules, clients, charges, receipts, expenses, settlements, subscriptions] = await Promise.all([
            this.prisma.ledgerPartner.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], include: { admin: { select: { name: true, email: true } } } }),
            this.prisma.ledgerShareSchedule.findMany({ orderBy: { effectiveFrom: 'asc' } }),
            this.prisma.ledgerClient.findMany({ orderBy: { name: 'asc' }, include: { plans: true } }),
            this.prisma.ledgerCharge.findMany(),
            this.prisma.ledgerReceipt.findMany(),
            this.prisma.ledgerExpense.findMany(),
            this.prisma.ledgerSettlement.findMany(),
            this.prisma.ledgerSubscription.findMany({ where: { isActive: true }, include: { defaultPayer: { select: { id: true, name: true } }, client: { select: { id: true, name: true } } } }),
        ]);

        const nameOf = new Map(partners.map((p) => [p.id, p.name]));
        const clientName = new Map(clients.map((c) => [c.id, c.name]));
        const activeIds = partners.filter((p) => p.isActive).map((p) => p.id);
        const shareSchedules = schedules.map((s) => ({ effectiveFrom: dayOf(s.effectiveFrom), weights: s.weights as Weights }));
        const warnings: string[] = [];

        // Who owes whom.
        const raw = partnerBalances(
            activeIds,
            shareSchedules,
            expenses.map((e) => ({ amountPaise: e.amountPaise, paidById: e.paidById, day: dayOf(e.paidOn), weights: e.weights as Weights | null })),
            receipts.map((r) => ({ amountPaise: r.amountPaise, receivedById: r.receivedById, day: dayOf(r.receivedOn), weights: r.weights as Weights | null })),
            settlements.map((s) => ({ fromId: s.fromId, toId: s.toId, amountPaise: s.amountPaise })),
        );
        const balances: BalanceRow[] = raw.map((b) => ({ ...b, name: nameOf.get(b.partnerId) ?? 'Unknown', isActive: activeIds.includes(b.partnerId) }));
        const transfers = settleUp(raw).map((t) => ({ ...t, fromName: nameOf.get(t.fromId) ?? '?', toName: nameOf.get(t.toId) ?? '?' }));

        // Renewals, soonest first; the ones with no date at the end, but listed.
        const renewals: RenewalRow[] = subscriptions
            .map((s) => {
                const next = day(s.nextRenewal);
                return {
                    id: s.id,
                    name: s.name,
                    category: s.category,
                    vendor: s.vendor,
                    amountPaise: s.amountPaise,
                    isEstimate: s.isEstimate,
                    cycleMonths: s.cycleMonths,
                    nextRenewal: next,
                    daysLeft: next ? daysBetween(today, next) : null,
                    bucket: renewalBucket(next, today),
                    autoRenew: s.autoRenew,
                    paymentMethod: s.paymentMethod,
                    defaultPayer: s.defaultPayer,
                    client: s.client,
                    rebillPaise: s.rebillPaise,
                    notes: s.notes,
                };
            })
            .sort((a, b) => (a.nextRenewal ?? '9999').localeCompare(b.nextRenewal ?? '9999') || a.name.localeCompare(b.name));

        // Upcoming client dues: what active plans will bill in the next 30 days,
        // plus anything added by hand with a future date.
        const horizon = addMonths(today, 1);
        const upcomingDues: UpcomingDue[] = [];
        for (const c of clients) {
            for (const p of c.plans) {
                if (!p.isActive || !p.nextDueDate) continue;
                const sched = { startDate: dayOf(p.startDate), cycleMonths: p.cycleMonths, periodsBilled: p.periodsBilled, endDate: day(p.endDate) };
                for (let k = 0; k < 40; k++) {
                    const due = nextPlanDue({ ...sched, periodsBilled: sched.periodsBilled + k });
                    if (!due || due > horizon) break;
                    upcomingDues.push({ clientId: c.id, clientName: c.name, description: p.product, amountPaise: p.amountPaise, dueDate: due });
                }
            }
        }
        for (const ch of charges) {
            const d = dayOf(ch.dueDate);
            if (d > today && d <= horizon) upcomingDues.push({ clientId: ch.clientId, clientName: clientName.get(ch.clientId) ?? '?', description: ch.description, amountPaise: ch.amountPaise, dueDate: d });
        }
        upcomingDues.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.clientName.localeCompare(b.clientName));

        // Clients.
        const chargesBy = new Map<string, typeof charges>();
        for (const ch of charges) chargesBy.set(ch.clientId, [...(chargesBy.get(ch.clientId) ?? []), ch]);
        const paidBy = new Map<string, number>();
        for (const r of receipts) paidBy.set(r.clientId, (paidBy.get(r.clientId) ?? 0) + r.amountPaise);

        const isRunning = (p: (typeof clients)[number]['plans'][number]) =>
            p.isActive && p.cycleMonths > 0 && (!p.endDate || dayOf(p.endDate) >= today);
        const clientRows: ClientRow[] = clients.map((c) => {
            const running = c.plans.filter(isRunning);
            return {
                id: c.id,
                name: c.name,
                isActive: c.isActive,
                status: clientStatus((chargesBy.get(c.id) ?? []).map((ch) => ({ amountPaise: ch.amountPaise, dueDate: dayOf(ch.dueDate) })), paidBy.get(c.id) ?? 0, today),
                activePlans: running.length,
                yearlyPaise: running.reduce((s, p) => s + yearly(p.amountPaise, p.cycleMonths), 0),
                nextDue: upcomingDues.find((u) => u.clientId === c.id) ?? null,
            };
        });

        const runningPlans = clients.flatMap((c) => c.plans.filter(isRunning));
        const pricedSubs = subscriptions.filter((s) => s.amountPaise);
        const receivedToDate = receipts.reduce((s, r) => s + r.amountPaise, 0);
        const spentToDate = expenses.reduce((s, e) => s + e.amountPaise, 0);

        // Month by month for the year asked.
        const months: MonthRow[] = [];
        const yearBilled = new Set<string>();
        const yearPaid = new Set<string>();
        for (let m = 1; m <= 12; m++) {
            const key = `${yr}-${String(m).padStart(2, '0')}`;
            const inMonth = (d: Date) => dayOf(d).startsWith(key);
            const mc = charges.filter((c) => inMonth(c.dueDate));
            const mr = receipts.filter((r) => inMonth(r.receivedOn));
            const me = expenses.filter((e) => inMonth(e.paidOn));
            mc.forEach((c) => yearBilled.add(c.clientId));
            mr.forEach((r) => yearPaid.add(r.clientId));
            months.push({
                month: key,
                billedPaise: mc.reduce((s, c) => s + c.amountPaise, 0),
                receivedPaise: mr.reduce((s, r) => s + r.amountPaise, 0),
                spentPaise: me.reduce((s, e) => s + e.amountPaise, 0),
                billedClients: new Set(mc.map((c) => c.clientId)).size,
                paidClients: new Set(mr.map((r) => r.clientId)).size,
            });
        }
        const spend = new Map<string, number>();
        for (const e of expenses) if (dayOf(e.paidOn).startsWith(String(yr))) spend.set(e.category, (spend.get(e.category) ?? 0) + e.amountPaise);

        // Say what is missing rather than letting a number look complete.
        const undated = subscriptions.filter((s) => !s.nextRenewal).length;
        if (undated) warnings.push(`${undated} recurring cost${undated > 1 ? 's have' : ' has'} no renewal date, so no reminder can go out for ${undated > 1 ? 'them' : 'it'}.`);
        const estimates = subscriptions.filter((s) => s.isEstimate).length;
        if (estimates) warnings.push(`${estimates} recurring cost${estimates > 1 ? 's are' : ' is'} marked tentative. Confirm the amount and date.`);
        if (!schedules.length) warnings.push('No share split is set, so everything is split equally between active partners.');
        const unlinked = partners.filter((p) => p.isActive && !p.adminId).map((p) => p.name);
        if (unlinked.length) warnings.push(`${unlinked.join(', ')} ${unlinked.length > 1 ? 'have' : 'has'} no Nexus account linked, so reminders cannot reach them and they cannot open this page.`);

        return {
            today,
            year: yr,
            mePartnerId,
            partners: partners.map((p) => ({ id: p.id, name: p.name, isActive: p.isActive, adminId: p.adminId, adminName: p.admin?.name ?? p.admin?.email ?? null })),
            renewals,
            balances,
            settleUp: transfers,
            clients: clientRows,
            upcomingDues,
            totals: {
                outstandingPaise: clientRows.reduce((s, c) => s + c.status.outstanding, 0),
                dueNext30Paise: upcomingDues.reduce((s, u) => s + u.amountPaise, 0),
                payingClients: clientRows.filter((c) => c.activePlans > 0).length,
                mrrPaise: runningPlans.reduce((s, p) => s + monthlyEquivalent(p.amountPaise, p.cycleMonths), 0),
                arrPaise: runningPlans.reduce((s, p) => s + yearly(p.amountPaise, p.cycleMonths), 0),
                recurringCostsYearlyPaise: pricedSubs.reduce((s, x) => s + yearly(x.amountPaise!, x.cycleMonths), 0),
                recurringCostsUnpriced: subscriptions.length - pricedSubs.length,
                receivedToDatePaise: receivedToDate,
                spentToDatePaise: spentToDate,
                profitToDatePaise: receivedToDate - spentToDate,
            },
            months,
            yearTotals: {
                billedPaise: months.reduce((s, m) => s + m.billedPaise, 0),
                receivedPaise: months.reduce((s, m) => s + m.receivedPaise, 0),
                spentPaise: months.reduce((s, m) => s + m.spentPaise, 0),
                billedClients: yearBilled.size,
                paidClients: yearPaid.size,
            },
            spendByCategory: [...spend.entries()].map(([category, paise]) => ({ category, paise })).sort((a, b) => b.paise - a.paise),
            warnings,
        };
    }

    // -----------------------------------------------------------------------
    // Lists
    // -----------------------------------------------------------------------

    async clientDetail(clientId: string, today: Day = todayIst()) {
        await this.billDuePlans(today);
        const client = await this.prisma.ledgerClient.findUnique({
            where: { id: clientId },
            include: {
                plans: { orderBy: { startDate: 'asc' } },
                charges: { orderBy: [{ dueDate: 'desc' }, { createdAt: 'desc' }] },
                receipts: { orderBy: [{ receivedOn: 'desc' }, { createdAt: 'desc' }], include: { receivedBy: { select: { id: true, name: true } } } },
                subscriptions: { where: { isActive: true }, select: { id: true, name: true, nextRenewal: true, rebillPaise: true, amountPaise: true } },
                expenses: { orderBy: { paidOn: 'desc' }, include: { paidBy: { select: { id: true, name: true } } } },
            },
        });
        if (!client) throw new NotFoundException('Client not found');
        const paid = client.receipts.reduce((s, r) => s + r.amountPaise, 0);
        return {
            ...client,
            status: clientStatus(client.charges.map((c) => ({ amountPaise: c.amountPaise, dueDate: dayOf(c.dueDate) })), paid, today),
        };
    }

    listReceipts() {
        return this.prisma.ledgerReceipt.findMany({
            orderBy: [{ receivedOn: 'desc' }, { createdAt: 'desc' }],
            include: { client: { select: { id: true, name: true } }, receivedBy: { select: { id: true, name: true } } },
        });
    }

    listExpenses() {
        return this.prisma.ledgerExpense.findMany({
            orderBy: [{ paidOn: 'desc' }, { createdAt: 'desc' }],
            include: {
                paidBy: { select: { id: true, name: true } },
                client: { select: { id: true, name: true } },
                subscription: { select: { id: true, name: true } },
                rebill: { select: { id: true, amountPaise: true, dueDate: true } },
            },
        });
    }

    listSettlements() {
        return this.prisma.ledgerSettlement.findMany({
            orderBy: [{ paidOn: 'desc' }, { createdAt: 'desc' }],
            include: { from: { select: { id: true, name: true } }, to: { select: { id: true, name: true } } },
        });
    }

    listSubscriptions() {
        return this.prisma.ledgerSubscription.findMany({
            orderBy: [{ isActive: 'desc' }, { nextRenewal: { sort: 'asc', nulls: 'last' } }, { name: 'asc' }],
            include: { defaultPayer: { select: { id: true, name: true } }, client: { select: { id: true, name: true } } },
        });
    }

    listShares() {
        return this.prisma.ledgerShareSchedule.findMany({ orderBy: { effectiveFrom: 'desc' } });
    }

    listClients() {
        return this.prisma.ledgerClient.findMany({ orderBy: [{ isActive: 'desc' }, { name: 'asc' }], select: { id: true, name: true, isActive: true } });
    }

    /** Nexus accounts a partner can be linked to. Names and roles only. */
    linkableAdmins() {
        return this.prisma.admin.findMany({
            where: { isActive: true },
            select: { id: true, name: true, email: true, role: true, ledgerPartner: { select: { id: true, name: true } } },
            orderBy: { name: 'asc' },
        });
    }

    // -----------------------------------------------------------------------
    // Partners and shares
    // -----------------------------------------------------------------------

    async createPartner(dto: CreatePartnerDto) {
        const adminId = text(dto.adminId) ?? null;
        if (adminId) await this.assertAdminLinkable(adminId);
        try {
            return await this.prisma.ledgerPartner.create({ data: { name: dto.name.trim(), adminId, sortOrder: dto.sortOrder ?? 100 } });
        } catch (e) {
            throw this.conflict(e, 'A partner with that name already exists');
        }
    }

    async updatePartner(partnerId: string, dto: UpdatePartnerDto) {
        await this.partner(partnerId, false);
        const data: Prisma.LedgerPartnerUncheckedUpdateInput = {};
        if (dto.name !== undefined && dto.name !== null) data.name = dto.name.trim();
        if (dto.adminId !== undefined) {
            const adminId = text(dto.adminId) ?? null;
            if (adminId) await this.assertAdminLinkable(adminId, partnerId);
            data.adminId = adminId;
        }
        if (typeof dto.isActive === 'boolean') data.isActive = dto.isActive;
        if (typeof dto.sortOrder === 'number') data.sortOrder = dto.sortOrder;
        try {
            return await this.prisma.ledgerPartner.update({ where: { id: partnerId }, data });
        } catch (e) {
            throw this.conflict(e, 'A partner with that name already exists');
        }
    }

    async createShareSchedule(dto: CreateShareScheduleDto, actor?: string) {
        const weights = await this.checkWeights(dto.weights);
        try {
            return await this.prisma.ledgerShareSchedule.create({
                data: { effectiveFrom: toDbDate(dto.effectiveFrom), weights, note: text(dto.note) ?? null, createdBy: actor ?? null },
            });
        } catch (e) {
            throw this.conflict(e, 'A split already starts on that date. Delete it first to replace it.');
        }
    }

    async deleteShareSchedule(scheduleId: string) {
        const { count } = await this.prisma.ledgerShareSchedule.deleteMany({ where: { id: scheduleId } });
        if (!count) throw new NotFoundException('Split not found');
        return { deleted: true };
    }

    // -----------------------------------------------------------------------
    // Clients, plans, charges, receipts
    // -----------------------------------------------------------------------

    async createClient(dto: CreateClientDto) {
        try {
            return await this.prisma.ledgerClient.create({
                data: { name: dto.name.trim(), contactName: text(dto.contactName), phone: text(dto.phone), email: text(dto.email), notes: text(dto.notes) },
            });
        } catch (e) {
            throw this.conflict(e, 'A client with that name already exists');
        }
    }

    async updateClient(clientId: string, dto: UpdateClientDto) {
        await this.client(clientId);
        const data: Prisma.LedgerClientUpdateInput = {
            contactName: text(dto.contactName),
            phone: text(dto.phone),
            email: text(dto.email),
            notes: text(dto.notes),
        };
        if (dto.name) data.name = dto.name.trim();
        if (typeof dto.isActive === 'boolean') data.isActive = dto.isActive;
        try {
            return await this.prisma.ledgerClient.update({ where: { id: clientId }, data });
        } catch (e) {
            throw this.conflict(e, 'A client with that name already exists');
        }
    }

    async createPlan(dto: CreatePlanDto) {
        await this.client(dto.clientId);
        if (dto.endDate && dto.endDate < dto.startDate) throw new BadRequestException('The end date is before the start date');
        const plan = await this.prisma.ledgerPlan.create({
            data: {
                clientId: dto.clientId,
                product: dto.product.trim(),
                amountPaise: dto.amountPaise,
                cycleMonths: dto.cycleMonths,
                startDate: toDbDate(dto.startDate),
                endDate: dto.endDate ? toDbDate(dto.endDate) : null,
                nextDueDate: toDbDate(dto.startDate),
                notes: text(dto.notes) ?? null,
            },
        });
        // A start date in the past bills its history straight away.
        await this.billDuePlans();
        return this.prisma.ledgerPlan.findUnique({ where: { id: plan.id } });
    }

    async updatePlan(planId: string, dto: UpdatePlanDto) {
        const plan = await this.prisma.ledgerPlan.findUnique({ where: { id: planId } });
        if (!plan) throw new NotFoundException('Plan not found');
        const data: Prisma.LedgerPlanUpdateInput = { notes: text(dto.notes) };
        if (dto.product) data.product = dto.product.trim();
        if (dto.amountPaise) data.amountPaise = dto.amountPaise;
        if (typeof dto.isActive === 'boolean') data.isActive = dto.isActive;
        if (dto.endDate !== undefined) {
            const end = dto.endDate ?? null;
            if (end && end < dayOf(plan.startDate)) throw new BadRequestException('The end date is before the start date');
            data.endDate = end ? toDbDate(end) : null;
            const next = nextPlanDue({ startDate: dayOf(plan.startDate), cycleMonths: plan.cycleMonths, periodsBilled: plan.periodsBilled, endDate: end });
            data.nextDueDate = next ? toDbDate(next) : null;
        }
        return this.prisma.ledgerPlan.update({ where: { id: planId }, data });
    }

    async createCharge(dto: CreateChargeDto, actor?: string) {
        await this.client(dto.clientId);
        return this.prisma.ledgerCharge.create({
            data: {
                clientId: dto.clientId,
                description: dto.description.trim(),
                amountPaise: dto.amountPaise,
                dueDate: toDbDate(dto.dueDate),
                note: text(dto.note) ?? null,
                createdBy: actor ?? null,
            },
        });
    }

    /** Waives or corrects a charge. A plan does not bill that period again. */
    async deleteCharge(chargeId: string) {
        const { count } = await this.prisma.ledgerCharge.deleteMany({ where: { id: chargeId } });
        if (!count) throw new NotFoundException('Charge not found');
        return { deleted: true };
    }

    async createReceipt(dto: CreateReceiptDto, actor?: string) {
        await this.client(dto.clientId);
        await this.partner(dto.receivedById);
        const weights = dto.weights ? await this.checkWeights(dto.weights) : undefined;
        return this.prisma.ledgerReceipt.create({
            data: {
                clientId: dto.clientId,
                amountPaise: dto.amountPaise,
                receivedOn: toDbDate(dto.receivedOn),
                mode: dto.mode,
                receivedById: dto.receivedById,
                reference: text(dto.reference) ?? null,
                note: text(dto.note) ?? null,
                weights,
                createdBy: actor ?? null,
            },
        });
    }

    async deleteReceipt(receiptId: string) {
        const { count } = await this.prisma.ledgerReceipt.deleteMany({ where: { id: receiptId } });
        if (!count) throw new NotFoundException('Payment not found');
        return { deleted: true };
    }

    // -----------------------------------------------------------------------
    // Recurring costs
    // -----------------------------------------------------------------------

    async createSubscription(dto: CreateSubscriptionDto) {
        if (dto.defaultPayerId) await this.partner(dto.defaultPayerId);
        if (dto.clientId) await this.client(dto.clientId);
        return this.prisma.ledgerSubscription.create({
            data: {
                name: dto.name.trim(),
                category: dto.category,
                vendor: text(dto.vendor) ?? null,
                amountPaise: dto.amountPaise ?? null,
                isEstimate: dto.isEstimate ?? false,
                cycleMonths: dto.cycleMonths,
                nextRenewal: dto.nextRenewal ? toDbDate(dto.nextRenewal) : null,
                autoRenew: dto.autoRenew ?? false,
                paymentMethod: text(dto.paymentMethod) ?? null,
                defaultPayerId: dto.defaultPayerId || null,
                clientId: dto.clientId || null,
                rebillPaise: dto.rebillPaise ?? null,
                notes: text(dto.notes) ?? null,
            },
        });
    }

    async updateSubscription(subscriptionId: string, dto: UpdateSubscriptionDto) {
        await this.subscription(subscriptionId);
        if (dto.defaultPayerId) await this.partner(dto.defaultPayerId);
        if (dto.clientId) await this.client(dto.clientId);
        const data: Prisma.LedgerSubscriptionUncheckedUpdateInput = {
            vendor: text(dto.vendor),
            paymentMethod: text(dto.paymentMethod),
            notes: text(dto.notes),
        };
        if (dto.name) data.name = dto.name.trim();
        if (dto.category) data.category = dto.category;
        if (dto.amountPaise !== undefined) data.amountPaise = dto.amountPaise;
        if (typeof dto.isEstimate === 'boolean') data.isEstimate = dto.isEstimate;
        if (dto.cycleMonths) data.cycleMonths = dto.cycleMonths;
        if (dto.nextRenewal !== undefined) data.nextRenewal = dto.nextRenewal ? toDbDate(dto.nextRenewal) : null;
        if (typeof dto.autoRenew === 'boolean') data.autoRenew = dto.autoRenew;
        if (dto.defaultPayerId !== undefined) data.defaultPayerId = dto.defaultPayerId || null;
        if (dto.clientId !== undefined) data.clientId = dto.clientId || null;
        if (dto.rebillPaise !== undefined) data.rebillPaise = dto.rebillPaise;
        if (typeof dto.isActive === 'boolean') data.isActive = dto.isActive;
        return this.prisma.ledgerSubscription.update({ where: { id: subscriptionId }, data });
    }

    /** Removes a recurring cost nobody has paid yet. One with history is stopped instead (isActive false). */
    async deleteSubscription(subscriptionId: string) {
        await this.subscription(subscriptionId);
        const used = await this.prisma.ledgerExpense.count({ where: { subscriptionId } });
        if (used) throw new ConflictException('This has payments recorded against it. Stop it instead, so its history stays.');
        await this.prisma.ledgerSubscription.delete({ where: { id: subscriptionId } });
        return { deleted: true };
    }

    /**
     * "Mark renewed": the expense, the new renewal date and (if we bill it on)
     * the client's charge, in one transaction so none can exist without the others.
     *
     * The next date counts on from the renewal date it replaces, not from the
     * day it was paid, so paying three days late does not shift every future
     * renewal three days. With no date on record it counts from the payment.
     */
    async renewSubscription(subscriptionId: string, dto: RenewSubscriptionDto, actor?: string) {
        const sub = await this.subscription(subscriptionId);
        if (!sub.isActive) throw new BadRequestException('This recurring cost is stopped. Start it again before renewing.');
        await this.partner(dto.paidById);
        const amount = dto.amountPaise ?? sub.amountPaise;
        if (!amount) throw new BadRequestException('Enter the amount paid: none is on record for this one yet.');

        const base = sub.nextRenewal ? dayOf(sub.nextRenewal) : dto.paidOn;
        const next = dto.nextRenewal ?? addMonths(base, sub.cycleMonths);
        const billClient = !!sub.clientId && dto.billClient !== false;

        return this.prisma.$transaction(async (tx) => {
            const expense = await tx.ledgerExpense.create({
                data: {
                    description: `${sub.name} renewal`,
                    category: sub.category,
                    vendor: sub.vendor,
                    amountPaise: amount,
                    paidOn: toDbDate(dto.paidOn),
                    paidById: dto.paidById,
                    mode: dto.mode,
                    subscriptionId: sub.id,
                    clientId: sub.clientId,
                    note: text(dto.note) ?? null,
                    createdBy: actor ?? null,
                },
            });
            const updated = await tx.ledgerSubscription.update({
                where: { id: sub.id },
                data: {
                    nextRenewal: toDbDate(next),
                    // A real payment settles what was a guess.
                    amountPaise: sub.amountPaise ?? amount,
                    isEstimate: false,
                },
            });
            let charge: { id: string } | null = null;
            if (billClient) {
                charge = await tx.ledgerCharge.create({
                    data: {
                        clientId: sub.clientId!,
                        subscriptionId: sub.id,
                        expenseId: expense.id,
                        description: `${sub.name} (renewed ${dto.paidOn})`,
                        amountPaise: dto.rebillPaise ?? sub.rebillPaise ?? amount,
                        dueDate: toDbDate(dto.paidOn),
                        createdBy: actor ?? null,
                    },
                });
            }
            return { expense, subscription: updated, charge };
        });
    }

    // -----------------------------------------------------------------------
    // Expenses and settlements
    // -----------------------------------------------------------------------

    async createExpense(dto: CreateExpenseDto, actor?: string) {
        await this.partner(dto.paidById);
        if (dto.clientId) await this.client(dto.clientId);
        if (dto.subscriptionId) await this.subscription(dto.subscriptionId);
        if (dto.rebillPaise && !dto.clientId) throw new BadRequestException('Choose the client to bill for it.');
        const weights = dto.weights ? await this.checkWeights(dto.weights) : undefined;

        return this.prisma.$transaction(async (tx) => {
            const expense = await tx.ledgerExpense.create({
                data: {
                    description: dto.description.trim(),
                    category: dto.category,
                    vendor: text(dto.vendor) ?? null,
                    amountPaise: dto.amountPaise,
                    paidOn: toDbDate(dto.paidOn),
                    paidById: dto.paidById,
                    mode: dto.mode,
                    subscriptionId: dto.subscriptionId || null,
                    clientId: dto.clientId || null,
                    weights,
                    note: text(dto.note) ?? null,
                    createdBy: actor ?? null,
                },
            });
            let charge: { id: string } | null = null;
            if (dto.rebillPaise && dto.clientId) {
                charge = await tx.ledgerCharge.create({
                    data: {
                        clientId: dto.clientId,
                        expenseId: expense.id,
                        description: dto.description.trim(),
                        amountPaise: dto.rebillPaise,
                        dueDate: toDbDate(dto.rebillDueDate ?? dto.paidOn),
                        createdBy: actor ?? null,
                    },
                });
            }
            return { expense, charge };
        });
    }

    /** Deleting a purchase also deletes the client charge that passed it on, if any. */
    async deleteExpense(expenseId: string) {
        return this.prisma.$transaction(async (tx) => {
            const expense = await tx.ledgerExpense.findUnique({ where: { id: expenseId }, include: { rebill: { select: { id: true } } } });
            if (!expense) throw new NotFoundException('Expense not found');
            if (expense.rebill) await tx.ledgerCharge.delete({ where: { id: expense.rebill.id } });
            await tx.ledgerExpense.delete({ where: { id: expenseId } });
            return { deleted: true, chargeDeleted: !!expense.rebill };
        });
    }

    async createSettlement(dto: CreateSettlementDto, actor?: string) {
        if (dto.fromId === dto.toId) throw new BadRequestException('A partner cannot pay themselves.');
        await this.partner(dto.fromId);
        await this.partner(dto.toId);
        return this.prisma.ledgerSettlement.create({
            data: {
                fromId: dto.fromId,
                toId: dto.toId,
                amountPaise: dto.amountPaise,
                paidOn: toDbDate(dto.paidOn),
                mode: dto.mode,
                note: text(dto.note) ?? null,
                createdBy: actor ?? null,
            },
        });
    }

    async deleteSettlement(settlementId: string) {
        const { count } = await this.prisma.ledgerSettlement.deleteMany({ where: { id: settlementId } });
        if (!count) throw new NotFoundException('Transfer not found');
        return { deleted: true };
    }

    // -----------------------------------------------------------------------
    // Checks
    // -----------------------------------------------------------------------

    private async partner(id: string, mustBeActive = true) {
        const p = await this.prisma.ledgerPartner.findUnique({ where: { id } });
        if (!p) throw new BadRequestException('Unknown partner');
        if (mustBeActive && !p.isActive) throw new BadRequestException(`${p.name} is no longer an active partner`);
        return p;
    }

    private async client(id: string) {
        const c = await this.prisma.ledgerClient.findUnique({ where: { id } });
        if (!c) throw new BadRequestException('Unknown client');
        return c;
    }

    private async subscription(id: string) {
        const s = await this.prisma.ledgerSubscription.findUnique({ where: { id } });
        if (!s) throw new NotFoundException('Recurring cost not found');
        return s;
    }

    /** Weights must name real partners, be whole numbers, and give someone a share. */
    private async checkWeights(input: Record<string, unknown>): Promise<Weights> {
        const partners = await this.prisma.ledgerPartner.findMany({ select: { id: true } });
        const known = new Set(partners.map((p) => p.id));
        const out: Weights = {};
        for (const [id, w] of Object.entries(input ?? {})) {
            if (!known.has(id)) throw new BadRequestException('The split names someone who is not a partner');
            if (!Number.isInteger(w) || (w as number) < 0 || (w as number) > 1000) throw new BadRequestException('Each share must be a whole number from 0 to 1000');
            if ((w as number) > 0) out[id] = w as number;
        }
        if (!Object.keys(out).length) throw new BadRequestException('Give at least one partner a share');
        return out;
    }

    private async assertAdminLinkable(adminId: string, exceptPartnerId?: string) {
        const admin = await this.prisma.admin.findUnique({ where: { id: adminId }, select: { id: true, ledgerPartner: { select: { id: true, name: true } } } });
        if (!admin) throw new BadRequestException('Unknown Nexus account');
        if (admin.ledgerPartner && admin.ledgerPartner.id !== exceptPartnerId) {
            throw new ConflictException(`That account is already linked to ${admin.ledgerPartner.name}`);
        }
    }

    private conflict(e: unknown, message: string) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return new ConflictException(message);
        return e;
    }
}
