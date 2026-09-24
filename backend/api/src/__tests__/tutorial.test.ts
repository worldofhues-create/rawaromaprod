/**
 * TutorialService — DB-backed integration tests against the real `platform.tutorial_progress`
 * table (backend/test-support/schema.sql), proving the ticket G4 authorization rules that live
 * in the SERVICE (not the static `@Permissions` guard, since every tutorial route is
 * `@SelfService()` — see tutorial.controller.ts's own comment):
 *   - a caller may only write progress for a lesson whose `track` their OWN real roles reach
 *     (`reachableTutorialTracks`) — 403 otherwise, even when the request's `role` field matches
 *     the lesson's track but the caller's roles don't.
 *   - a request naming the wrong `role` for a given lesson is also 403.
 *   - a stale `tutorialVersion` is rejected with 409 TUTORIAL_STALE_VERSION.
 *   - an unknown lesson id is 404.
 *   - `resetAll` deletes only the calling user's own rows.
 * randomUUID() per test (own iam.user_master row) rather than principal()'s shared default id —
 * same isolation convention facts.service.test.ts uses, since files share one Postgres and
 * `--test-concurrency=1` still runs many files against the same tables over the suite's lifetime.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TutorialService } from '../tutorial/tutorial.service.js';
import { getLesson } from '../tutorial/tutorial-lessons.js';
import { DomainError } from '../../../backend-kernel/src/edge/domain-error.js';
import { ensureSchema, testClient, principal, closeTestClient } from '../../../test-support/db.js';

let svc: TutorialService;

before(async () => {
  await ensureSchema();
  svc = new TutorialService(testClient() as never);
});

after(async () => {
  await closeTestClient();
});

async function makeUser(roleHint: string): Promise<string> {
  const sql = testClient();
  const userId = randomUUID();
  await sql`
    insert into iam.user_master (user_id, email, user_name, is_active, status)
    values (${userId}, ${`tutorial-${roleHint}-${userId}@rawaroma.local`}, 'Tutorial Test User', true, 'ACTIVE')
  `;
  return userId;
}

test('tutorial: start -> advance walks a lesson through to completion, totalSteps from the registry', async () => {
  const userId = await makeUser('procurement');
  const p = principal({ userId, roles: ['procurement'], permissions: [] });
  const lesson = getLesson('procurement-reorder-to-requirement');
  assert.ok(lesson);
  const lessonId = lesson!.id;
  const totalSteps = lesson!.steps.length;

  const started = await svc.applyEvent(p, lessonId, { role: 'procurement', event: { type: 'start' } });
  assert.equal(started.status, 'in_progress');
  assert.equal(started.stepIndex, 0);
  assert.equal(started.totalSteps, totalSteps);
  assert.equal(started.tutorialVersion, lesson!.version);
  assert.ok(started.startedAt);
  assert.equal(started.completedAt, null);

  // totalSteps advances are needed in total: totalSteps-1 to walk through steps 1..last, plus
  // one more FROM the last step to actually mark it completed (see tutorial-engine.ts's
  // `advance` case: completion fires when `stepIndex + 1 >= totalSteps`, i.e. on the advance
  // call made WHILE ALREADY on the last step, not the one that lands on it).
  let last = started;
  for (let i = 1; i <= totalSteps; i++) {
    last = await svc.applyEvent(p, lessonId, {
      role: 'procurement',
      event: { type: 'advance', tutorialVersion: lesson!.version },
    });
    assert.equal(last.stepIndex, Math.min(i, totalSteps - 1));
  }
  assert.equal(last.status, 'completed');
  assert.ok(last.completedAt);

  const rows = await svc.progress(p);
  const row = rows.find((r) => r.lessonId === lessonId);
  assert.ok(row);
  assert.equal(row!.status, 'completed');
  assert.equal(row!.totalSteps, totalSteps);
});

test('tutorial: 403 when the request role does not match the lesson’s own track', async () => {
  const userId = await makeUser('procurement');
  const p = principal({ userId, roles: ['procurement'], permissions: [] });
  const lesson = getLesson('procurement-reorder-to-requirement')!;
  await assert.rejects(
    () => svc.applyEvent(p, lesson.id, { role: 'qc', event: { type: 'start' } }),
    (err: unknown) => {
      assert.ok(err instanceof DomainError);
      assert.equal((err as DomainError).status, 403);
      return true;
    },
  );
});

test('tutorial: 403 when the role matches the lesson’s track but the caller’s real roles do not reach it', async () => {
  const userId = await makeUser('qc-only');
  // holds only 'qc' — does not reach the 'procurement' track (reachableTutorialTracks).
  const p = principal({ userId, roles: ['qc'], permissions: [] });
  const lesson = getLesson('procurement-reorder-to-requirement')!;
  await assert.rejects(
    () => svc.applyEvent(p, lesson.id, { role: 'procurement', event: { type: 'start' } }),
    (err: unknown) => {
      assert.ok(err instanceof DomainError);
      assert.equal((err as DomainError).status, 403);
      return true;
    },
  );
});

test('tutorial: the sales role reaches the dispatch track (workspace-vs-role-code mapping)', async () => {
  const userId = await makeUser('sales');
  const p = principal({ userId, roles: ['sales'], permissions: [] });
  const lesson = getLesson('dispatch-confirmed-order')!;
  const started = await svc.applyEvent(p, lesson.id, { role: 'dispatch', event: { type: 'start' } });
  assert.equal(started.status, 'in_progress');
});

test('tutorial: 409 TUTORIAL_STALE_VERSION when the client sends a stale tutorialVersion', async () => {
  const userId = await makeUser('procurement-stale');
  const p = principal({ userId, roles: ['procurement'], permissions: [] });
  const lesson = getLesson('procurement-reorder-to-requirement')!;
  await svc.applyEvent(p, lesson.id, { role: 'procurement', event: { type: 'start' } });
  await assert.rejects(
    () =>
      svc.applyEvent(p, lesson.id, {
        role: 'procurement',
        event: { type: 'advance', tutorialVersion: lesson.version + 999 },
      }),
    (err: unknown) => {
      assert.ok(err instanceof DomainError);
      assert.equal((err as DomainError).status, 409);
      assert.equal((err as DomainError).code, 'TUTORIAL_STALE_VERSION');
      return true;
    },
  );
});

test('tutorial: 404 for an unknown lesson id', async () => {
  const userId = await makeUser('unknown-lesson');
  const p = principal({ userId, roles: ['procurement'], permissions: [] });
  await assert.rejects(
    () => svc.applyEvent(p, 'not-a-real-lesson', { role: 'procurement', event: { type: 'start' } }),
    (err: unknown) => {
      assert.ok(err instanceof DomainError);
      assert.equal((err as DomainError).status, 404);
      return true;
    },
  );
});

test('tutorial: dismiss preserves step position; restart always rewinds to step 0', async () => {
  const userId = await makeUser('warehouse');
  const p = principal({ userId, roles: ['warehouse'], permissions: [] });
  const lesson = getLesson('warehouse-stock-adjustment')!;
  await svc.applyEvent(p, lesson.id, { role: 'warehouse', event: { type: 'start' } });
  await svc.applyEvent(p, lesson.id, { role: 'warehouse', event: { type: 'advance' } });
  const dismissed = await svc.applyEvent(p, lesson.id, { role: 'warehouse', event: { type: 'dismiss' } });
  assert.equal(dismissed.status, 'dismissed');
  assert.equal(dismissed.stepIndex, 1);

  const restarted = await svc.applyEvent(p, lesson.id, { role: 'warehouse', event: { type: 'restart' } });
  assert.equal(restarted.status, 'in_progress');
  assert.equal(restarted.stepIndex, 0);
});

test('tutorial: "seen" creates a row so a repeat welcome-prompt check finds one (no re-prompt)', async () => {
  const userId = await makeUser('qc-seen');
  const p = principal({ userId, roles: ['qc'], permissions: [] });
  const lesson = getLesson('qc-record-results')!;

  const before_ = await svc.progress(p);
  assert.equal(before_.find((r) => r.lessonId === lesson.id), undefined);

  const seen = await svc.applyEvent(p, lesson.id, { role: 'qc', event: { type: 'seen' } });
  assert.equal(seen.status, 'not_started');

  const after_ = await svc.progress(p);
  const row = after_.find((r) => r.lessonId === lesson.id);
  assert.ok(row, 'a row now exists even though status is still not_started');
  assert.equal(row!.status, 'not_started');
});

test('tutorial: resetAll deletes only the calling user’s own rows', async () => {
  const userA = await makeUser('reset-a');
  const userB = await makeUser('reset-b');
  const pA = principal({ userId: userA, roles: ['warehouse'], permissions: [] });
  const pB = principal({ userId: userB, roles: ['warehouse'], permissions: [] });
  const lesson = getLesson('warehouse-stock-adjustment')!;

  await svc.applyEvent(pA, lesson.id, { role: 'warehouse', event: { type: 'start' } });
  await svc.applyEvent(pB, lesson.id, { role: 'warehouse', event: { type: 'start' } });

  const result = await svc.resetAll(pA);
  assert.equal(result.deleted, 1);

  assert.equal((await svc.progress(pA)).length, 0);
  assert.equal((await svc.progress(pB)).length, 1, "user B's row must survive user A's reset");
});
