import { LedgerService } from './ledger.service';
import { toDbDate } from './ledger-math';

/**
 * LedgerService against a small in-memory stand-in for Prisma: enough of each
 * model for billing, the overview and renewals, so the wiring between the
 * database shapes and the arithmetic is exercised without a database.
 */

type Row = Record<string, any>;
const R = (rupees: number) => Math.round(rupees * 100);
let seq = 0;
const id = (p: string) => `${p}-${++seq}`;

function fakePrisma(db: Record<string, Row[]>) {
    const matches = (row: Row, where: Row = {}) =>
        Object.entries(where).every(([k, v]) => {
            if (v && typeof v === 'object' && !(v instanceof Date) && 'lte' in v) return row[k] && row[k] <= v.lte;
            if (v instanceof Date) return row[k]?.getTime() === v.getTime();
            return row[k] === v;
        });
    const model = (name: string) => ({
        findMany: async (args: Row = {}) => db[name].filter((r) => matches(r, args.where)),
        findUnique: async (args: Row) => db[name].find((r) => matches(r, args.where)) ?? null,
        count: async (args: Row = {}) => db[name].filter((r) => matches(r, args.where)).length,
        create: async ({ data }: Row) => {
            const row = { id: id(name), createdAt: new Date(), ...data };
            db[name].push(row);
            return row;
        },
        createMany: async ({ data }: Row) => {
            for (const d of data) db[name].push({ id: id(name), createdAt: new Date(), ...d });
            return { count: data.length };
        },
        update: async ({ where, data }: Row) => {
            const row = db[name].find((r) => matches(r, where))!;
            Object.assign(row, data);
            return row;
        },
        updateMany: async ({ where, data }: Row) => {
            const rows = db[name].filter((r) => matches(r, where));
            rows.forEach((r) => Object.assign(r, data));
            return { count: rows.length };
        },
    });
    const prisma: Row = {
        ledgerPartner: model('partners'),
        ledgerShareSchedule: model('schedules'),
        ledgerClient: model('clients'),
        ledgerPlan: model('plans'),
        ledgerCharge: model('charges'),
        ledgerReceipt: model('receipts'),
        ledgerExpense: model('expenses'),
        ledgerSettlement: model('settlements'),
        ledgerSubscription: model('subscriptions'),
        $transaction: async (fn: (tx: Row) => Promise<unknown>) => fn(prisma),
    };
    // The overview reads clients with their plans, and subscriptions with names attached.
    prisma.ledgerClient.findMany = async () => db.clients.map((c) => ({ ...c, plans: db.plans.filter((p) => p.clientId === c.id) }));
    prisma.ledgerPartner.findMany = async () => db.partners.map((p) => ({ ...p, admin: p.adminId ? { name: p.name, email: '' } : null }));
    prisma.ledgerSubscription.findMany = async (args: Row = {}) =>
        db.subscriptions.filter((s) => matches(s, args.where)).map((s) => ({
            ...s,
            defaultPayer: db.partners.find((p) => p.id === s.defaultPayerId) ?? null,
            client: db.clients.find((c) => c.id === s.clientId) ?? null,
        }));
    return prisma;
}

function barneBooks() {
    const db: Record<string, Row[]> = { partners: [], schedules: [], clients: [], plans: [], charges: [], receipts: [], expenses: [], settlements: [], subscriptions: [] };
    db.partners.push(
        { id: 'm', name: 'Mahesh', isActive: true, adminId: 'admin-m', sortOrder: 1 },
        { id: 's', name: 'Swapnil', isActive: true, adminId: 'admin-s', sortOrder: 2 },
        { id: 'a', name: 'Samrudhi', isActive: true, adminId: null, sortOrder: 3 },
    );
    db.schedules.push({ id: 'sch', effectiveFrom: toDbDate('2025-01-01'), weights: { m: 1, s: 1, a: 1 } });
    db.clients.push({ id: 'barne', name: 'Barne Farms', isActive: true });
    db.plans.push({
        id: 'hosting', clientId: 'barne', product: 'Hosting', amountPaise: R(2000), cycleMonths: 1,
        startDate: toDbDate('2025-07-01'), endDate: null, periodsBilled: 0, nextDueDate: toDbDate('2025-07-01'), isActive: true,
    });
    db.charges.push({ id: 'appstore', clientId: 'barne', planId: null, description: 'App Store', amountPaise: R(10000), dueDate: toDbDate('2026-10-01') });
    // 34,000 of hosting is billed by Nov 2026 (17 months); 34,000 paid leaves only the App Store charge.
    db.receipts.push(
        { id: 'r1', clientId: 'barne', amountPaise: R(26000), receivedOn: toDbDate('2026-03-12'), receivedById: 'm', weights: null },
        { id: 'r2', clientId: 'barne', amountPaise: R(8000), receivedOn: toDbDate('2026-11-17'), receivedById: 'a', weights: null },
    );
    db.expenses.push({ id: 'vps', amountPaise: R(21212), paidOn: toDbDate('2026-01-10'), paidById: 's', category: 'HOSTING', weights: null });
    db.subscriptions.push(
        { id: 'domain', name: 'Barne Farms domain', category: 'DOMAIN', vendor: null, amountPaise: R(1200), isEstimate: true, cycleMonths: 12, nextRenewal: toDbDate('2026-11-24'), autoRenew: false, paymentMethod: null, defaultPayerId: 'm', clientId: 'barne', rebillPaise: R(1420), isActive: true, notes: null },
        { id: 'ca', name: 'CA annual fee', category: 'PROFESSIONAL', vendor: null, amountPaise: R(30000), isEstimate: true, cycleMonths: 12, nextRenewal: null, autoRenew: false, paymentMethod: null, defaultPayerId: null, clientId: null, rebillPaise: null, isActive: true, notes: null },
        { id: 'roc', name: 'ROC: MGT-7', category: 'GOVERNMENT', vendor: null, amountPaise: null, isEstimate: true, cycleMonths: 12, nextRenewal: toDbDate('2026-11-29'), autoRenew: false, paymentMethod: null, defaultPayerId: null, clientId: null, rebillPaise: null, isActive: true, notes: null },
    );
    return db;
}

describe('LedgerService', () => {
    const TODAY = '2026-11-17';

    it('bills every due month of a plan once, however often billing runs', async () => {
        const db = barneBooks();
        const svc = new LedgerService(fakePrisma(db) as any);
        expect(await svc.billDuePlans(TODAY)).toBe(17);
        expect(await svc.billDuePlans(TODAY)).toBe(0);
        const plan = db.plans[0];
        expect(plan.periodsBilled).toBe(17);
        expect(plan.nextDueDate.toISOString().slice(0, 10)).toBe('2026-12-01');
        expect(db.charges.filter((c) => c.planId === 'hosting')).toHaveLength(17);
    });

    it('builds the overview: what is owed, who owes whom, renewals in order, gaps named', async () => {
        const svc = new LedgerService(fakePrisma(barneBooks()) as any);
        const o = await svc.overview('m', 2026, TODAY);

        const barne = o.clients.find((c) => c.name === 'Barne Farms')!;
        expect(barne.status.outstanding).toBe(R(10000));
        expect(barne.status.oldestUnpaid).toBe('2026-10-01');
        expect(barne.nextDue?.dueDate).toBe('2026-12-01');
        expect(o.totals.payingClients).toBe(1);
        expect(o.totals.mrrPaise).toBe(R(2000));
        expect(o.totals.arrPaise).toBe(R(24000));

        // Balances always net to zero, and settling up clears them.
        expect(o.balances.reduce((s, b) => s + b.balance, 0)).toBe(0);
        const after = Object.fromEntries(o.balances.map((b) => [b.partnerId, b.balance]));
        for (const t of o.settleUp) { after[t.fromId] += t.amountPaise; after[t.toId] -= t.amountPaise; }
        expect(Object.values(after).every((v) => v === 0)).toBe(true);
        // Swapnil paid the VPS and holds no client money, so is owed.
        expect(o.balances.find((b) => b.partnerId === 's')!.balance).toBeGreaterThan(0);

        expect(o.renewals.map((r) => [r.name, r.bucket])).toEqual([
            ['Barne Farms domain', 'week'],
            ['ROC: MGT-7', 'month'], // 12 days away
            ['CA annual fee', 'missing'],
        ]);
        expect(o.renewals[0].daysLeft).toBe(7);
        expect(o.totals.recurringCostsUnpriced).toBe(1);
        expect(o.warnings.join(' ')).toMatch(/1 recurring cost has no renewal date/);
        expect(o.warnings.join(' ')).toMatch(/3 recurring costs are marked tentative/);
        expect(o.warnings.join(' ')).toMatch(/Samrudhi has no Nexus account linked/);

        const nov = o.months.find((m) => m.month === '2026-11')!;
        expect(nov.billedPaise).toBe(R(2000));
        expect(nov.receivedPaise).toBe(R(8000));
        expect(o.yearTotals.billedClients).toBe(1);
    });

    it('marks a renewal paid: expense, next date from the old date, and the client billed', async () => {
        const db = barneBooks();
        const svc = new LedgerService(fakePrisma(db) as any);
        // Paid three days late; the next renewal still falls on 24 Nov.
        const result = await svc.renewSubscription('domain', { paidOn: '2026-11-27', paidById: 'm', mode: 'UPI' }, 'Mahesh');

        expect(result.expense).toMatchObject({ amountPaise: R(1200), paidById: 'm', category: 'DOMAIN', subscriptionId: 'domain', clientId: 'barne' });
        const sub = db.subscriptions.find((s) => s.id === 'domain')!;
        expect(sub.nextRenewal.toISOString().slice(0, 10)).toBe('2027-11-24');
        expect(sub.isEstimate).toBe(false);
        expect(result.charge).toMatchObject({ clientId: 'barne', amountPaise: R(1420), expenseId: result.expense.id });
    });

    it('will not renew without an amount, and can skip billing the client', async () => {
        const db = barneBooks();
        const svc = new LedgerService(fakePrisma(db) as any);
        await expect(svc.renewSubscription('roc', { paidOn: TODAY, paidById: 's', mode: 'BANK' })).rejects.toThrow(/Enter the amount paid/);

        const r = await svc.renewSubscription('roc', { paidOn: TODAY, paidById: 's', mode: 'BANK', amountPaise: R(600) });
        expect(r.charge).toBeNull();
        // The first real payment becomes the amount on record.
        expect(db.subscriptions.find((s) => s.id === 'roc')!.amountPaise).toBe(R(600));

        const d = await svc.renewSubscription('domain', { paidOn: TODAY, paidById: 'm', mode: 'UPI', billClient: false });
        expect(d.charge).toBeNull();
    });

    it('refuses a split that names a stranger or gives nobody a share', async () => {
        const svc = new LedgerService(fakePrisma(barneBooks()) as any);
        await expect(svc.createShareSchedule({ effectiveFrom: '2027-04-01', weights: { m: 1, x: 1 } })).rejects.toThrow(/not a partner/);
        await expect(svc.createShareSchedule({ effectiveFrom: '2027-04-01', weights: { m: 0, s: 0 } })).rejects.toThrow(/at least one partner/);
        await expect(svc.createShareSchedule({ effectiveFrom: '2027-04-01', weights: { m: 1.5 } })).rejects.toThrow(/whole number/);
    });

    it('lets in the super admin and linked partners only', async () => {
        const svc = new LedgerService(fakePrisma(barneBooks()) as any);
        expect((await svc.access('admin-m', 'ADMIN')).allowed).toBe(true);
        expect((await svc.access('admin-x', 'ADMIN')).allowed).toBe(false);
        expect((await svc.access('admin-x', 'SUPER_ADMIN')).allowed).toBe(true);
    });
});
