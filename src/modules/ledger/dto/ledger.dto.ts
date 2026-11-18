import {
    IsBoolean,
    IsIn,
    IsInt,
    IsNotEmpty,
    IsObject,
    IsOptional,
    IsString,
    Max,
    MaxLength,
    Min,
    ValidateBy,
    ValidationOptions,
} from 'class-validator';
import { isDay } from '../ledger-math';

/**
 * Allowed values, kept here so the API, the import script and the page agree on
 * one list. Plain strings in the database (like Admin.role), so adding one is a
 * change here and in the page's constants, never a migration.
 */
export const LEDGER_MODES = ['UPI', 'CASH', 'CARD', 'BANK', 'OTHER'] as const;
export const LEDGER_CATEGORIES = [
    'HOSTING',
    'SOFTWARE',
    'DOMAIN',
    'APP_STORE',
    'EQUIPMENT',
    'PROFESSIONAL',
    'GOVERNMENT',
    'OTHER',
] as const;

/** ₹1 crore. Far above anything we bill, low enough to catch a rupees/paise mix-up typed as paise x 100. */
const MAX_PAISE = 10_000_000_00;
/** Ten years. A longer cycle is a typo. */
const MAX_CYCLE_MONTHS = 120;

const modeMessage = `mode must be one of: ${LEDGER_MODES.join(', ')}`;
const categoryMessage = `category must be one of: ${LEDGER_CATEGORIES.join(', ')}`;

/** A real calendar day as YYYY-MM-DD (rejects 2026-02-30, which a regex alone accepts). */
function IsDay(options?: ValidationOptions) {
    return ValidateBy(
        { name: 'isDay', validator: { validate: (v) => isDay(v), defaultMessage: (a) => `${a?.property} must be a date as YYYY-MM-DD` } },
        options,
    );
}

function IsPaise(options?: ValidationOptions) {
    return ValidateBy(
        {
            name: 'isPaise',
            validator: {
                validate: (v) => Number.isInteger(v) && v >= 1 && v <= MAX_PAISE,
                defaultMessage: (a) => `${a?.property} must be a whole number of paise between 1 and ${MAX_PAISE}`,
            },
        },
        options,
    );
}

// ---------------------------------------------------------------------------
// Partners and shares
// ---------------------------------------------------------------------------

export class CreatePartnerDto {
    @IsString() @IsNotEmpty() @MaxLength(80)
    name: string;

    @IsOptional() @IsString()
    adminId?: string | null;

    @IsOptional() @IsInt() @Min(0) @Max(10_000)
    sortOrder?: number;
}

export class UpdatePartnerDto {
    @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80)
    name?: string;

    /** null (or '') unlinks the Nexus account. */
    @IsOptional() @IsString()
    adminId?: string | null;

    @IsOptional() @IsBoolean()
    isActive?: boolean;

    @IsOptional() @IsInt() @Min(0) @Max(10_000)
    sortOrder?: number;
}

export class CreateShareScheduleDto {
    @IsDay()
    effectiveFrom: string;

    /** { "<partnerId>": weight }, whole numbers; checked against real partners in the service. */
    @IsObject()
    weights: Record<string, number>;

    @IsOptional() @IsString() @MaxLength(500)
    note?: string;
}

// ---------------------------------------------------------------------------
// Clients, plans, charges, receipts
// ---------------------------------------------------------------------------

export class CreateClientDto {
    @IsString() @IsNotEmpty() @MaxLength(120)
    name: string;

    @IsOptional() @IsString() @MaxLength(120)
    contactName?: string;

    @IsOptional() @IsString() @MaxLength(40)
    phone?: string;

    @IsOptional() @IsString() @MaxLength(200)
    email?: string;

    @IsOptional() @IsString() @MaxLength(2000)
    notes?: string;
}

export class UpdateClientDto {
    @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120)
    name?: string;

    @IsOptional() @IsString() @MaxLength(120)
    contactName?: string | null;

    @IsOptional() @IsString() @MaxLength(40)
    phone?: string | null;

    @IsOptional() @IsString() @MaxLength(200)
    email?: string | null;

    @IsOptional() @IsString() @MaxLength(2000)
    notes?: string | null;

    @IsOptional() @IsBoolean()
    isActive?: boolean;
}

export class CreatePlanDto {
    @IsString() @IsNotEmpty()
    clientId: string;

    @IsString() @IsNotEmpty() @MaxLength(120)
    product: string;

    @IsPaise()
    amountPaise: number;

    /** 0 = one-time, 1 = monthly, 12 = yearly. */
    @IsInt() @Min(0) @Max(MAX_CYCLE_MONTHS)
    cycleMonths: number;

    /** The first due date. */
    @IsDay()
    startDate: string;

    @IsOptional() @IsDay()
    endDate?: string;

    @IsOptional() @IsString() @MaxLength(2000)
    notes?: string;
}

/**
 * Start date and cycle are fixed once a plan exists: changing them would move
 * due dates that have already been billed. To change the terms, end the plan
 * and add a new one. A new amount applies to charges not yet produced.
 */
export class UpdatePlanDto {
    @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120)
    product?: string;

    @IsOptional() @IsPaise()
    amountPaise?: number;

    /** null removes the end date. */
    @IsOptional() @IsDay()
    endDate?: string | null;

    @IsOptional() @IsBoolean()
    isActive?: boolean;

    @IsOptional() @IsString() @MaxLength(2000)
    notes?: string | null;
}

export class CreateChargeDto {
    @IsString() @IsNotEmpty()
    clientId: string;

    @IsString() @IsNotEmpty() @MaxLength(200)
    description: string;

    @IsPaise()
    amountPaise: number;

    @IsDay()
    dueDate: string;

    @IsOptional() @IsString() @MaxLength(2000)
    note?: string;
}

export class CreateReceiptDto {
    @IsString() @IsNotEmpty()
    clientId: string;

    @IsPaise()
    amountPaise: number;

    @IsDay()
    receivedOn: string;

    @IsIn(LEDGER_MODES as unknown as string[], { message: modeMessage })
    mode: string;

    /** The partner now holding the money. */
    @IsString() @IsNotEmpty()
    receivedById: string;

    @IsOptional() @IsString() @MaxLength(120)
    reference?: string;

    @IsOptional() @IsString() @MaxLength(2000)
    note?: string;

    /** Overrides the share schedule for this receipt only. */
    @IsOptional() @IsObject()
    weights?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Recurring costs (subscriptions, CA fees, government filings)
// ---------------------------------------------------------------------------

export class CreateSubscriptionDto {
    @IsString() @IsNotEmpty() @MaxLength(120)
    name: string;

    @IsIn(LEDGER_CATEGORIES as unknown as string[], { message: categoryMessage })
    category: string;

    @IsOptional() @IsString() @MaxLength(120)
    vendor?: string;

    /** Leave out when not known yet. */
    @IsOptional() @IsPaise()
    amountPaise?: number;

    @IsOptional() @IsBoolean()
    isEstimate?: boolean;

    @IsInt() @Min(1) @Max(MAX_CYCLE_MONTHS)
    cycleMonths: number;

    @IsOptional() @IsDay()
    nextRenewal?: string;

    @IsOptional() @IsBoolean()
    autoRenew?: boolean;

    /** A label such as "Swapnil HDFC card". Never a card number. */
    @IsOptional() @IsString() @MaxLength(120)
    paymentMethod?: string;

    @IsOptional() @IsString()
    defaultPayerId?: string;

    @IsOptional() @IsString()
    clientId?: string;

    @IsOptional() @IsPaise()
    rebillPaise?: number;

    @IsOptional() @IsString() @MaxLength(2000)
    notes?: string;
}

/** Every optional field here accepts null to clear it. */
export class UpdateSubscriptionDto {
    @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120)
    name?: string;

    @IsOptional() @IsIn(LEDGER_CATEGORIES as unknown as string[], { message: categoryMessage })
    category?: string;

    @IsOptional() @IsString() @MaxLength(120)
    vendor?: string | null;

    @IsOptional() @IsPaise()
    amountPaise?: number | null;

    @IsOptional() @IsBoolean()
    isEstimate?: boolean;

    @IsOptional() @IsInt() @Min(1) @Max(MAX_CYCLE_MONTHS)
    cycleMonths?: number;

    @IsOptional() @IsDay()
    nextRenewal?: string | null;

    @IsOptional() @IsBoolean()
    autoRenew?: boolean;

    @IsOptional() @IsString() @MaxLength(120)
    paymentMethod?: string | null;

    @IsOptional() @IsString()
    defaultPayerId?: string | null;

    @IsOptional() @IsString()
    clientId?: string | null;

    @IsOptional() @IsPaise()
    rebillPaise?: number | null;

    @IsOptional() @IsBoolean()
    isActive?: boolean;

    @IsOptional() @IsString() @MaxLength(2000)
    notes?: string | null;
}

/**
 * "Mark renewed": records what was paid, moves the renewal date on one cycle
 * (or to `nextRenewal` if given), and bills the linked client if there is one.
 */
export class RenewSubscriptionDto {
    @IsDay()
    paidOn: string;

    @IsString() @IsNotEmpty()
    paidById: string;

    @IsIn(LEDGER_MODES as unknown as string[], { message: modeMessage })
    mode: string;

    /** What was actually paid; defaults to the subscription's amount. */
    @IsOptional() @IsPaise()
    amountPaise?: number;

    /** Overrides the computed next renewal date. */
    @IsOptional() @IsDay()
    nextRenewal?: string;

    /** Bill the linked client for this renewal. Defaults to true when a client is linked. */
    @IsOptional() @IsBoolean()
    billClient?: boolean;

    /** What to bill the client; defaults to the subscription's rebill amount. */
    @IsOptional() @IsPaise()
    rebillPaise?: number;

    @IsOptional() @IsString() @MaxLength(2000)
    note?: string;
}

// ---------------------------------------------------------------------------
// Expenses and settlements
// ---------------------------------------------------------------------------

export class CreateExpenseDto {
    @IsString() @IsNotEmpty() @MaxLength(200)
    description: string;

    @IsIn(LEDGER_CATEGORIES as unknown as string[], { message: categoryMessage })
    category: string;

    @IsOptional() @IsString() @MaxLength(120)
    vendor?: string;

    @IsPaise()
    amountPaise: number;

    @IsDay()
    paidOn: string;

    @IsString() @IsNotEmpty()
    paidById: string;

    @IsIn(LEDGER_MODES as unknown as string[], { message: modeMessage })
    mode: string;

    @IsOptional() @IsString()
    subscriptionId?: string;

    /** Who it was bought for. On its own this bills nobody; see rebillPaise. */
    @IsOptional() @IsString()
    clientId?: string;

    /** Bill the client this much for it (hardware we sell them, a fee we pass on). Needs clientId. */
    @IsOptional() @IsPaise()
    rebillPaise?: number;

    /** When the client's charge is due; defaults to paidOn. */
    @IsOptional() @IsDay()
    rebillDueDate?: string;

    /** Overrides the share schedule for this expense only. */
    @IsOptional() @IsObject()
    weights?: Record<string, number>;

    @IsOptional() @IsString() @MaxLength(2000)
    note?: string;
}

export class CreateSettlementDto {
    @IsString() @IsNotEmpty()
    fromId: string;

    @IsString() @IsNotEmpty()
    toId: string;

    @IsPaise()
    amountPaise: number;

    @IsDay()
    paidOn: string;

    @IsIn(LEDGER_MODES as unknown as string[], { message: modeMessage })
    mode: string;

    @IsOptional() @IsString() @MaxLength(2000)
    note?: string;
}
