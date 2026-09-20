/**
 * AllExceptionsFilter — the single error exit. Maps everything thrown in a request to the
 * normalized envelope `{ data: null, meta, error: { code, message, details, requestId } }`
 * with a contracts `ErrorCode` (doc 06 §9 error normalization). Precedence:
 *   1. `DomainError`     → its own code + status + details.
 *   2. `ZodError`        → VALIDATION_FAILED (422) — a stray parse outside the pipe.
 *   3. `HttpException`    → mapped by status to the nearest code.
 *   4. anything else      → INTERNAL_ERROR (500), original logged, message hidden.
 */
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ZodError } from 'zod';
import type { ApiError, ErrorCode } from '@core/contracts';
import { DomainError } from './domain-error.js';
import type { RequestWithUser } from './principal.js';

interface FastifyReplyLike {
  status(code: number): FastifyReplyLike;
  send(body: unknown): unknown;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<RequestWithUser>();
    const reply = ctx.getResponse<FastifyReplyLike>();
    const requestId = request.requestId ?? '';

    const { status, error } = this.normalize(exception, requestId);

    if (status >= 500) {
      this.logger.error(
        `${request.method ?? ''} ${request.url ?? ''} → ${error.code}: ${String(exception)}`,
      );
    }

    reply.status(status).send({ data: null, meta: { requestId }, error });
  }

  private normalize(
    exception: unknown,
    requestId: string,
  ): { status: number; error: ApiError } {
    if (exception instanceof DomainError) {
      return {
        status: exception.status,
        error: {
          code: exception.code,
          message: exception.message,
          ...(exception.details ? { details: exception.details } : {}),
          requestId,
        },
      };
    }

    if (exception instanceof ZodError) {
      const details: Record<string, string[]> = {};
      for (const issue of exception.issues) {
        const path = issue.path.join('.') || '(root)';
        (details[path] ??= []).push(issue.message);
      }
      return {
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        error: { code: 'VALIDATION_FAILED', message: 'Validation failed', details, requestId },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        status,
        error: { code: statusToCode(status), message: exception.message, requestId },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId },
    };
  }
}

/** Best-effort HTTP-status → contracts ErrorCode mapping for non-DomainError throws. */
function statusToCode(status: number): ErrorCode {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return 'VALIDATION_FAILED';
    case HttpStatus.UNAUTHORIZED:
      return 'AUTH_TOKEN_INVALID';
    case HttpStatus.FORBIDDEN:
      return 'AUTH_FORBIDDEN';
    case HttpStatus.NOT_FOUND:
      return 'NOT_FOUND';
    case HttpStatus.CONFLICT:
      return 'CONFLICT';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'RATE_LIMITED';
    case HttpStatus.SERVICE_UNAVAILABLE:
      return 'FEATURE_DISABLED';
    default:
      return 'INTERNAL_ERROR';
  }
}
