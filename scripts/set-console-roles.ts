/**
 * One-off: set who can sign in to the Nexus console and with what role.
 * Runs against whatever DATABASE_URL is active in .env (dev/preprod/prod).
 *
 *   npx ts-node scripts/set-console-roles.ts           # dry run, prints the plan
 *   npx ts-node scripts/set-console-roles.ts --apply   # writes
 *
 * SUPER_ADMIN and ADMIN can make changes, each with their own authenticator
 * code (see JwtGuard). So every other existing ADMIN is demoted to read-only
 * here, rather than silently gaining write access. SUPER_ADMIN is set only
 * by this script, never through the API.
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';

const SUPER_ADMIN_PHONE = '9850929698';
const NEW_ADMIN = { phone: '7030600197', name: 'Swapnil Vedpathak', role: 'ADMIN' };
/** Aniket is matched by name; every other COLLABORATOR/LEAD_GEN stays as is. */
const READ_ONLY_USER_NAME = 'aniket';
const READ_ONLY_ROLE = 'COLLABORATOR';

const apply = process.argv.includes('--apply');
const prisma = new PrismaClient();
const mask = (p?: string | null) => (p ? `******${p.slice(-4)}` : '-');

async function main() {
    const all = await prisma.admin.findMany({ select: { id: true, name: true, email: true, phone: true, role: true } });
    console.table(all.map((a) => ({ ...a, phone: mask(a.phone) })));

    const me = all.find((a) => a.phone === SUPER_ADMIN_PHONE);
    if (!me) throw new Error(`No admin has phone ${mask(SUPER_ADMIN_PHONE)}; add the phone to your row first.`);

    const anikets = all.filter((a) => (a.name ?? a.email).toLowerCase().includes(READ_ONLY_USER_NAME));
    if (anikets.length !== 1) throw new Error(`Expected exactly one Aniket, found ${anikets.length}`);

    const swapnil = all.find((a) => a.phone === NEW_ADMIN.phone);
    const others = all.filter(
        (a) => a.id !== me.id && a.id !== swapnil?.id && a.id !== anikets[0].id
            && (a.role === 'SUPER_ADMIN' || a.role === 'ADMIN'),
    );

    console.log(`\nPlan${apply ? '' : ' (dry run, pass --apply to write)'}:`);
    console.log(`  ${me.name ?? me.email}: ${me.role} -> SUPER_ADMIN`);
    others.forEach((o) => console.log(`  ${o.name ?? o.email}: ${o.role} -> ${READ_ONLY_ROLE} (read-only)`));
    console.log(`  ${anikets[0].name ?? anikets[0].email}: ${anikets[0].role} -> ${READ_ONLY_ROLE}`);
    console.log(`  ${NEW_ADMIN.name}: ${swapnil ? `${swapnil.role} -> ` : 'create as '}${NEW_ADMIN.role}`);
    if (!apply) return;

    await prisma.$transaction(async (tx) => {
        await tx.admin.update({ where: { id: me.id }, data: { role: 'SUPER_ADMIN', isActive: true } });
        for (const o of others) await tx.admin.update({ where: { id: o.id }, data: { role: READ_ONLY_ROLE } });
        await tx.admin.update({ where: { id: anikets[0].id }, data: { role: READ_ONLY_ROLE } });
        if (swapnil) {
            await tx.admin.update({ where: { id: swapnil.id }, data: { name: NEW_ADMIN.name, role: NEW_ADMIN.role, isActive: true } });
        } else {
            await tx.admin.create({
                data: {
                    phone: NEW_ADMIN.phone,
                    name: NEW_ADMIN.name,
                    role: NEW_ADMIN.role,
                    email: `${NEW_ADMIN.phone}@phone.nexus.local`,
                    password: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12),
                },
            });
        }
    });
    console.log('Done.');
}

main().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
