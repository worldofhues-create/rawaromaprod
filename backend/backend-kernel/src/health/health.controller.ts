/**
 * HealthController — liveness + dependency probe at `/health` (doc 06 §11). Public
 * (no auth), cheap: pings the DB with `SELECT 1`. Returns `ok` overall + a per-dependency
 * segment so the Admin Console / Uptime-Kuma can render a status board.
 */
import { Controller, Get, Inject } from '@nestjs/common';
import type { Sql } from 'postgres';
import { Public } from '../decorators/public.decorator.js';
import { PG_CLIENT } from '../db/drizzle.tokens.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  @Public()
  @Get()
  async check(): Promise<HealthReport> {
    const deps: Record<string, 'up' | 'down'> = { database: 'down' };
    try {
      await this.sql`SELECT 1`;
      deps.database = 'up';
    } catch {
      deps.database = 'down';
    }
    const status = Object.values(deps).every((s) => s === 'up') ? 'ok' : 'degraded';
    return { status, deps, at: new Date().toISOString() };
  }
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  deps: Record<string, 'up' | 'down'>;
  at: string;
}
