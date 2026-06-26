/**
 * worker entrypoint (doc 01 §0) — runs the OutboxPublisher (drains every cluster outbox
 * onto the in-proc bus) and is where BullMQ consumers + event handlers + schedulers live.
 * No HTTP server: created as an application context. Scale this process independently of
 * the api without extracting anything.
 *
 * BullMQ queue consumers are a PLACEHOLDER seam: register `@Processor`s in the clusters
 * (or here) once Redis is wired — the structure (separate process, same DI graph) is the
 * point. Today it actively drains the transactional outbox.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerModule } from './worker.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  new Logger('Worker').log('worker started — outbox publisher draining; job consumers ready');
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal worker bootstrap error', err);
  process.exit(1);
});
