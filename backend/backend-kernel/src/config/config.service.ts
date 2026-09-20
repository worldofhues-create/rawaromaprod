/**
 * ConfigService — validated, typed access to env. Parses `process.env` against
 * `configSchema` exactly once; throws a readable aggregate error on a bad env so the
 * process never boots half-configured.
 */
import { Injectable } from '@nestjs/common';
import { type AppConfig, configSchema } from './config.schema.js';

@Injectable()
export class ConfigService {
  private readonly values: AppConfig;

  constructor(source: NodeJS.ProcessEnv = process.env) {
    const parsed = configSchema.safeParse(source);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n');
      throw new Error(`Invalid environment configuration:\n${issues}`);
    }
    this.values = parsed.data;
  }

  /** Read a single validated key. */
  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.values[key];
  }

  /** The whole validated config (read-only). */
  get all(): Readonly<AppConfig> {
    return this.values;
  }

  get isProd(): boolean {
    return this.values.APP_ENV === 'prod';
  }
}
