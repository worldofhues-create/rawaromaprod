/**
 * The JSON parser main.ts installs, in a module of its own (FLOOR-FIX-10) so the bridge route tests
 * mount the same bytes-in-hand parser production uses rather than a copy.
 *
 * REPLACES Nest's default JSON parser: every route keeps its normal parsed body, but the exact bytes
 * are also stashed on `req.rawBody`. Needed by BridgeController: an HMAC signature
 * (docs/bridge/EVENT_CONTRACT.md) is computed over the exact bytes sent, and a re-serialization of
 * the parsed body can produce different bytes than the sender signed. Falls back to Fastify's own
 * default JSON error shape on a parse failure, so every other route's behaviour is unchanged.
 *
 * Call AFTER `app.init()`: Nest's FastifyAdapter registers its own parser inside init, and adding
 * one before collides with it (`FST_ERR_CTP_ALREADY_PRESENT`).
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

export function installRawJsonParser(app: NestFastifyApplication): void {
  const fastifyInstance = app.getHttpAdapter().getInstance();
  fastifyInstance.removeContentTypeParser('application/json');
  fastifyInstance.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body: string | Buffer, done: (err: Error | null, body?: unknown) => void) => {
      const text = typeof body === 'string' ? body : body.toString('utf8');
      (_req as unknown as { rawBody?: string }).rawBody = text;
      try {
        done(null, text.length ? JSON.parse(text) : {});
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );
}
