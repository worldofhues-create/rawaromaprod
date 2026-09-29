/** ProduceSweepModule (lane produce) — the worker's overdue-requirement sweep. Worker only. */
import { Module } from '@nestjs/common';
import { ProduceSweepService } from './produce-sweep.service.js';

@Module({ providers: [ProduceSweepService] })
export class ProduceSweepModule {}
