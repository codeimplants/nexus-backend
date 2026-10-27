import { BadRequestException } from '@nestjs/common';

/**
 * IST calendar days for the dashboard's reports (Messages, Payments): the
 * date range a report was asked for, and the buckets its chart draws.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export interface IstRange {
    /** First day, YYYY-MM-DD. */
    from: string;
    /** Last day, YYYY-MM-DD, inclusive. */
    to: string;
    days: number;
}

/** A day `days` after (or before) another, both YYYY-MM-DD. */
export const shiftDay = (day: string, days: number): string =>
    new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Validated IST days, inclusive; the last 30 days when none are given. */
export function istRange(input: { from?: string; to?: string }, limit: { days: number; message: string }): IstRange {
    const today = new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
    const to = input.to?.trim() || today;
    const from = input.from?.trim() || shiftDay(to, -29);
    for (const [name, value] of [['from', from], ['to', to]] as const) {
        const parsed = Date.parse(`${value}T00:00:00Z`);
        if (!DAY.test(value) || Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
            throw new BadRequestException(`${name} must be a date as YYYY-MM-DD`);
        }
    }
    const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
    if (days < 1) throw new BadRequestException('from must not be after to');
    if (days > limit.days) throw new BadRequestException(limit.message);
    return { from, to, days };
}

/** Every bucket in the range, so days with nothing still appear as zero. A month is labelled by its first day. */
export function istBuckets(range: { from: string; to: string }, granularity: 'day' | 'month'): string[] {
    const out: string[] = [];
    const end = Date.parse(`${range.to}T00:00:00Z`);
    if (granularity === 'day') {
        for (let t = Date.parse(`${range.from}T00:00:00Z`); t <= end; t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
        return out;
    }
    const d = new Date(`${range.from.slice(0, 7)}-01T00:00:00Z`);
    while (d.getTime() <= end) {
        out.push(d.toISOString().slice(0, 10));
        d.setUTCMonth(d.getUTCMonth() + 1);
    }
    return out;
}
