/**
 * `@NoStoredReply()` — this route's answer must never be kept (IMPORT-RP, the formula rule).
 *
 * The idempotency interceptors store a write's answer so that a request the console's channel sends
 * again is answered from the first attempt instead of running twice. For almost every route that is
 * ids and counts. For a route whose ANSWER carries a recipe's lines (the Vault's recipe preview, the
 * rows-to-fix sheet of a formula upload) it would put a trade secret, in plain text, in a table that
 * exists to be forgotten about. A route marked with this keeps the in-flight claim (two copies of one
 * request still cannot run at once) and stores nothing: a later re-send runs again, so the route
 * itself must be safe to repeat.
 */
import { SetMetadata } from '@nestjs/common';
import { META_NO_STORED_REPLY } from './metadata.keys.js';

export const NoStoredReply = (): MethodDecorator => SetMetadata(META_NO_STORED_REPLY, true);
