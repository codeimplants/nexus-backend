import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

/**
 * Used by scripts/deploy.sh after a restart and by the Server tab's health check.
 * It runs a query, because a /health that skipped the database returned 200
 * throughout a total database outage and green-lit a broken deploy.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check() {
    const base = { service: 'nexus-backend', environment: process.env.NODE_ENV ?? 'local' };
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({ ...base, status: 'error', database: 'unreachable' });
    }
    return { ...base, status: 'ok', database: 'ok' };
  }
}
