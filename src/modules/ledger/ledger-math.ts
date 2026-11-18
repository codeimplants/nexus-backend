/**
 * The Ledger's arithmetic, kept free of Nest and Prisma so it can be tested on
 * its own. Everything that decides who owes whom lives here.
 *
 * Units: money is integer paise; a day is 'YYYY-MM-DD' in IST.
 */

export type Day = string;
/** { "<partnerId>": weight }. Weights, not percentages: 1/1/1 is an exact third each. */
export type Weights = Record<string, number>;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's date in India, whatever the server's clock zone. */
export const todayIst = (now = Date.now()): Day => new Date(now + IST_OFFSET_MS).toISOString().slice(0, 10);

/** A DATE column comes back from Prisma as midnight UTC of that day. */
export const dayOf = (d: Date): Day => d.toISOString().slice(0, 10);
export const toDbDate = (day: Day): Date => new Date(`${day}T00:00:00.000Z`);

export function isDay(value: unknown): value is Day {
    if (typeof value !== 'string' || !DAY_RE.test(value)) return false;
    const t = Date.parse(`${value}T00:00:00Z`);
    return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === value;
}

/** b minus a, in whole days. */
export const daysBetween = (a: Day, b: Day): number =>
    Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

/**
 * Calendar months later, clamped to the end of a short month: 31 Jan + 1 month
 * is 28 (or 29) Feb, never 3 March.
 */
export function addMonths(day: Day, months: number): Day {
    const [y, m, d] = day.split('-').map(Number);
    const total = y * 12 + (m - 1) + months;
    const year = Math.floor(total / 12);
    const month = total - year * 12; // 0-based
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, month, Math.min(d, lastDay))).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Client plans
// ---------------------------------------------------------------------------

export interface PlanSchedule {
    startDate: Day;
    cycleMonths: number;
    periodsBilled: number;
    endDate?: Day | null;
}

/**
 * When a plan bills next, or null if it never will again.
 *
 * Counted from the start date (start + cycle x n), not from the previous due
 * date, so a plan that starts on the 31st bills on the 31st whenever the month
 * has one instead of sliding to the 28th forever after February.
 */
export function nextPlanDue(plan: PlanSchedule): Day | null {
    if (plan.cycleMonths <= 0) return plan.periodsBilled === 0 ? plan.startDate : null;
    const due = addMonths(plan.startDate, plan.cycleMonths * plan.periodsBilled);
    if (plan.endDate && due > plan.endDate) return null;
    return due;
}

/** Every due date a plan has reached by `today` and not billed yet, oldest first. */
export function dueDatesUpTo(plan: PlanSchedule, today: Day, max = 240): Day[] {
    const out: Day[] = [];
    let periods = plan.periodsBilled;
    for (let i = 0; i < max; i++) {
        const due = nextPlanDue({ ...plan, periodsBilled: periods });
        if (!due || due > today) break;
        out.push(due);
        periods++;
    }
    return out;
}

/** What a repeating amount costs per month, for MRR-style totals. One-time = 0. */
export const monthlyEquivalent = (amountPaise: number, cycleMonths: number): number =>
    cycleMonths > 0 ? Math.round(amountPaise / cycleMonths) : 0;

// ---------------------------------------------------------------------------
// Splitting money
// ---------------------------------------------------------------------------

/**
 * Splits an amount by weight so the parts add up to the amount exactly.
 *
 * Largest-remainder: everyone gets the floor of their exact share, and the
 * leftover paise go one each to the largest fractions. Ties go to whoever is
 * earlier in `order`, so the same inputs always split the same way and the
 * three balances always sum to zero.
 */
export function allocate(amountPaise: number, weights: Weights, order: string[] = Object.keys(weights)): Record<string, number> {
    const ids = [...new Set([...order.filter((id) => id in weights), ...Object.keys(weights)])].filter((id) => weights[id] > 0);
    const total = ids.reduce((s, id) => s + weights[id], 0);
    if (total <= 0) throw new Error('A split needs at least one positive weight');

    const parts = ids.map((id, i) => {
        const exact = (amountPaise * weights[id]) / total;
        const floor = Math.floor(exact);
        return { id, i, floor, rem: exact - floor };
    });
    let left = amountPaise - parts.reduce((s, p) => s + p.floor, 0);
    const out: Record<string, number> = Object.fromEntries(parts.map((p) => [p.id, p.floor]));
    for (const p of [...parts].sort((a, b) => b.rem - a.rem || a.i - b.i)) {
        if (left <= 0) break;
        out[p.id] += 1;
        left--;
    }
    return out;
}

export interface ShareSchedule {
    effectiveFrom: Day;
    weights: Weights;
}

/**
 * The split in force on a day: the latest schedule starting on or before it.
 * A day before the first schedule uses the first one, so old entries imported
 * later are still split. With no schedule at all, active partners share equally.
 */
export function weightsOn(day: Day, schedules: ShareSchedule[], fallbackPartnerIds: string[]): Weights {
    const sorted = [...schedules].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    let pick: ShareSchedule | undefined;
    for (const s of sorted) if (s.effectiveFrom <= day) pick = s;
    pick ??= sorted[0];
    if (pick) return pick.weights;
    return Object.fromEntries(fallbackPartnerIds.map((id) => [id, 1]));
}

// ---------------------------------------------------------------------------
// Who owes whom
// ---------------------------------------------------------------------------

export interface MoneyOut { amountPaise: number; paidById: string; day: Day; weights?: Weights | null }
export interface MoneyIn { amountPaise: number; receivedById: string; day: Day; weights?: Weights | null }
export interface Transfer { fromId: string; toId: string; amountPaise: number }

export interface PartnerBalance {
    partnerId: string;
    /** Spent on the business from their own pocket. */
    paid: number;
    /** Client money they are holding. */
    received: number;
    /** Paid to other partners to settle up. */
    sent: number;
    /** Received from other partners to settle up. */
    got: number;
    /** Their share of everything spent. */
    shareOfCosts: number;
    /** Their share of everything clients paid. */
    shareOfIncome: number;
    /**
     * Positive: the others owe them this much. Negative: they owe it.
     * paid + sent - received - got - shareOfCosts + shareOfIncome
     */
    balance: number;
}

/**
 * Each partner's position. A partner who paid a bill has put in more than
 * their share; a partner holding client money has taken out more than theirs.
 * The balance is the difference, and the balances of all partners sum to zero.
 */
export function partnerBalances(
    partnerIds: string[],
    schedules: ShareSchedule[],
    expenses: MoneyOut[],
    receipts: MoneyIn[],
    settlements: Transfer[],
): PartnerBalance[] {
    const rows = new Map<string, PartnerBalance>(
        partnerIds.map((id) => [id, { partnerId: id, paid: 0, received: 0, sent: 0, got: 0, shareOfCosts: 0, shareOfIncome: 0, balance: 0 }]),
    );
    const row = (id: string) => {
        let r = rows.get(id);
        if (!r) {
            // A partner who has since been deactivated still carries their history.
            r = { partnerId: id, paid: 0, received: 0, sent: 0, got: 0, shareOfCosts: 0, shareOfIncome: 0, balance: 0 };
            rows.set(id, r);
        }
        return r;
    };

    for (const e of expenses) {
        row(e.paidById).paid += e.amountPaise;
        const split = allocate(e.amountPaise, e.weights ?? weightsOn(e.day, schedules, partnerIds), partnerIds);
        for (const [id, part] of Object.entries(split)) row(id).shareOfCosts += part;
    }
    for (const r of receipts) {
        row(r.receivedById).received += r.amountPaise;
        const split = allocate(r.amountPaise, r.weights ?? weightsOn(r.day, schedules, partnerIds), partnerIds);
        for (const [id, part] of Object.entries(split)) row(id).shareOfIncome += part;
    }
    for (const s of settlements) {
        row(s.fromId).sent += s.amountPaise;
        row(s.toId).got += s.amountPaise;
    }
    for (const r of rows.values()) {
        r.balance = r.paid + r.sent - r.received - r.got - r.shareOfCosts + r.shareOfIncome;
    }
    return [...rows.values()];
}

/**
 * The payments that bring every balance to zero: whoever owes the most pays
 * whoever is owed the most, repeatedly. With three partners that is at most
 * two transfers.
 */
export function settleUp(balances: Array<{ partnerId: string; balance: number }>): Transfer[] {
    const owed = balances.filter((b) => b.balance > 0).map((b) => ({ id: b.partnerId, left: b.balance }));
    const owing = balances.filter((b) => b.balance < 0).map((b) => ({ id: b.partnerId, left: -b.balance }));
    owed.sort((a, b) => b.left - a.left);
    owing.sort((a, b) => b.left - a.left);
    const out: Transfer[] = [];
    let i = 0;
    let j = 0;
    while (i < owing.length && j < owed.length) {
        const amount = Math.min(owing[i].left, owed[j].left);
        if (amount > 0) out.push({ fromId: owing[i].id, toId: owed[j].id, amountPaise: amount });
        owing[i].left -= amount;
        owed[j].left -= amount;
        if (owing[i].left === 0) i++;
        if (owed[j].left === 0) j++;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export interface ClientStatus {
    /** Charges due on or before today. */
    billedToDate: number;
    /** Charges dated after today (added in advance). */
    upcoming: number;
    paid: number;
    /** Due and not yet paid. */
    outstanding: number;
    /** Paid ahead of what is due. */
    credit: number;
    /** Due date of the last charge fully covered by payments, oldest first. */
    paidThrough: Day | null;
    /** Due date of the oldest charge not fully paid, if it is already due. */
    oldestUnpaid: Day | null;
    daysOverdue: number;
}

/**
 * Where a client stands. Payments are applied to charges oldest first, which is
 * how a client thinks of it ("paid up to November") and needs no per-payment
 * matching to be entered.
 */
export function clientStatus(charges: Array<{ amountPaise: number; dueDate: Day }>, paidPaise: number, today: Day): ClientStatus {
    const sorted = [...charges].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    let billedToDate = 0;
    let upcoming = 0;
    for (const c of sorted) {
        if (c.dueDate <= today) billedToDate += c.amountPaise;
        else upcoming += c.amountPaise;
    }
    let left = paidPaise;
    let paidThrough: Day | null = null;
    let oldestUnpaid: Day | null = null;
    for (const c of sorted) {
        if (left >= c.amountPaise) {
            left -= c.amountPaise;
            paidThrough = c.dueDate;
        } else {
            if (c.dueDate <= today) oldestUnpaid = c.dueDate;
            break;
        }
    }
    return {
        billedToDate,
        upcoming,
        paid: paidPaise,
        outstanding: Math.max(0, billedToDate - paidPaise),
        credit: Math.max(0, paidPaise - billedToDate),
        paidThrough,
        oldestUnpaid,
        daysOverdue: oldestUnpaid ? Math.max(0, daysBetween(oldestUnpaid, today)) : 0,
    };
}

// ---------------------------------------------------------------------------
// Renewals
// ---------------------------------------------------------------------------

export type RenewalBucket = 'missing' | 'overdue' | 'week' | 'month' | 'later';

export function renewalBucket(nextRenewal: Day | null, today: Day): RenewalBucket {
    if (!nextRenewal) return 'missing';
    const left = daysBetween(today, nextRenewal);
    if (left < 0) return 'overdue';
    if (left <= 7) return 'week';
    if (left <= 30) return 'month';
    return 'later';
}

/** Days before a renewal on which a reminder goes out. Overdue ones remind daily. */
export const RENEWAL_REMIND_DAYS = [30, 7, 1, 0];

export const renewalRemindsToday = (daysLeft: number): boolean => daysLeft < 0 || RENEWAL_REMIND_DAYS.includes(daysLeft);

/** Overdue client dues remind on the first day late and then weekly, not daily. */
export const overdueRemindsToday = (daysOverdue: number): boolean => daysOverdue >= 1 && (daysOverdue - 1) % 7 === 0;

/** ₹1,23,456.50 — Indian digit grouping, paise only when there are some. */
export function formatRupees(paise: number): string {
    const sign = paise < 0 ? '-' : '';
    const abs = Math.abs(paise);
    const rupees = Math.floor(abs / 100);
    const p = abs % 100;
    return `${sign}₹${rupees.toLocaleString('en-IN')}${p ? `.${String(p).padStart(2, '0')}` : ''}`;
}
