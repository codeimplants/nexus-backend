import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { LedgerService } from './ledger.service';

/**
 * Lets in the super admin and any account linked to an active partner, and
 * nobody else. Runs after JwtGuard, which has already re-read the account and
 * (for writes) required a writer role and a fresh authenticator code.
 *
 * Not a role check on purpose: ADMIN is about running the apps, and an admin
 * who is not a partner has no business seeing who holds whose money.
 * Attaches `req.ledgerPartner` so writes can say who made them.
 */
@Injectable()
export class LedgerAccessGuard implements CanActivate {
    constructor(private ledger: LedgerService) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest<{
            user?: { id: string; role: string };
            ledgerPartner?: { id: string; name: string } | null;
        }>();
        const user = req.user;
        if (!user) return false;
        const { allowed, partner } = await this.ledger.access(user.id, user.role);
        if (!allowed) {
            throw new ForbiddenException({ code: 'LEDGER_NOT_PARTNER', message: 'The Ledger is open to the partners only. Ask the super admin to link your account to a partner.' });
        }
        req.ledgerPartner = partner;
        return true;
    }
}
