import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { CreateHardeningItemDto, UpdateHardeningItemDto } from './dto/hardening.dto';

/** Lower sorts first, so CRITICAL items head the list within a sortOrder tie. */
const SEVERITY_RANK: Record<string, number> = {
    CRITICAL: 0,
    HIGH: 1,
    MEDIUM: 2,
    LOW: 3,
};

export interface HardeningSummary {
    total: number;
    open: number;
    inProgress: number;
    blocked: number;
    done: number;
    /** Open or in-progress items at CRITICAL. The number that should be zero. */
    criticalOutstanding: number;
}

@Injectable()
export class HardeningService {
    constructor(private prisma: PrismaService) { }

    /**
     * Every item, ordered the way the register should be read: by sortOrder, then
     * severity, then title.
     *
     * Sorted in Node rather than SQL because severity is a string column, so
     * `ORDER BY severity` would give alphabetical (CRITICAL, HIGH, LOW, MEDIUM)
     * and put LOW above MEDIUM. The table is a couple of dozen rows and is read
     * by a handful of admins, so the cost is irrelevant and the correctness is
     * not. If this ever grows into thousands of rows, add an integer rank column
     * rather than reaching for a raw query.
     */
    async list() {
        const rows = await this.prisma.hardeningItem.findMany();
        return rows.sort(
            (a, b) =>
                a.sortOrder - b.sortOrder ||
                (SEVERITY_RANK[a.severity] ?? 99) - (SEVERITY_RANK[b.severity] ?? 99) ||
                a.title.localeCompare(b.title),
        );
    }

    /** Counts for the header chips. Computed from one read, not five. */
    async summary(): Promise<HardeningSummary> {
        const rows = await this.prisma.hardeningItem.findMany({
            select: { status: true, severity: true },
        });
        const count = (status: string) => rows.filter((r) => r.status === status).length;
        return {
            total: rows.length,
            open: count('OPEN'),
            inProgress: count('IN_PROGRESS'),
            blocked: count('BLOCKED'),
            done: count('DONE'),
            criticalOutstanding: rows.filter(
                (r) => r.severity === 'CRITICAL' && r.status !== 'DONE',
            ).length,
        };
    }

    async create(dto: CreateHardeningItemDto) {
        const existing = await this.prisma.hardeningItem.findUnique({
            where: { key: dto.key },
        });
        if (existing) {
            throw new ConflictException(`A hardening item with key "${dto.key}" already exists`);
        }
        return this.prisma.hardeningItem.create({ data: dto });
    }

    /**
     * Update an item, deriving the completion fields from the status transition.
     *
     * `completedAt` / `completedBy` are set here and never accepted from the
     * client, so "done" always carries a real timestamp and a real name. Moving an
     * item back out of DONE clears both, because a half-cleared row reads as
     * finished in every list that only looks at one of the two.
     *
     * `actor` is the signed-in admin's name or email, used only for completedBy.
     */
    async update(itemId: string, dto: UpdateHardeningItemDto, actor?: string) {
        const existing = await this.prisma.hardeningItem.findUnique({ where: { id: itemId } });
        if (!existing) throw new NotFoundException('Hardening item not found');

        const data: Record<string, unknown> = { ...dto };

        // An empty owner string means "unclaim", which Prisma needs as null.
        if (dto.owner !== undefined) data.owner = dto.owner.trim() || null;

        if (dto.status && dto.status !== existing.status) {
            if (dto.status === 'DONE') {
                data.completedAt = new Date();
                data.completedBy = actor ?? null;
            } else if (existing.status === 'DONE') {
                data.completedAt = null;
                data.completedBy = null;
            }
        }

        return this.prisma.hardeningItem.update({ where: { id: itemId }, data });
    }

    async remove(itemId: string) {
        const existing = await this.prisma.hardeningItem.findUnique({ where: { id: itemId } });
        if (!existing) throw new NotFoundException('Hardening item not found');
        await this.prisma.hardeningItem.delete({ where: { id: itemId } });
        return { deleted: true, key: existing.key };
    }
}
