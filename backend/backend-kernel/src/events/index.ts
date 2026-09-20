export { EventBus, type DomainEvent, type EventHandler } from './event-bus.js';
export { OutboxPublisher } from './outbox.publisher.js';
export { OutboxModule, type OutboxModuleOptions } from './outbox.module.js';
export {
  OUTBOX_SOURCES,
  provideOutboxSources,
  type OutboxSource,
  type OutboxSourceSpec,
  type OutboxTable,
} from './outbox.registry.js';
export {
  recordOutbox,
  type EventDescriptor,
  type OutboxWriter,
} from './outbox.recorder.js';
