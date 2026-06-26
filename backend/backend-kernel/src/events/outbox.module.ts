/**
 * OutboxModule — wires the EventBus (always) and, when `withPublisher: true`, the
 * scheduled OutboxPublisher (worker process only).
 *
 * The api process imports `OutboxModule.forRoot()` to get the bus (so request handlers
 * can subscribe / the FlagsService can react). The worker process imports
 * `OutboxModule.forRoot({ withPublisher: true, sourcesProvider })` where `sourcesProvider`
 * is a factory (see `provideOutboxSources`) that injects the per-schema db clients +
 * pairs them with their outbox tables. The provider is registered IN this module so the
 * publisher (also here) can inject `OUTBOX_SOURCES`. Keeping the publisher worker-only
 * matches the deployment split (api = HTTP, worker = jobs/events).
 */
import { type DynamicModule, Global, Module, type Provider } from '@nestjs/common';
import { EventBus } from './event-bus.js';
import { OutboxPublisher } from './outbox.publisher.js';

export interface OutboxModuleOptions {
  /** Run the scheduled publisher (worker). Omit/false in the api process. */
  withPublisher?: boolean;
  /**
   * The provider that supplies `OUTBOX_SOURCES` (the outboxes to drain). Required when
   * `withPublisher` is true — build it with `provideOutboxSources(...)`.
   */
  sourcesProvider?: Provider;
}

@Global()
@Module({})
export class OutboxModule {
  static forRoot(options: OutboxModuleOptions = {}): DynamicModule {
    const providers: Provider[] = [EventBus];
    const exportsList: NonNullable<DynamicModule['exports']> = [EventBus];

    if (options.withPublisher) {
      if (options.sourcesProvider) providers.push(options.sourcesProvider);
      providers.push(OutboxPublisher);
      exportsList.push(OutboxPublisher);
    }

    return {
      module: OutboxModule,
      providers,
      exports: exportsList,
    };
  }
}
