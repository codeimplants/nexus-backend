import {
    addMonths,
    allocate,
    clientStatus,
    daysBetween,
    dueDatesUpTo,
    formatRupees,
    isDay,
    monthlyEquivalent,
    nextPlanDue,
    overdueRemindsToday,
    partnerBalances,
    renewalBucket,
    renewalRemindsToday,
    settleUp,
    todayIst,
    weightsOn,
} from './ledger-math';

const R = (rupees: number) => Math.round(rupees * 100);

describe('dates', () => {
    it('clamps month ends instead of rolling into the next month', () => {
        expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
        expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
        expect(addMonths('2026-11-17', 12)).toBe('2027-11-17');
        expect(addMonths('2026-12-01', 1)).toBe('2027-01-01');
        expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
    });

    it('takes today in IST, not UTC', () => {
        // 20:00 UTC on 17 Nov is 01:30 on 18 Nov in India.
        expect(todayIst(Date.parse('2026-11-17T20:00:00Z'))).toBe('2026-11-18');
        expect(todayIst(Date.parse('2026-11-17T10:00:00Z'))).toBe('2026-11-17');
    });

    it('validates real calendar days only', () => {
        expect(isDay('2026-02-28')).toBe(true);
        expect(isDay('2026-02-30')).toBe(false);
        expect(isDay('17-11-2026')).toBe(false);
        expect(daysBetween('2026-11-17', '2026-11-24')).toBe(7);
    });
});

describe('plans', () => {
    it('bills from the start date so the 31st does not drift to the 28th', () => {
        const plan = { startDate: '2026-01-31', cycleMonths: 1, periodsBilled: 0 };
        expect(dueDatesUpTo(plan, '2026-04-30')).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    });

    it('bills a one-time plan once', () => {
        expect(nextPlanDue({ startDate: '2026-07-14', cycleMonths: 0, periodsBilled: 0 })).toBe('2026-07-14');
        expect(nextPlanDue({ startDate: '2026-07-14', cycleMonths: 0, periodsBilled: 1 })).toBeNull();
    });

    it('stops at the end date', () => {
        const plan = { startDate: '2026-01-01', cycleMonths: 1, periodsBilled: 0, endDate: '2026-03-15' };
        expect(dueDatesUpTo(plan, '2026-12-31')).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
    });

    it('produces Barne hosting Jul 2025 to Nov 2026 as 17 monthly charges', () => {
        const dates = dueDatesUpTo({ startDate: '2025-07-01', cycleMonths: 1, periodsBilled: 0 }, '2026-11-17');
        expect(dates).toHaveLength(17);
        expect(dates[16]).toBe('2026-11-01');
        expect(nextPlanDue({ startDate: '2025-07-01', cycleMonths: 1, periodsBilled: 17 })).toBe('2026-12-01');
    });

    it('turns repeating amounts into a monthly figure', () => {
        expect(monthlyEquivalent(R(3000), 12)).toBe(R(250));
        expect(monthlyEquivalent(R(2000), 1)).toBe(R(2000));
        expect(monthlyEquivalent(R(3000), 0)).toBe(0);
    });
});

describe('allocate', () => {
    it('splits into exact thirds that add back up', () => {
        const parts = allocate(R(21212), { m: 1, s: 1, a: 1 }, ['m', 's', 'a']);
        expect(Object.values(parts).reduce((x, y) => x + y, 0)).toBe(R(21212));
        // 21,21,200 paise / 3 = 7,07,066.67: two get 7,07,067 and one 7,07,066.
        expect(Object.values(parts).sort((x, y) => x - y)).toEqual([707_066, 707_067, 707_067]);
    });

    it('gives leftover paise to the earliest partner on a tie', () => {
        expect(allocate(100, { m: 1, s: 1, a: 1 }, ['m', 's', 'a'])).toEqual({ m: 34, s: 33, a: 33 });
        expect(allocate(100, { m: 1, s: 1, a: 1 }, ['a', 's', 'm'])).toEqual({ m: 33, s: 33, a: 34 });
    });

    it('supports unequal weights and zero weights', () => {
        expect(allocate(R(1000), { m: 40, s: 30, a: 30 })).toEqual({ m: R(400), s: R(300), a: R(300) });
        expect(allocate(R(1000), { m: 1, s: 1, a: 0 })).toEqual({ m: R(500), s: R(500) });
    });

    it('refuses a split with nobody in it', () => {
        expect(() => allocate(100, { m: 0 })).toThrow();
    });
});

describe('weightsOn', () => {
    const schedules = [
        { effectiveFrom: '2025-01-01', weights: { m: 1, s: 1, a: 1 } },
        { effectiveFrom: '2027-04-01', weights: { m: 2, s: 1, a: 1 } },
    ];

    it('uses the schedule in force on the day', () => {
        expect(weightsOn('2026-11-17', schedules, [])).toEqual({ m: 1, s: 1, a: 1 });
        expect(weightsOn('2027-04-01', schedules, [])).toEqual({ m: 2, s: 1, a: 1 });
    });

    it('uses the first schedule for days before it, and equal shares with none', () => {
        expect(weightsOn('2024-06-01', schedules, [])).toEqual({ m: 1, s: 1, a: 1 });
        expect(weightsOn('2026-01-01', [], ['m', 's'])).toEqual({ m: 1, s: 1 });
    });
});

describe('partnerBalances and settleUp', () => {
    const ids = ['m', 's', 'a'];
    const thirds = [{ effectiveFrom: '2025-01-01', weights: { m: 1, s: 1, a: 1 } }];

    it('credits whoever paid a bill and debits whoever holds client money', () => {
        const balances = partnerBalances(
            ids,
            thirds,
            [{ amountPaise: R(3000), paidById: 's', day: '2026-01-01' }],
            [{ amountPaise: R(600), receivedById: 'm', day: '2026-01-02' }],
            [],
        );
        const by = Object.fromEntries(balances.map((b) => [b.partnerId, b.balance]));
        // Costs 3,000 → 1,000 each; income 600 → 200 each.
        // Swapnil paid 3,000: +3,000 - 1,000 + 200 = +2,200 (is owed).
        // Mahesh holds the 600: -600 - 1,000 + 200 = -1,400 (owes).
        expect(by.s).toBe(R(3000 - 1000 + 200));
        expect(by.m).toBe(R(-1000 - 600 + 200));
        expect(by.a).toBe(R(-1000 + 200));
        expect(by.m + by.s + by.a).toBe(0);

        const transfers = settleUp(balances);
        expect(transfers).toEqual([
            { fromId: 'm', toId: 's', amountPaise: R(1400) },
            { fromId: 'a', toId: 's', amountPaise: R(800) },
        ]);
    });

    it('a recorded settlement clears the balance it was for', () => {
        const balances = partnerBalances(
            ids,
            thirds,
            [{ amountPaise: R(3000), paidById: 's', day: '2026-01-01' }],
            [],
            [
                { fromId: 'm', toId: 's', amountPaise: R(1000) },
                { fromId: 'a', toId: 's', amountPaise: R(1000) },
            ],
        );
        expect(balances.every((b) => b.balance === 0)).toBe(true);
        expect(settleUp(balances)).toEqual([]);
    });

    it('always sums to zero, whatever the rounding', () => {
        const balances = partnerBalances(
            ids,
            thirds,
            [
                { amountPaise: R(21212), paidById: 's', day: '2026-01-01' },
                { amountPaise: R(5103), paidById: 'm', day: '2026-01-01' },
                { amountPaise: 101, paidById: 'a', day: '2026-01-01', weights: { m: 1, s: 2 } },
            ],
            [{ amountPaise: R(6000), receivedById: 'm', day: '2026-07-14' }],
            [],
        );
        expect(balances.reduce((s, b) => s + b.balance, 0)).toBe(0);
        const transfers = settleUp(balances);
        const after = Object.fromEntries(balances.map((b) => [b.partnerId, b.balance]));
        for (const t of transfers) {
            after[t.fromId] += t.amountPaise;
            after[t.toId] -= t.amountPaise;
        }
        expect(Object.values(after).every((v) => v === 0)).toBe(true);
    });

    it('keeps a deactivated partner who still has history', () => {
        const balances = partnerBalances(['m', 's'], thirds, [{ amountPaise: 300, paidById: 'a', day: '2026-01-01' }], [], []);
        expect(balances.find((b) => b.partnerId === 'a')?.balance).toBe(200);
    });
});

describe('clientStatus', () => {
    const charges = [
        { amountPaise: R(2000), dueDate: '2026-08-01' },
        { amountPaise: R(2000), dueDate: '2026-09-01' },
        { amountPaise: R(10000), dueDate: '2026-10-01' },
        { amountPaise: R(2000), dueDate: '2026-10-01' },
        { amountPaise: R(2000), dueDate: '2026-11-01' },
        { amountPaise: R(2000), dueDate: '2026-12-01' },
    ];

    it('applies payments oldest first and reports what is still due', () => {
        const s = clientStatus(charges, R(8000), '2026-11-17');
        expect(s.billedToDate).toBe(R(18000));
        expect(s.upcoming).toBe(R(2000));
        expect(s.outstanding).toBe(R(10000));
        expect(s.paidThrough).toBe('2026-09-01');
        expect(s.oldestUnpaid).toBe('2026-10-01');
        expect(s.daysOverdue).toBe(47);
    });

    it('reports credit when paid ahead', () => {
        const s = clientStatus(charges.slice(0, 2), R(6000), '2026-09-15');
        expect(s.outstanding).toBe(0);
        expect(s.credit).toBe(R(2000));
        expect(s.oldestUnpaid).toBeNull();
    });

    it('does not call a future charge overdue', () => {
        const s = clientStatus([{ amountPaise: R(2000), dueDate: '2026-12-01' }], 0, '2026-11-17');
        expect(s.outstanding).toBe(0);
        expect(s.oldestUnpaid).toBeNull();
        expect(s.upcoming).toBe(R(2000));
    });
});

describe('reminders', () => {
    it('buckets renewals by how soon they fall', () => {
        expect(renewalBucket(null, '2026-11-17')).toBe('missing');
        expect(renewalBucket('2026-11-16', '2026-11-17')).toBe('overdue');
        expect(renewalBucket('2026-11-24', '2026-11-17')).toBe('week');
        expect(renewalBucket('2026-12-17', '2026-11-17')).toBe('month');
        expect(renewalBucket('2026-12-18', '2026-11-17')).toBe('later');
    });

    it('reminds 30, 7, 1 and 0 days ahead, then daily once late', () => {
        expect([31, 30, 8, 7, 2, 1, 0, -1, -5].map(renewalRemindsToday)).toEqual([false, true, false, true, false, true, true, true, true]);
    });

    it('nags about overdue client dues weekly, not daily', () => {
        expect([0, 1, 2, 7, 8, 15].map(overdueRemindsToday)).toEqual([false, true, false, false, true, true]);
    });

    it('formats rupees the Indian way', () => {
        expect(formatRupees(R(123456.5))).toBe('₹1,23,456.50');
        expect(formatRupees(R(2000))).toBe('₹2,000');
        expect(formatRupees(-R(929))).toBe('-₹929');
    });
});
