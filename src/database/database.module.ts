import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * The one PrismaService for the whole app. Global, so feature modules inject it without listing it.
 *
 * Listing PrismaService in each module's `providers` (as 17 modules did) makes Nest build one instance
 * per module, and every instance is its own PrismaClient with its own connection pool. Prod held 31
 * Postgres connections from a single process that way, and the shared server (max_connections 100)
 * ran out. Never add PrismaService to a module's providers again; size the pool with
 * `?connection_limit=` on DATABASE_URL instead.
 */
@Global()
@Module({
    providers: [PrismaService],
    exports: [PrismaService],
})
export class DatabaseModule { }
