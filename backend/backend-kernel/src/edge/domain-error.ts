/**
 * DomainError — the one error type services throw. It carries a contracts `ErrorCode`
 * (the stable string clients branch on) + an HTTP status; `AllExceptionsFilter` turns it
 * into the normalized `{ error: { code, message, requestId } }` envelope. Throwing this
 * (instead of a raw `HttpException`) keeps error codes centralised in `@core/contracts`.
 */
import type { ErrorCode } from '@core/contracts';

export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number = 400,
    readonly details?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'DomainError';
  }

  /** 401 — bad password / otp / token. */
  static unauthorized(code: ErrorCode = 'AUTH_INVALID_CREDENTIALS', message = 'Unauthorized') {
    return new DomainError(code, message, 401);
  }

  /** 403 — authenticated but not allowed (permission / portal). */
  static forbidden(code: ErrorCode = 'AUTH_FORBIDDEN', message = 'Forbidden') {
    return new DomainError(code, message, 403);
  }

  /** 404. */
  static notFound(message = 'Not found') {
    return new DomainError('NOT_FOUND', message, 404);
  }

  /** 409. */
  static conflict(message = 'Conflict') {
    return new DomainError('CONFLICT', message, 409);
  }

  /** 503 — flag/kill-switch. */
  static featureDisabled(message = 'Feature is currently disabled') {
    return new DomainError('FEATURE_DISABLED', message, 503);
  }
}
