/**
 * One-off: load Payment Tracker.xlsx (CI Expenses, Barne Payment History,
 * VectraWD) into the Ledger, plus the recurring costs and tentative company
 * filings discussed on 2026-11-17. Runs against whatever DATABASE_URL is in .env.
 *
 *   npx ts-node scripts/ledger-import.ts           # dry run: what it would write, the
 *                                                  # balances that result, and what is missing
 *   npx ts-node scripts/ledger-import.ts --partners  # only the partners, the split and
 *                                                    # their account links, so the page opens
 *   npx ts-node scripts/ledger-import.ts --apply   # writes, once nothing is missing
 *
 * `null` below means "not known yet". The dry run lists every one; --apply
 * refuses while any remain on a row that affects who owes whom, because a
 * guessed payer is a wrong balance that looks right. Fill them in and re-run.
 *
 * --apply reuses partners that already exist (from --partners or the page) and
 * refuses if the Ledger already has clients, so the books can only ever load
 * once. After that, the page is the way to change anything.
 *
 * Amounts here are RUPEES for readability; the script converts to paise.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import {
    clientStatus,
    dueDatesUpTo,
    formatRupees,
    nextPlanDue,
    partnerBalances,
    settleUp,
    toDbDate,
    todayIst,
} from '../src/modules/ledger/ledger-math';

type Who = 'Mahesh' | 'Swapnil' | 'Samrudhi';
type Mode = 'UPI' | 'CASH' | 'CARD' | 'BANK' | 'OTHER';
type Category = 'HOSTING' | 'SOFTWARE' | 'DOMAIN' | 'APP_STORE' | 'EQUIPMENT' | 'PROFESSIONAL' | 'GOVERNMENT' | 'OTHER';

/** Paid for Lovable, Base44 and the App Store (confirmed 2026-11-17). */
const YOU: Who = 'Mahesh';

const PARTNERS: Array<{ name: Who; sortOrder: number; adminNameHint: string }> = [
    { name: 'Mahesh', sortOrder: 1, adminNameHint: 'mahesh' },
    { name: 'Swapnil', sortOrder: 2, adminNameHint: 'swapnil' },
    { name: 'Samrudhi', sortOrder: 3, adminNameHint: 'samrudhi' },
];

/** An equal third each, from before the first entry. */
const SPLIT = { effectiveFrom: '2025-01-01', weights: { Mahesh: 1, Swapnil: 1, Samrudhi: 1 } as Record<Who, number> };

interface ClientIn {
    name: string;
    notes?: string;
    plans: Array<{ product: string; amount: number; cycleMonths: number; startDate: string; notes?: string }>;
    charges: Array<{ description: string; amount: number; dueDate: string; note?: string }>;
    receipts: Array<{ on: string; amount: number; mode: Mode; by: Who | null; note?: string }>;
}

const CLIENTS: ClientIn[] = [
    {
        name: 'Barne Farms',
        notes: 'Imported from Payment Tracker.xlsx (Barne Payment History).',
        plans: [{ product: 'Hosting', amount: 2000, cycleMonths: 1, startDate: '2025-07-01' }],
        charges: [
            { description: 'Domain renewal', amount: 1420, dueDate: '2025-11-24' },
            { description: 'App Store', amount: 8900, dueDate: '2025-12-01' },
            // In column F of the sheet, outside its total. Shows as owed unless it was paid.
            { description: 'App Store', amount: 10000, dueDate: '2026-10-01' },
        ],
        receipts: [
            // CI Expenses credits Mahesh 13,971, Swapnil 10,000, Samrudhi 10,000 for these.
            // Which 10,000 each of Swapnil and Samrudhi took is assumed; the totals are what count.
            // The rest come to 14,900 for Mahesh, not 13,971: the 929 gap is unexplained.
            { on: '2025-07-17', amount: 2000, mode: 'UPI', by: 'Mahesh', note: 'PhonePe' },
            { on: '2025-08-23', amount: 2000, mode: 'UPI', by: 'Mahesh', note: 'PhonePe' },
            { on: '2025-09-28', amount: 2000, mode: 'UPI', by: 'Mahesh', note: 'PhonePe' },
            { on: '2025-11-06', amount: 2000, mode: 'UPI', by: 'Mahesh', note: 'PhonePe' },
            { on: '2025-12-13', amount: 2900, mode: 'UPI', by: 'Mahesh', note: 'PhonePe' },
            { on: '2026-01-05', amount: 10000, mode: 'CASH', by: 'Swapnil' },
            { on: '2026-03-12', amount: 10000, mode: 'UPI', by: 'Samrudhi', note: 'PhonePe' },
            { on: '2026-09-06', amount: 4000, mode: 'CASH', by: 'Mahesh' },
            { on: '2025-11-24', amount: 1420, mode: 'UPI', by: 'Mahesh', note: 'Domain renewal, PhonePe' },
            { on: '2026-11-17', amount: 8000, mode: 'CASH', by: 'Mahesh', note: 'Hosting Aug to Nov 2026' },
        ],
    },
    {
        name: 'VectraWD',
        notes: 'Imported from Payment Tracker.xlsx (VectraWD). Paid 6,000 in all.',
        plans: [
            { product: 'Website (one-time)', amount: 3000, cycleMonths: 0, startDate: '2026-07-14' },
            { product: 'Annual hosting', amount: 3000, cycleMonths: 12, startDate: '2026-07-14' },
        ],
        charges: [],
        receipts: [{ on: '2026-07-14', amount: 6000, mode: 'OTHER', by: 'Mahesh', note: 'Date and mode not in the sheet; CI Expenses credits Mahesh.' }],
    },
];

interface SubIn {
    name: string;
    category: Category;
    vendor?: string;
    amount: number | null;
    cycleMonths: number;
    nextRenewal: string | null;
    isEstimate?: boolean;
    payer?: Who | null;
    client?: string;
    rebill?: number;
    notes?: string;
}

const TENTATIVE = 'Tentative: confirm the date and amount with the CA. Mark renewed once filed and it moves to next year.';

const SUBSCRIPTIONS: SubIn[] = [
    { name: 'VPS', category: 'HOSTING', vendor: 'Hostinger', amount: 21212, cycleMonths: 24, nextRenewal: null, payer: 'Swapnil', notes: '24-month plan. Renewal date to be filled in.' },
    { name: 'Lovable', category: 'SOFTWARE', vendor: 'Lovable', amount: 5103, cycleMonths: 12, nextRenewal: null, payer: YOU, notes: 'Bought in 2026 for one year. Renewal date to be filled in.' },
    { name: 'Base44', category: 'SOFTWARE', vendor: 'Base44', amount: 32202, cycleMonths: 12, nextRenewal: null, payer: YOU, notes: 'Bought in 2026 for one year. Renewal date to be filled in.' },
    { name: 'Apple Developer (Barne Farms app)', category: 'APP_STORE', vendor: 'Apple', amount: 8700, cycleMonths: 12, nextRenewal: '2027-10-01', isEstimate: true, payer: YOU, client: 'Barne Farms', rebill: 10000, notes: 'Barne was billed 10,000 on 1 Oct 2026; renewal date assumed a year on.' },
    { name: 'Barne Farms domain', category: 'DOMAIN', amount: null, cycleMonths: 12, nextRenewal: '2026-11-24', isEstimate: true, client: 'Barne Farms', rebill: 1420, notes: 'Last renewed 24 Nov 2025 (billed 1,420). Our cost not recorded.' },
    { name: 'codeimplants.com domain', category: 'DOMAIN', vendor: 'Hostinger', amount: null, cycleMonths: 12, nextRenewal: null },
    { name: 'Panchal domain', category: 'DOMAIN', amount: null, cycleMonths: 12, nextRenewal: null, notes: 'Whether Panchal Sonar is billed for it is not decided yet.' },
    { name: 'VectraWD domain', category: 'DOMAIN', amount: 1201, cycleMonths: 12, nextRenewal: '2027-07-14', payer: 'Mahesh', notes: 'Covered by VectraWD\'s hosting fee, so not billed on.' },
    { name: 'CA annual fee', category: 'PROFESSIONAL', amount: 30000, cycleMonths: 12, nextRenewal: null, isEstimate: true, notes: 'Last paid 30,000. Date not recorded.' },
    // Usual private limited company deadlines for a financial year ending 31 March
    // with the AGM by 30 September. Amounts depend on capital and late fees.
    { name: 'ROC: AOC-4 (financial statements)', category: 'GOVERNMENT', vendor: 'MCA', amount: null, cycleMonths: 12, nextRenewal: '2026-10-30', isEstimate: true, notes: `Due within 30 days of the AGM. ${TENTATIVE}` },
    { name: 'ROC: MGT-7 (annual return)', category: 'GOVERNMENT', vendor: 'MCA', amount: null, cycleMonths: 12, nextRenewal: '2026-11-29', isEstimate: true, notes: `Due within 60 days of the AGM. ${TENTATIVE}` },
    { name: 'Income tax return (ITR-6)', category: 'GOVERNMENT', vendor: 'Income Tax Dept', amount: null, cycleMonths: 12, nextRenewal: '2026-10-31', isEstimate: true, notes: `Companies file by 31 October. ${TENTATIVE}` },
    { name: 'DIR-3 KYC (directors)', category: 'GOVERNMENT', vendor: 'MCA', amount: null, cycleMonths: 12, nextRenewal: '2027-09-30', isEstimate: true, notes: `Each director, by 30 September; the rules on how often have been changing. ${TENTATIVE}` },
    { name: 'Professional tax', category: 'GOVERNMENT', amount: null, cycleMonths: 12, nextRenewal: null, isEstimate: true, notes: `Due date and amount depend on the state. ${TENTATIVE}` },
];

interface ExpenseIn {
    description: string;
    category: Category;
    vendor?: string;
    amount: number;
    paidOn: string | null;
    paidBy: Who | null;
    mode: Mode;
    subscription?: string;
    client?: string;
    note?: string;
}

const EXPENSES: ExpenseIn[] = [
    { description: 'VPS (2 years)', category: 'HOSTING', vendor: 'Hostinger', amount: 21212, paidOn: null, paidBy: 'Swapnil', mode: 'OTHER', subscription: 'VPS' },
    { description: 'Lovable (1 year)', category: 'SOFTWARE', vendor: 'Lovable', amount: 5103, paidOn: null, paidBy: YOU, mode: 'OTHER', subscription: 'Lovable' },
    { description: 'Base44 (1 year)', category: 'SOFTWARE', vendor: 'Base44', amount: 32202, paidOn: null, paidBy: YOU, mode: 'OTHER', subscription: 'Base44' },
    { description: 'Apple Developer Program', category: 'APP_STORE', vendor: 'Apple', amount: 8700, paidOn: null, paidBy: YOU, mode: 'OTHER', subscription: 'Apple Developer (Barne Farms app)', client: 'Barne Farms', note: 'The second App Store payment; the first is not recorded.' },
    { description: 'VectraWD domain', category: 'DOMAIN', amount: 1201, paidOn: '2026-07-14', paidBy: 'Mahesh', mode: 'OTHER', subscription: 'VectraWD domain', client: 'VectraWD' },
];

// ---------------------------------------------------------------------------

const apply = process.argv.includes('--apply');
const partnersOnly = process.argv.includes('--partners');
const R = (rupees: number) => Math.round(rupees * 100);
const today = todayIst();

/**
 * An unknown payment date does not change who owes whom (one split covers all
 * of it), only which month the cost shows in. So, as agreed on 2026-11-18, such
 * expenses are recorded on the import day with a note saying so, to be deleted
 * and re-added with the real date. Unknown payers and receivers still block.
 */
const UNDATED_NOTE = `Real payment date not known yet; recorded on the import day (${today}). Delete and add again with the real date.`;
const expenseNote = (e: ExpenseIn) => (e.paidOn ? e.note : [e.note, UNDATED_NOTE].filter(Boolean).join(' '));

function missingFacts(): string[] {
    const out: string[] = [];
    for (const c of CLIENTS) for (const r of c.receipts) if (!r.by) out.push(`Who received ${c.name}'s ${formatRupees(R(r.amount))} on ${r.on}${r.note ? ` (${r.note})` : ''}?`);
    for (const e of EXPENSES) if (!e.paidBy) out.push(`Who paid for ${e.description} (${formatRupees(R(e.amount))})?`);
    return out;
}

function preview() {
    const ids = PARTNERS.map((p) => p.name);
    const schedules = [{ effectiveFrom: SPLIT.effectiveFrom, weights: SPLIT.weights }];
    const knownExpenses = EXPENSES.filter((e) => e.paidBy).map((e) => ({ amountPaise: R(e.amount), paidById: e.paidBy!, day: e.paidOn ?? today }));
    const knownReceipts = CLIENTS.flatMap((c) => c.receipts.filter((r) => r.by).map((r) => ({ amountPaise: R(r.amount), receivedById: r.by!, day: r.on })));
    const balances = partnerBalances(ids, schedules, knownExpenses, knownReceipts, []);

    console.log(`\nBalances from what is known so far (${knownExpenses.length}/${EXPENSES.length} expenses, ${knownReceipts.length}/${CLIENTS.flatMap((c) => c.receipts).length} payments):`);
    console.table(balances.map((b) => ({
        partner: b.partnerId,
        'paid out': formatRupees(b.paid),
        'holds (client money)': formatRupees(b.received),
        'share of costs': formatRupees(b.shareOfCosts),
        'share of income': formatRupees(b.shareOfIncome),
        balance: `${formatRupees(b.balance)} ${b.balance > 0 ? '(is owed)' : b.balance < 0 ? '(owes)' : ''}`,
    })));
    for (const t of settleUp(balances)) console.log(`  ${t.fromId} pays ${t.toId} ${formatRupees(t.amountPaise)}`);

    console.log('\nClients as of today:');
    for (const c of CLIENTS) {
        const charges = [
            ...c.charges.map((ch) => ({ amountPaise: R(ch.amount), dueDate: ch.dueDate })),
            ...c.plans.flatMap((p) => dueDatesUpTo({ startDate: p.startDate, cycleMonths: p.cycleMonths, periodsBilled: 0 }, today).map((d) => ({ amountPaise: R(p.amount), dueDate: d }))),
        ];
        const paid = c.receipts.reduce((s, r) => s + R(r.amount), 0);
        const s = clientStatus(charges, paid, today);
        console.log(`  ${c.name}: billed ${formatRupees(s.billedToDate)}, paid ${formatRupees(s.paid)}, outstanding ${formatRupees(s.outstanding)}${s.oldestUnpaid ? ` (unpaid since ${s.oldestUnpaid})` : ''}${s.credit ? `, credit ${formatRupees(s.credit)}` : ''}`);
    }

    console.log('\nRecurring costs:');
    console.table(SUBSCRIPTIONS.map((s) => ({
        name: s.name,
        amount: s.amount ? formatRupees(R(s.amount)) : 'not set',
        every: `${s.cycleMonths} mo`,
        next: s.nextRenewal ?? 'date missing',
        tentative: s.isEstimate ? 'yes' : '',
        'billed to': s.client ?? '',
    })));
}

/**
 * The partners by name → id, creating them (linked to the one active account
 * whose name or email contains their name, if exactly one does) and the split
 * when the Ledger has none. Existing partners are reused, never duplicated.
 */
async function ensurePartners(tx: Prisma.TransactionClient): Promise<Record<string, string>> {
    const pid: Record<string, string> = {};
    const existing = await tx.ledgerPartner.findMany();
    if (existing.length) {
        for (const p of existing) pid[p.name] = p.id;
        const absent = PARTNERS.filter((p) => !pid[p.name]).map((p) => p.name);
        if (absent.length) throw new Error(`The Ledger has partners, but not ${absent.join(', ')}. Add them on the page first.`);
        console.log(`Partners already set up: ${existing.map((p) => p.name).join(', ')}`);
    } else {
        const admins = await tx.admin.findMany({ where: { isActive: true }, select: { id: true, name: true, email: true } });
        for (const p of PARTNERS) {
            const matches = admins.filter((a) => (a.name ?? a.email).toLowerCase().includes(p.adminNameHint));
            const row = await tx.ledgerPartner.create({ data: { name: p.name, sortOrder: p.sortOrder, adminId: matches.length === 1 ? matches[0].id : null } });
            pid[p.name] = row.id;
            console.log(`Partner ${p.name}: ${matches.length === 1 ? `linked to ${matches[0].name ?? matches[0].email}` : `not linked (${matches.length} matching accounts); link on the page`}`);
        }
    }
    if ((await tx.ledgerShareSchedule.count()) === 0) {
        await tx.ledgerShareSchedule.create({
            data: {
                effectiveFrom: toDbDate(SPLIT.effectiveFrom),
                weights: Object.fromEntries(Object.entries(SPLIT.weights).map(([n, w]) => [pid[n], w])),
                note: 'Equal thirds',
                createdBy: 'import',
            },
        });
        console.log(`Split: equal thirds from ${SPLIT.effectiveFrom}`);
    }
    return pid;
}

async function main() {
    if (partnersOnly) {
        const prisma = new PrismaClient();
        try {
            await prisma.$transaction((tx) => ensurePartners(tx));
            console.log('\nPartners ready. Open Nexus > Ledger.');
        } finally {
            await prisma.$disconnect();
        }
        return;
    }

    const missing = missingFacts();
    preview();
    const undated = EXPENSES.filter((e) => !e.paidOn);
    if (undated.length) {
        console.log(`\nDate not known, recorded on ${today} (${undated.length}):`);
        for (const e of undated) console.log(`  - ${e.description} (${formatRupees(R(e.amount))})`);
    }
    if (missing.length) {
        console.log(`\nStill missing (${missing.length}):`);
        for (const m of missing) console.log(`  - ${m}`);
    }
    if (!apply) {
        console.log('\nDry run: nothing written. Re-run with --apply once nothing is missing.');
        return;
    }
    if (missing.length) {
        console.error('\nRefusing to write: fill in the missing facts above first.');
        process.exit(1);
    }

    const prisma = new PrismaClient();
    try {
        if (await prisma.ledgerClient.count()) throw new Error('The Ledger already has clients. This import only loads empty books; use the page from here on.');

        await prisma.$transaction(async (tx) => {
            const pid = await ensurePartners(tx);

            const cid: Record<string, string> = {};
            for (const c of CLIENTS) {
                const client = await tx.ledgerClient.create({ data: { name: c.name, notes: c.notes } });
                cid[c.name] = client.id;
                for (const p of c.plans) {
                    const sched = { startDate: p.startDate, cycleMonths: p.cycleMonths, periodsBilled: 0 };
                    const dates = dueDatesUpTo(sched, today);
                    const next = nextPlanDue({ ...sched, periodsBilled: dates.length });
                    const plan = await tx.ledgerPlan.create({
                        data: {
                            clientId: client.id,
                            product: p.product,
                            amountPaise: R(p.amount),
                            cycleMonths: p.cycleMonths,
                            startDate: toDbDate(p.startDate),
                            periodsBilled: dates.length,
                            nextDueDate: next ? toDbDate(next) : null,
                            notes: p.notes,
                        },
                    });
                    await tx.ledgerCharge.createMany({
                        data: dates.map((d) => ({ clientId: client.id, planId: plan.id, description: p.product, amountPaise: R(p.amount), dueDate: toDbDate(d), createdBy: 'import' })),
                    });
                }
                for (const ch of c.charges) {
                    await tx.ledgerCharge.create({ data: { clientId: client.id, description: ch.description, amountPaise: R(ch.amount), dueDate: toDbDate(ch.dueDate), note: ch.note, createdBy: 'import' } });
                }
                for (const r of c.receipts) {
                    await tx.ledgerReceipt.create({ data: { clientId: client.id, amountPaise: R(r.amount), receivedOn: toDbDate(r.on), mode: r.mode, receivedById: pid[r.by!], note: r.note, createdBy: 'import' } });
                }
            }

            const sid: Record<string, string> = {};
            for (const s of SUBSCRIPTIONS) {
                const row = await tx.ledgerSubscription.create({
                    data: {
                        name: s.name,
                        category: s.category,
                        vendor: s.vendor,
                        amountPaise: s.amount ? R(s.amount) : null,
                        isEstimate: !!s.isEstimate,
                        cycleMonths: s.cycleMonths,
                        nextRenewal: s.nextRenewal ? toDbDate(s.nextRenewal) : null,
                        defaultPayerId: s.payer ? pid[s.payer] : null,
                        clientId: s.client ? cid[s.client] : null,
                        rebillPaise: s.rebill ? R(s.rebill) : null,
                        notes: s.notes,
                    },
                });
                sid[s.name] = row.id;
            }

            for (const e of EXPENSES) {
                await tx.ledgerExpense.create({
                    data: {
                        description: e.description,
                        category: e.category,
                        vendor: e.vendor,
                        amountPaise: R(e.amount),
                        paidOn: toDbDate(e.paidOn ?? today),
                        paidById: pid[e.paidBy!],
                        mode: e.mode,
                        subscriptionId: e.subscription ? sid[e.subscription] : null,
                        clientId: e.client ? cid[e.client] : null,
                        note: expenseNote(e),
                        createdBy: 'import',
                    },
                });
            }
        }, { timeout: 60_000 }); // ~60 writes; Prisma's 5 s default is too tight to be sure of.
        console.log('\nImported. Open Nexus > Ledger.');
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
});
