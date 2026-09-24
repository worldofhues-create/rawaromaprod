/**
 * G3 — runIdempotent (backend/api/src/automation/ledger.ts): the shared idempotency +
 * decision-log + dead-letter substrate every automation rule runs through. Covers exactly the
 * reliability properties the lane brief requires per rule: duplicate delivery produces no
 * second effect, a failing rule is retried (retry-safe — no partial state), and repeated
 * failure dead-letters the key instead of retrying forever.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureSchema, testClient, closeTestClient } from '../../../../test-support/db.js';
import { runIdempotent } from '../ledger.js';
import { MAX_ATTEMPTS } from '../automation.constants.js';

before(async () => {
  await ensureSchema();
});
after(async () => {
  await closeTestClient();
});

test('runIdempotent: fires the work exactly once for a fresh key', async () => {
  const sql = testClient();
  const ruleCode = 'test_rule_fire_once';
  const dedupeKey = randomUUID();
  let calls = 0;

  const outcome = await runIdempotent({
    sql,
    ruleCode,
    dedupeKey,
    eventType: 'test.event',
    inputs: { n: 1 },
    work: async () => {
      calls++;
      return { decision: 'FIRED', reason: 'did the thing' };
    },
  });

  assert.equal(calls, 1);
  assert.equal(outcome?.decision, 'FIRED');

  const applied = await sql`select status, attempts from automation.applied where rule_code = ${ruleCode} and dedupe_key = ${dedupeKey}`;
  assert.equal(applied[0]?.status, 'DONE');

  const log = await sql`select decision, reason from automation.decision_log where rule_code = ${ruleCode} and dedupe_key = ${dedupeKey}`;
  assert.equal(log.length, 1);
  assert.equal(log[0]?.decision, 'FIRED');
});

test('runIdempotent: duplicate delivery of the same key never runs the work twice', async () => {
  const sql = testClient();
  const ruleCode = 'test_rule_dup';
  const dedupeKey = randomUUID();
  let calls = 0;

  const work = async () => {
    calls++;
    return { decision: 'FIRED' as const, reason: 'effect applied' };
  };

  await runIdempotent({ sql, ruleCode, dedupeKey, eventType: 'test.event', work });
  // Simulate a duplicate/out-of-order redelivery of the SAME event.
  await runIdempotent({ sql, ruleCode, dedupeKey, eventType: 'test.event', work });
  await runIdempotent({ sql, ruleCode, dedupeKey, eventType: 'test.event', work });

  assert.equal(calls, 1, 'work must run exactly once despite 3 delivery attempts');

  const log = await sql`select count(*)::int as c from automation.decision_log where rule_code = ${ruleCode} and dedupe_key = ${dedupeKey}`;
  assert.equal(log[0]?.c, 1, 'exactly one decision-log row — no double effect logged either');
});

test('runIdempotent: concurrent duplicate delivery still runs the work exactly once', async () => {
  const sql = testClient();
  const ruleCode = 'test_rule_concurrent_dup';
  const dedupeKey = randomUUID();
  let calls = 0;

  const work = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 25));
    return { decision: 'FIRED' as const, reason: 'effect applied' };
  };

  await Promise.all([
    runIdempotent({ sql, ruleCode, dedupeKey, eventType: 'test.event', work }),
    runIdempotent({ sql, ruleCode, dedupeKey, eventType: 'test.event', work }),
    runIdempotent({ sql, ruleCode, dedupeKey, eventType: 'test.event', work }),
  ]);

  assert.equal(calls, 1, 'the atomic claim (INSERT ... ON CONFLICT DO NOTHING) must serialize concurrent racers to one winner');
});

test('runIdempotent: a failing rule is retried (retry-safe) and left retryable below MAX_ATTEMPTS', async () => {
  const sql = testClient();
  const ruleCode = 'test_rule_retry';
  const dedupeKey = randomUUID();
  let calls = 0;

  const outcome1 = await runIdempotent({
    sql,
    ruleCode,
    dedupeKey,
    eventType: 'test.event',
    work: async () => {
      calls++;
      throw new Error('transient failure');
    },
  });
  assert.equal(outcome1, null, 'a failed attempt returns null, not a fabricated outcome');

  const applied1 = await sql`select status, attempts, last_error from automation.applied where rule_code = ${ruleCode} and dedupe_key = ${dedupeKey}`;
  assert.equal(applied1[0]?.status, 'FAILED');
  assert.equal(applied1[0]?.attempts, 1);
  assert.match(String(applied1[0]?.last_error), /transient failure/);

  // No decision-log row for a failed attempt — nothing "fired" that didn't actually commit.
  const log = await sql`select count(*)::int as c from automation.decision_log where rule_code = ${ruleCode} and dedupe_key = ${dedupeKey}`;
  assert.equal(log[0]?.c, 0);

  // Retried on the next drain tick — succeeds this time.
  const outcome2 = await runIdempotent({
    sql,
    ruleCode,
    dedupeKey,
    eventType: 'test.event',
    work: async () => {
      calls++;
      return { decision: 'FIRED' as const, reason: 'succeeded on retry' };
    },
  });
  assert.equal(calls, 2);
  assert.equal(outcome2?.decision, 'FIRED');

  const applied2 = await sql`select status from automation.applied where rule_code = ${ruleCode} and dedupe_key = ${dedupeKey}`;
  assert.equal(applied2[0]?.status, 'DONE');
});

test('runIdempotent: repeated failure dead-letters the key after MAX_ATTEMPTS and stops retrying', async () => {
  const sql = testClient();
  const ruleCode = 'test_rule_dlq';
  const dedupeKey = randomUUID();
  let calls = 0;

  const alwaysFails = async () => {
    calls++;
    throw new Error(`boom #${calls}`);
  };

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await runIdempotent({ sql, ruleCode, dedupeKey, eventType: 'test.event', inputs: { attempt: i }, work: alwaysFails });
  }
  assert.equal(calls, MAX_ATTEMPTS);

  const dead = await sql`select attempts, error from automation.dead_letter where rule_code = ${ruleCode} and dedupe_key = ${dedupeKey}`;
  assert.equal(dead.length, 1, 'dead-lettered after MAX_ATTEMPTS');
  assert.equal(dead[0]?.attempts, MAX_ATTEMPTS);
  assert.match(String(dead[0]?.error), /boom/);

  // One more delivery attempt: must NOT retry (the key is dead) and must NOT increment calls.
  await runIdempotent({ sql, ruleCode, dedupeKey, eventType: 'test.event', work: alwaysFails });
  assert.equal(calls, MAX_ATTEMPTS, 'a dead-lettered key is never retried again');
});
