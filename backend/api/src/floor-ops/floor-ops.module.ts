/**
 * FloorOpsModule (lane pf-c, production floor plan P3 + P4): devices and pairing, print jobs and the
 * print agent's pull API, scales, maceration, the packing and logistics stations, courier
 * connectors, and the TV display feed. FloorWorkerModule runs the sweeps (offline devices,
 * maceration alarms, courier sync) where the ScheduleModule runs: the worker.
 */
import { Module } from '@nestjs/common';
import { DeviceAgentController, DevicesController } from './devices.controller.js';
import { DevicesService } from './devices.service.js';
import { PrintAgentController, PrintController } from './print.controller.js';
import { PrintService } from './print.service.js';
import { ScaleController } from './scale.controller.js';
import { ScaleService } from './scale.service.js';
import { MacerationController } from './maceration.controller.js';
import { MacerationService } from './maceration.service.js';
import { FloorSweepService } from './floor-sweep.service.js';
import { PackingController } from './packing.controller.js';
import { PackingService } from './packing.service.js';
import { CourierController, LogisticsController } from './logistics.controller.js';
import { LogisticsService } from './logistics.service.js';
import { CourierService } from './courier.service.js';
import { DisplayService } from './display.service.js';

const SERVICES = [DevicesService, PrintService, ScaleService, MacerationService, PackingService, CourierService, LogisticsService, DisplayService];

@Module({
  controllers: [DevicesController, DeviceAgentController, PrintController, PrintAgentController, ScaleController, MacerationController, PackingController, LogisticsController, CourierController],
  providers: [...SERVICES],
  exports: [...SERVICES],
})
export class FloorOpsModule {}

/** Worker: the floor sweeps (offline devices, stale print jobs, maceration alarms, courier sync). */
@Module({ providers: [DevicesService, PrintService, MacerationService, CourierService, FloorSweepService] })
export class FloorOpsWorkerModule {}
