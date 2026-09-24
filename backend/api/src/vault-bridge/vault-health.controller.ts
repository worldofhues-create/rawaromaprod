/**
 * VaultHealthController — `/health` for `vault-main.ts` (VaultAppModule). The main app box's
 * `HealthController` (`@core/backend-kernel`) pings the shared `PG_CLIENT` (main DB) — wrong
 * dependency to probe here, and importing it would require `DrizzleModule`, which VaultAppModule
 * deliberately never imports (see `vault-main.ts`'s header). This pings `FORMULA_PG_CLIENT`
 * instead — the ONE database connection this process actually holds.
 */
import { Controller, Get, Inject } from '@nestjs/common';
import type { Sql } from 'postgres';
import { Public } from '@core/backend-kernel';
import { FORMULA_PG_CLIENT } from '@ra/cluster-formula';

export interface VaultHealthReport {
  status: 'ok' | 'degraded';
  deps: Record<string, 'up' | 'down'>;
  at: string;
}

@Controller('health')
export class VaultHealthController {
  constructor(@Inject(FORMULA_PG_CLIENT) private readonly sql: Sql) {}

  @Public()
  @Get()
  async check(): Promise<VaultHealthReport> {
    const deps: Record<string, 'up' | 'down'> = { formulaDatabase: 'down' };
    try {
      await this.sql`SELECT 1`;
      deps.formulaDatabase = 'up';
    } catch {
      deps.formulaDatabase = 'down';
    }
    const status = Object.values(deps).every((s) => s === 'up') ? 'ok' : 'degraded';
    return { status, deps, at: new Date().toISOString() };
  }
}
