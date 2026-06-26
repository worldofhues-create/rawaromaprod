/**
 * EventBus — the in-process domain-event transport.
 *
 * Today it is a synchronous fan-out over an in-memory subscriber map; at the extraction
 * stage the SAME envelope is published to a broker (NATS) instead — swapping this class
 * for a broker driver changes nothing for publishers/subscribers (doc 01 §0, §9). The
 * envelope shape is the one declared in `@core/contracts` (`eventEnvelope`), so events
 * crossing the bus are wire-compatible with what a broker would carry.
 *
 * Reliability note: producers do NOT call `publish` directly in a request path — they
 * write an outbox row in the same transaction as their domain mutation, and the
 * `OutboxPublisher` drains it onto this bus. That keeps "event emitted" atomic with
 * "data committed". `publish` here is what the publisher (and tests) call.
 */
import { Injectable, Logger } from '@nestjs/common';

/** The transport-agnostic event envelope (mirrors `@core/contracts` `eventEnvelope`). */
export interface DomainEvent<P = unknown> {
  id: string;
  type: string;
  occurredAt: string;
  actor: string | null;
  requestId: string;
  version: number;
  payload: P;
}

export type EventHandler<P = unknown> = (event: DomainEvent<P>) => void | Promise<void>;

@Injectable()
export class EventBus {
  private readonly logger = new Logger(EventBus.name);
  private readonly handlers = new Map<string, Set<EventHandler>>();
  /** Subscribers that receive EVERY event (the engagement notification sink, projections). */
  private readonly wildcards = new Set<EventHandler>();

  /**
   * Subscribe to a single event type. Returns an unsubscribe function.
   * Pass `'*'` to receive all events (notification sink / read-model projectors).
   */
  subscribe<P = unknown>(type: string, handler: EventHandler<P>): () => void {
    const h = handler as EventHandler;
    if (type === '*') {
      this.wildcards.add(h);
      return () => this.wildcards.delete(h);
    }
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(h);
    return () => set?.delete(h);
  }

  /**
   * Publish an event to all matching subscribers. Handlers are awaited; a throwing
   * handler is logged and isolated so one bad consumer can't sink the others (matches
   * at-least-once broker semantics — handlers must be idempotent).
   */
  async publish<P = unknown>(event: DomainEvent<P>): Promise<void> {
    const targets = [...(this.handlers.get(event.type) ?? []), ...this.wildcards];
    for (const handler of targets) {
      try {
        await handler(event as DomainEvent);
      } catch (err) {
        this.logger.error(
          `subscriber for "${event.type}" threw (event ${event.id}): ${String(err)}`,
        );
      }
    }
  }
}
