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

const SERVICES = [DevicesService, PrintService];

@Module({
  controllers: [DevicesController, DeviceAgentController, PrintController, PrintAgentController],
  providers: [...SERVICES],
  exports: [...SERVICES],
})
export class FloorOpsModule {}
