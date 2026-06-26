/**
 * Builds the OpenAPI 3.1 spec from the zod contracts → dist/openapi.json.
 * That file feeds (a) the typed @core/api-client codegen and (b) the Prism mock server
 * (`pnpm mock`) so nt-web / nt-mobile develop without waiting on nt-backend.
 *
 * Run: pnpm openapi
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { envelope } from '../src/primitives/envelope.js';
import { auth } from '../src/clusters/identity/index.js';

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

// --- identity: a representative slice (the pattern every cluster follows) ---
registry.registerPath({
  method: 'post',
  path: '/v1/auth/register',
  tags: ['identity'],
  summary: 'Register a buyer/owner/builder/… account',
  request: { body: { content: { 'application/json': { schema: auth.registerRequest } } } },
  responses: {
    201: {
      description: 'Created',
      content: { 'application/json': { schema: envelope(auth.authResult) } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/auth/login',
  tags: ['identity'],
  summary: 'Login (password or OTP)',
  request: { body: { content: { 'application/json': { schema: auth.loginRequest } } } },
  responses: {
    200: {
      description: 'OK',
      content: { 'application/json': { schema: envelope(auth.authResult) } },
    },
  },
});

const generator = new OpenApiGeneratorV31(registry.definitions);
const doc = generator.generateDocument({
  openapi: '3.1.0',
  info: { title: 'Namasthethu API', version: '0.0.0' },
  servers: [{ url: 'https://api.namasthethu.com' }],
});

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../dist');
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'openapi.json'), JSON.stringify(doc, null, 2));
console.log('✓ wrote dist/openapi.json');
