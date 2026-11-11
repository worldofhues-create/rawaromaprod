/**
 * FloorSweepService (lane pf-c) — the floor's timers, on the worker: offline devices (and the
 * printer-offline alert), print jobs the agent never answered, maceration alarms, and courier
 * tracking sync. Re-entrancy guarded; one failing sweep never stops the others.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DevicesService } from './devices.service.js';
import { MacerationService } from './maceration.service.js';
import { PrintService } from './print.service.js';
import { CourierService } from './courier.service.js';
import { TemperatureService } from './temperature.service.js';

@Injectable()
export class FloorSweepService {
  private readonly log = new Logger('FloorSweep');
  private running = false;
  constructor(
    private readonly devices: DevicesService,
    private readonly print: PrintService,
    private readonly maceration: MacerationService,
    private readonly couriers: CourierService,
    private readonly temps: TemperatureService,
  ) {}

  private devicesRunning = false;

  /** FLOOR-FIX-6: its own 15 s sweep, so the 60 s offline window reads as ~60 s, not up to 2 min. */
  @Interval('device-sweep', 15_000)
  async deviceTick() {
    if (this.devicesRunning) return;
    this.devicesRunning = true;
    try { await this.devices.sweepOffline(); } catch (e) { this.log.warn(`devices sweep failed: ${(e as Error).message}`); } finally { this.devicesRunning = false; }
  }

  @Interval('floor-sweep', 60_000)
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      for (const [name, fn] of [
        ['print', () => this.print.sweepStale()],
        ['maceration', () => this.maceration.sweepAlarms()],
        ['couriers', () => this.couriers.syncAll()],
        // FLOOR-TEMP-1: a zone not logged within its interval raises TEMP_LOG_OVERDUE.
        ['temperature', () => this.temps.sweepOverdue()],
      ] as const) {
        try { await fn(); } catch (e) { this.log.warn(`${name} sweep failed: ${(e as Error).message}`); }
      }
    } finally {
      this.running = false;
    }
  }
}
