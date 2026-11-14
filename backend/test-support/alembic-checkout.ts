/**
 * FACTORY-DOCS — run what RawProd emits through ALEMBIC's OWN receiver code, loaded by path from an
 * ALEMBIC checkout at test time. Nothing of ALEMBIC is copied into this repository (unlike the
 * pinned fixtures in alembic-docs001.ts, which can drift silently): a field-name mismatch fails HERE
 * against the receiver as it is on that checkout, not in production.
 *
 *   ALEMBIC_DOCS_CHECKOUT   an ALEMBIC worktree on a branch that has `parseQcGcmsAttached`
 *                           (st4/docs-auto); default /Users/apple/Downloads/alembic-lanes/docs-auto.
 *
 * ALEMBIC's domain package is TypeScript that Node 22 runs natively (type stripping), so the parsers
 * run in a child `node` with no loader and no dependency; JSON in on stdin, results out on stdout.
 * With no checkout the tests that need it are SKIPPED, and say so loudly: a skip is not a pass.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const ALEMBIC_CHECKOUT = process.env.ALEMBIC_DOCS_CHECKOUT ?? '/Users/apple/Downloads/alembic-lanes/docs-auto';
const DOCUMENTS = join(ALEMBIC_CHECKOUT, 'packages/domain/src/compliance/documents.ts');
const ENVELOPE = join(ALEMBIC_CHECKOUT, 'packages/domain/src/bridge/envelope.ts');

let warned = false;

/** false when the checkout is usable; otherwise the reason, printed once to stderr. */
export function alembicSkipReason(): string | false {
  let reason: string | false = false;
  if (!existsSync(DOCUMENTS) || !existsSync(ENVELOPE)) reason = `no ALEMBIC checkout at ${ALEMBIC_CHECKOUT} (set ALEMBIC_DOCS_CHECKOUT)`;
  else if (!/export function parseQcGcmsAttached\(/.test(readFileSync(DOCUMENTS, 'utf8'))) {
    reason = `the ALEMBIC checkout at ${ALEMBIC_CHECKOUT} has no parseQcGcmsAttached (check out st4/docs-auto or later)`;
  }
  if (reason && !warned) {
    warned = true;
    process.stderr.write(`\n!!! SKIPPED: ALEMBIC receiver checks NOT RUN -- ${reason}. What RawProd emits is NOT proved acceptable to ALEMBIC.\n\n`);
  }
  return reason;
}

export type AlembicCheck =
  | { kind: 'qc.batch.released' | 'compliance.certificate.calculated' | 'qc.gcms.attached'; payload: unknown }
  | { kind: 'envelope'; envelope: unknown };

export type AlembicVerdict = { ok: true } | { ok: false; problems: string[] };

/** ALEMBIC's verdict on each item, in order: its parser for the fact type, or `validateEnvelope`
 *  against its own INBOUND_EVENT_TYPES. */
export function alembicVerdicts(items: AlembicCheck[]): AlembicVerdict[] {
  const script = `
    import { parseQcBatchReleased, parseCertificateCalculated, parseQcGcmsAttached } from ${JSON.stringify(pathToFileURL(DOCUMENTS).href)};
    import { validateEnvelope, INBOUND_EVENT_TYPES } from ${JSON.stringify(pathToFileURL(ENVELOPE).href)};
    let s = ''; process.stdin.on('data', (d) => (s += d)).on('end', () => {
      const parsers = { 'qc.batch.released': parseQcBatchReleased, 'compliance.certificate.calculated': parseCertificateCalculated, 'qc.gcms.attached': parseQcGcmsAttached };
      const out = JSON.parse(s).map((it) => {
        const r = it.kind === 'envelope' ? validateEnvelope(it.envelope, INBOUND_EVENT_TYPES) : parsers[it.kind](it.payload);
        return r.ok ? { ok: true } : { ok: false, problems: [...r.problems] };
      });
      process.stdout.write(JSON.stringify(out));
    });`;
  const res = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], {
    input: JSON.stringify(items), encoding: 'utf8', env: { PATH: process.env.PATH ?? '' }, timeout: 60_000,
  });
  if (res.status !== 0) throw new Error(`ALEMBIC parsers did not run (exit ${res.status}): ${res.stderr}`);
  return JSON.parse(res.stdout) as AlembicVerdict[];
}
