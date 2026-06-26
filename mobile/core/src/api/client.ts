import type { z } from 'zod';
import { envelope, type ApiError } from '@core/contracts';

/**
 * Error thrown for any non-OK response or transport failure. Carries the normalized
 * {@link ApiError} from the envelope when the edge layer returned one.
 */
export class ApiClientError extends Error {
  readonly status: number;
  readonly apiError: ApiError | null;

  constructor(message: string, status: number, apiError: ApiError | null) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.apiError = apiError;
  }
}

export interface ApiClientOptions {
  /** Base URL of the API edge (no trailing slash). Injected so the client is testable. */
  baseUrl: string;
  /**
   * Returns the current access token (from SecureStore-backed session), or null when
   * anonymous. Called per request so token rotation is transparent.
   */
  getToken: () => Promise<string | null> | string | null;
  /** Request timeout in ms. */
  timeoutMs?: number;
  /** Override fetch (tests / RN polyfills). Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

export interface RequestOptions<TBody extends z.ZodTypeAny> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Schema the response `data` is parsed against — the contract for this endpoint. */
  responseSchema: TBody;
  /** JSON request body (already validated by the caller against its request schema). */
  body?: unknown;
  /** Extra headers merged over the defaults. */
  headers?: Record<string, string>;
  /** Skip attaching the bearer token (e.g. login/register). */
  anonymous?: boolean;
  signal?: AbortSignal;
}

/**
 * Minimal typed fetch client over the platform's `{ data, meta, error }` envelope.
 *
 * - Every response is validated with `envelope(responseSchema)` from @core/contracts, so the
 *   parsed result is fully typed and shape-guaranteed.
 * - The bearer token is fetched lazily per request via the injected `getToken` (sourced from
 *   SecureStore — see auth/secure-tokens.ts), never stored here.
 * - On `error` envelopes or HTTP failures it throws {@link ApiClientError} with the
 *   normalized ApiError.
 */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly getToken: ApiClientOptions['getToken'];
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.getToken = opts.getToken;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async request<TSchema extends z.ZodTypeAny>(
    path: string,
    opts: RequestOptions<TSchema>,
  ): Promise<z.infer<TSchema>> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...opts.headers,
    };

    if (!opts.anonymous) {
      const token = await this.getToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    // Honour a caller-supplied signal too.
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } catch (cause) {
      throw new ApiClientError(
        cause instanceof Error ? cause.message : 'Network request failed',
        0,
        null,
      );
    } finally {
      clearTimeout(timeout);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ApiClientError(`Malformed response (HTTP ${res.status})`, res.status, null);
    }

    const parsed = envelope(opts.responseSchema).safeParse(json);
    if (!parsed.success) {
      throw new ApiClientError(
        `Response failed contract validation (HTTP ${res.status})`,
        res.status,
        null,
      );
    }

    const { data, error } = parsed.data;
    if (error || !res.ok || data === null) {
      throw new ApiClientError(
        error?.message ?? `Request failed (HTTP ${res.status})`,
        res.status,
        error ?? null,
      );
    }

    return data as z.infer<TSchema>;
  }
}
