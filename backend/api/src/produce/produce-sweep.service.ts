/**
 * ProduceSweepService (lane produce) — raises the "overdue" alert for an open ALEMBIC requirement
 * that passes its need-by date, once, from the worker every minute. The consoles' alert feed runs
 * the same sweep when polled; this one makes sure the email to the factory roles goes out even when
 * no console is open. Idempotent (dedupe key + overdue_alerted_at), so the two never double up.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ProduceQueueService } from '@ra/cluster-production';

@Injectable()
export class ProduceSweepService {
  private readonly logger = new Logger(ProduceSweepService.name);
  private running = false;

  constructor(private readonly queue: ProduceQueueService) {}

  @Interval('produce-overdue-sweep', 60_000)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const raised = await this.queue.sweepOverdue();
      if (raised) this.logger.log(`overdue production requirements alerted: ${raised}`);
    } catch (err) {
      this.logger.warn(`overdue sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
