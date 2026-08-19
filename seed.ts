import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
    const email = 'admin@example.com';
    const password = 'password123';
    const hash = await bcrypt.hash(password, 12);

    const admin = await prisma.admin.upsert({
        where: { email },
        update: { role: 'ADMIN' },
        create: {
            email,
            password: hash,
            name: 'Super Admin',
            role: 'ADMIN',
        }
    });

    console.log('Admin user seeded:', admin.email);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
