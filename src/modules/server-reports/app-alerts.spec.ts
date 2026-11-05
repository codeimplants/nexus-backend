import { AppAlerts } from './app-alerts';

/** Fake report services: tests set the day totals each check returns. */
function setup() {
    const pay = { slug: 'sonebill', name: 'Sone Bill', payments: 0, failed: 0 };
    const otp = { slug: 'sonebill', name: 'Sone Bill', sent: 0, failed: 0, blocked: 0 };
    const state = { payDown: false };
    const payments = { summary: jest.fn(async () => { if (state.payDown) throw new Error('Payments is not reachable right now'); return { apps: [{ ...pay }] }; }) };
    const messaging = { otpSummary: jest.fn(async () => ({ apps: [{ ...otp }] })) };
    const alerts = new AppAlerts(payments as never, messaging as never);
    return { alerts, pay, otp, state };
}

describe('AppAlerts', () => {
    let now: number;
    beforeEach(() => {
        now = Date.parse('2026-11-05T06:00:00Z'); // 11:30 IST
        jest.spyOn(Date, 'now').mockImplementation(() => now);
    });
    afterEach(() => jest.restoreAllMocks());
    const later = (min: number) => { now += min * 60_000; };

    it('says nothing until an hour of history exists', async () => {
        const { alerts, otp } = setup();
        otp.failed = 100;
        expect(await alerts.flags()).toEqual([]);
    });

    it('flags only what happened in the last hour, not the whole day', async () => {
        const { alerts, otp } = setup();
        otp.sent = 500; otp.failed = 200; // a bad morning, already over
        await alerts.flags();
        later(61);
        otp.sent = 560; otp.failed = 202;
        expect(await alerts.flags()).toEqual([]);
    });

    it('raises a critical when every OTP failed in the last hour', async () => {
        const { alerts, otp } = setup();
        otp.sent = 100; otp.failed = 2;
        await alerts.flags();
        later(61);
        otp.failed = 12;
        const flags = await alerts.flags();
        expect(flags).toHaveLength(1);
        expect(flags[0]).toMatchObject({ level: 'critical', label: 'Sone Bill' });
    });

    it('warns on many failed payments and on blocked OTP floods', async () => {
        const { alerts, pay, otp } = setup();
        await alerts.flags();
        later(61);
        pay.payments = 4; pay.failed = 6;
        otp.sent = 10; otp.blocked = 80;
        const flags = await alerts.flags();
        expect(flags.map((f) => f.level)).toEqual(['warning', 'warning']);
        expect(flags[0].title).toContain('6 of 10 payments');
        expect(flags[1].title).toContain('80 OTP requests were blocked');
    });

    it('flags an unreachable service straight away', async () => {
        const { alerts, state } = setup();
        state.payDown = true;
        const flags = await alerts.flags();
        expect(flags).toEqual([expect.objectContaining({ level: 'warning', label: 'Payments' })]);
    });
});
