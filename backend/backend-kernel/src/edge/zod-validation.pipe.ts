/**
 * ZodValidationPipe — validates a handler arg (body/query/params) against a zod schema
 * from `@core/contracts`. zod is the boundary validator everywhere (doc 02, doc 05 §2):
 * unknown keys are stripped by the schemas, and a parse failure becomes a `DomainError`
 * (`VALIDATION_FAILED`, 422) with field-level `details` the envelope surfaces.
 *
 * Usage (per-arg — the precise, recommended form):
 *   @Post() register(@Body(new ZodValidationPipe(identity.auth.registerRequest)) dto: RegisterDto) {}
 *
 * Define a `RegisterDto = z.infer<typeof identity.auth.registerRequest>` alias for the param type.
 */
import {
  type ArgumentMetadata,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';
import { ZodError, type ZodSchema } from 'zod';
import { DomainError } from './domain-error.js';

@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    try {
      return this.schema.parse(value);
    } catch (err) {
      if (err instanceof ZodError) {
        const details: Record<string, string[]> = {};
        for (const issue of err.issues) {
          const path = issue.path.join('.') || '(root)';
          (details[path] ??= []).push(issue.message);
        }
        throw new DomainError('VALIDATION_FAILED', 'Validation failed', 422, details);
      }
      throw err;
    }
  }
}
