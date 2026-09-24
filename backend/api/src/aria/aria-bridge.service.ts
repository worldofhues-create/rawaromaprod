/**
 * AriaBridgeService (UX-H) — Aria in Factory, Platform and Vault, answered by ALEMBIC.
 *
 * A RawProd console holds a RawProd session only, and its CSP is `connect-src 'self'`, so
 * its Aria panel asks THIS server (`POST /v1/aria/ask`, through the same encrypted /rpc
 * tunnel as every other call). This service forwards the question to ALEMBIC's
 * `POST /api/v1/internal/rawprod/copilot/ask`, server to server, over the channel the two
 * systems already trust — NOT a new one:
 *
 *   - the credential is `bridge.connector_config`'s sealed HMAC secret (the admin-entered
 *     value `BRIDGE_HMAC_KEK` opens), the same secret that signs every bridge event and every
 *     Facts API query;
 *   - the signed material is the Facts API's exact shape, `${timestamp}.${nonce}.${rawBody}`
 *     with `x-bridge-timestamp` / `x-bridge-nonce` / `x-bridge-signature` — ALEMBIC checks
 *     the 300 s window and spends the nonce single-use, exactly as `FactsService` does here
 *     for the opposite direction;
 *   - ALEMBIC's address is the ORIGIN of the admin-configured `webhookUrl` (ALEMBIC's own
 *     bridge callback), so there is no second URL to provision and nothing in `.env`.
 *
 * WHO IS ASKING is `iam.user_master.alembic_subject` — the immutable ALEMBIC `staff_user.id`
 * bound at this user's first sign-in via ALEMBIC — read from the row for the signed-in
 * principal, never from the request. ALEMBIC then resolves that subject against its OWN
 * staff rows (state, roles, tenant) and answers as that person, through the same code path
 * and permissions as its own `/api/v1/copilot/ask`. A RawProd user with no binding (never
 * signed in via ALEMBIC) gets the honest "not linked" state, never an answer as somebody.
 *
 * WHAT IS SENT: the question, the conversation id (for a saved thread), the console and —
 * outside the Vault — the NAME of the view. No page data, no row, no formula. The Vault
 * console's view name is dropped here (and again on ALEMBIC's side): which Vault screen a
 * person is on is Vault context and never leaves.
 *
 * FAILS HONEST, NEVER OPEN: an unconfigured connector, a missing tenant id, an unlinked user
 * or an unreachable ALEMBIC each come back as a plain `unavailable` state the panel shows as
 * such; nothing is answered locally.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Sql } from 'postgres';
import { ConfigService, PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import { BRIDGE_DB, bridgeSchema, type BridgeDb } from '../bridge/bridge.tokens.js';
import { openSecret } from '../bridge/secret-box.js';
import { signBody } from '../bridge/signing.js';

const { connectorConfig } = bridgeSchema;

/** ALEMBIC's receiving route, on the origin of the configured bridge webhook. */
export const ALEMBIC_ARIA_PATH = '/api/v1/internal/rawprod/copilot/ask';
export const ARIA_CONSOLES = ['factory', 'platform', 'vault'] as const;
export type AriaConsole = (typeof ARIA_CONSOLES)[number];

/** Injection token for the HTTP client — tests hand in a fake ALEMBIC. */
export const ARIA_BRIDGE_FETCH = Symbol('ARIA_BRIDGE_FETCH');

const VIEW_RE = /^[a-zA-Z0-9 _.:/-]{1,80}$/;
const TIMEOUT_MS = 12_000;

export interface AriaAskInput {
  readonly question: string;
  readonly console: AriaConsole;
  readonly view?: string | undefined;
  readonly conversationId?: string | undefined;
  readonly persist?: boolean | undefined;
}

export interface AriaCitedFact {
  readonly id?: string;
  readonly label: string;
  readonly value?: string;
  readonly source?: string;
  readonly kind?: string;
}

export type AriaUnavailableReason =
  | 'not_configured' // connector off / no secret / no ALEMBIC tenant id / ALEMBIC refuses our signature
  | 'not_linked' //    this RawProd user has no ALEMBIC identity bound (or ALEMBIC no longer knows it)
  | 'refused' //       ALEMBIC refused the question (bad request, conversation gone)
  | 'rate_limited'
  | 'unreachable';

export type AriaAskResult =
  | {
      readonly status: 'answered';
      readonly text: string;
      readonly via: string;
      readonly cited: readonly AriaCitedFact[];
      readonly conversationId?: string;
    }
  | { readonly status: 'unavailable'; readonly reason: AriaUnavailableReason; readonly message: string };

const MESSAGES: Readonly<Record<AriaUnavailableReason, string>> = {
  not_configured:
    'Aria answers from ALEMBIC\'s records, and this console is not connected to ALEMBIC yet. ' +
    'Ask me in ALEMBIC Admin, or ask an administrator to finish the bridge connection.',
  not_linked:
    'Aria answers as your ALEMBIC account, and this RawProd sign-in is not linked to one yet. ' +
    'Sign in to RawProd through ALEMBIC once to link it.',
  refused: 'ALEMBIC could not take that question.',
  rate_limited: 'Too many questions just now. Try again in a minute.',
  unreachable: 'I could not reach ALEMBIC, so I have nothing to answer against. I will not guess.',
};

function unavailable(reason: AriaUnavailableReason, message?: string): AriaAskResult {
  return { status: 'unavailable', reason, message: message ?? MESSAGES[reason] };
}

/** Where ALEMBIC answers: the origin of ALEMBIC's own bridge webhook URL. */
export function alembicAriaUrl(webhookUrl: string | null | undefined): string | null {
  if (!webhookUrl) return null;
  try {
    const u = new URL(webhookUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `${u.origin}${ALEMBIC_ARIA_PATH}`;
  } catch {
    return null;
  }
}

interface Link {
  readonly url: string;
  readonly secret: string;
  readonly tenantId: string;
}

@Injectable()
export class AriaBridgeService {
  private readonly logger = new Logger(AriaBridgeService.name);
  private readonly doFetch: typeof fetch;

  constructor(
    @Inject(PG_CLIENT) private readonly sql: Sql,
    @Inject(BRIDGE_DB) private readonly bridgeDb: BridgeDb,
    @Inject(ConfigService) private readonly config: Pick<ConfigService, 'get'>,
    @Optional() @Inject(ARIA_BRIDGE_FETCH) fetchImpl?: typeof fetch,
  ) {
    this.doFetch = fetchImpl ?? fetch;
  }

  /** The ALEMBIC subject this principal is bound to, or null. Read from the ROW, per call —
   *  an email change clears it (SecurityService), and that must take effect at once. */
  private async subjectFor(principal: AuthPrincipal): Promise<string | null> {
    const [row] = (await this.sql`
      select alembic_subject as "subject", is_active as "isActive", status
        from iam.user_master
       where user_id = ${principal.userId}
       limit 1`) as Array<{ subject: string | null; isActive: boolean | null; status: string | null }>;
    if (!row?.subject) return null;
    const statusUpper = row.status ? row.status.toUpperCase() : null;
    if (row.isActive === false || (statusUpper !== null && statusUpper !== 'ACTIVE')) return null;
    return row.subject;
  }

  /** The bridge's half of the connection, or null when any piece is missing. */
  private async link(): Promise<Link | null> {
    const tenantId = this.config.get('ALEMBIC_ASSERTION_TENANT_ID');
    if (!tenantId) return null;
    const config = (await this.bridgeDb.select().from(connectorConfig)
      .where(eq(connectorConfig.id, 'default')).limit(1))[0];
    if (!config?.enabled) return null;
    const url = alembicAriaUrl(config.webhookUrl);
    const secret = config.hmacSecretSealed ? openSecret(config.hmacSecretSealed) : null;
    if (!url || !secret) return null;
    return { url, secret, tenantId };
  }

  /** Whether the panel should offer Aria at all — the honest fallback is chosen from this. */
  async status(principal: AuthPrincipal): Promise<{ available: boolean; reason?: AriaUnavailableReason; message?: string }> {
    if (!(await this.link())) return { available: false, reason: 'not_configured', message: MESSAGES.not_configured };
    if (!(await this.subjectFor(principal))) return { available: false, reason: 'not_linked', message: MESSAGES.not_linked };
    return { available: true };
  }

  async ask(principal: AuthPrincipal, input: AriaAskInput): Promise<AriaAskResult> {
    const link = await this.link();
    if (!link) return unavailable('not_configured');
    const subject = await this.subjectFor(principal);
    if (!subject) return unavailable('not_linked');

    const view = input.console !== 'vault' && typeof input.view === 'string' && VIEW_RE.test(input.view.trim())
      ? input.view.trim() : undefined;
    const body = JSON.stringify({
      tenantId: link.tenantId,
      subject,
      question: input.question,
      console: input.console,
      ...(view ? { view } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.persist ? { persist: true } : {}),
      rawprodUserId: principal.userId,
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomUUID();

    let res: Response;
    try {
      res = await this.doFetch(link.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-bridge-request-id': randomUUID(),
          'x-bridge-timestamp': timestamp,
          'x-bridge-nonce': nonce,
          'x-bridge-signature': signBody(`${timestamp}.${nonce}.${body}`, link.secret),
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.warn(`aria bridge unreachable: ${err instanceof Error ? err.message : String(err)}`);
      return unavailable('unreachable');
    }

    const raw: unknown = await res.json().catch(() => null);
    const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (res.status === 401 || res.status === 503) {
      // Our signature or ALEMBIC's connector: an operator's problem, never the asker's.
      this.logger.warn(`aria bridge refused by ALEMBIC: ${res.status} ${String(obj.outcome ?? '')}`);
      return unavailable('not_configured');
    }
    if (res.status === 403) {
      const outcome = String(obj.outcome ?? '');
      if (outcome === 'unknown_subject' || outcome === 'inactive' || outcome === 'no_roles'
        || outcome === 'demo_refused') {
        return unavailable('not_linked',
          'Your linked ALEMBIC account cannot use Aria right now (it is unknown, suspended or has no role). '
          + 'Ask an ALEMBIC administrator.');
      }
      this.logger.warn(`aria bridge refused by ALEMBIC: 403 ${outcome}`);
      return unavailable('not_configured');
    }
    if (res.status === 429) return unavailable('rate_limited');
    if (!res.ok) {
      const error = typeof obj.error === 'string' && obj.error.length <= 300 ? obj.error : undefined;
      return unavailable('refused', error);
    }

    const text = typeof obj.text === 'string' ? obj.text : '';
    const via = typeof obj.via === 'string' ? obj.via : 'resolver';
    const cited = Array.isArray(obj.cited) ? obj.cited.flatMap((c): AriaCitedFact[] => {
      if (!c || typeof c !== 'object') return [];
      const f = c as Record<string, unknown>;
      if (typeof f.label !== 'string') return [];
      const s = (k: string) => (typeof f[k] === 'string' ? { [k]: f[k] as string } : {});
      return [{ label: f.label, ...s('id'), ...s('value'), ...s('source'), ...s('kind') }];
    }) : [];
    return {
      status: 'answered', text, via, cited,
      ...(typeof obj.conversationId === 'string' ? { conversationId: obj.conversationId } : {}),
    };
  }
}
