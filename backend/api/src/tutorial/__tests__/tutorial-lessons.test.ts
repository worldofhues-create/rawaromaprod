/**
 * TUTORIAL_LESSONS registry — structural integrity + the ticket G4 requirement this lane must
 * not regress: every action/verify permission referenced by a lesson is a REAL, live permission
 * string from scripts/ra-permissions.ts (so ALEMBIC's UNMAPPED_TUTORIAL_FEATURES count stays 0),
 * and `reachableTutorialTracks` computes the RawProd equivalent of ALEMBIC's own function
 * against the REAL role catalogue in scripts/ra-roles.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TUTORIAL_LESSONS,
  TUTORIAL_TRACKS,
  TUTORIAL_TRACK_ROLES,
  reachableTutorialTracks,
  getLesson,
  lessonPermissions,
} from '../tutorial-lessons.js';
import { RA_PERMISSIONS } from '../../../../../scripts/ra-permissions.js';
import { ROLES } from '../../../../../scripts/ra-roles.js';

test('tutorial lessons: exactly 8 lessons, one per required workspace (ticket G4 scope)', () => {
  assert.equal(TUTORIAL_LESSONS.length, 8);
  const tracks = TUTORIAL_LESSONS.map((l) => l.track).sort();
  assert.deepEqual(tracks, [...TUTORIAL_TRACKS].sort());
});

test('tutorial lessons: every lesson id is unique', () => {
  const ids = TUTORIAL_LESSONS.map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('tutorial lessons: every lesson has at least one info, one target/action, and exactly one verify step', () => {
  for (const lesson of TUTORIAL_LESSONS) {
    const kinds = lesson.steps.map((s) => s.kind);
    assert.ok(kinds.includes('info'), `${lesson.id}: missing an info step`);
    assert.ok(
      kinds.includes('target') || kinds.includes('action'),
      `${lesson.id}: missing a target/action step`,
    );
    assert.equal(
      kinds.filter((k) => k === 'verify').length,
      1,
      `${lesson.id}: expected exactly one verify step`,
    );
    // verify is always last — the lesson's completion condition.
    assert.equal(kinds[kinds.length - 1], 'verify', `${lesson.id}: verify step must be last`);
  }
});

test('tutorial lessons: every action/verify permission is a real, live RA permission string', () => {
  for (const lesson of TUTORIAL_LESSONS) {
    for (const permission of lessonPermissions(lesson)) {
      assert.ok(
        RA_PERMISSIONS.includes(permission),
        `${lesson.id}: '${permission}' is not in scripts/ra-permissions.ts (RA_PERMISSIONS)`,
      );
    }
  }
});

test('tutorial lessons: every action step is confirm-required or safe, and carries a target', () => {
  for (const lesson of TUTORIAL_LESSONS) {
    for (const step of lesson.steps) {
      if (step.kind !== 'action') continue;
      assert.ok(['safe', 'confirm-required'].includes(step.safety), `${lesson.id}/${step.id}: invalid safety`);
      assert.ok(step.target, `${lesson.id}/${step.id}: action step needs a target`);
    }
  }
});

test('tutorial lessons: every verify step polls a GET and asserts something', () => {
  for (const lesson of TUTORIAL_LESSONS) {
    const verify = lesson.steps.find((s) => s.kind === 'verify');
    assert.ok(verify && verify.kind === 'verify');
    if (verify && verify.kind === 'verify') {
      assert.equal(verify.check.method, 'GET');
      assert.ok(verify.check.path.startsWith('/'));
      assert.ok(['equals', 'exists', 'matches', 'changed'].includes(verify.check.assert.op));
    }
  }
});

test('tutorial lessons: getLesson finds a real lesson and returns undefined for an unknown id', () => {
  assert.ok(getLesson('procurement-reorder-to-requirement'));
  assert.equal(getLesson('does-not-exist'), undefined);
});

test("tutorial tracks: TUTORIAL_TRACK_ROLES' role codes are all real scripts/ra-roles.ts role codes", () => {
  const realRoleCodes = new Set(ROLES.map((r) => r.code));
  for (const track of TUTORIAL_TRACKS) {
    for (const roleCode of TUTORIAL_TRACK_ROLES[track]) {
      assert.ok(realRoleCodes.has(roleCode), `track '${track}' names unknown role '${roleCode}'`);
    }
  }
});

test('reachableTutorialTracks: a procurement-role caller reaches only the procurement track', () => {
  assert.deepEqual(reachableTutorialTracks(['procurement']), ['procurement']);
});

test('reachableTutorialTracks: the sales role reaches the dispatch track (not a literal "sales" track)', () => {
  assert.deepEqual(reachableTutorialTracks(['sales']), ['dispatch']);
});

test('reachableTutorialTracks: platform_super_admin reaches only the platform track', () => {
  assert.deepEqual(reachableTutorialTracks(['platform_super_admin']), ['platform']);
});

test('reachableTutorialTracks: a caller with no matching role reaches nothing', () => {
  assert.deepEqual(reachableTutorialTracks(['owner']), []);
  assert.deepEqual(reachableTutorialTracks([]), []);
});

test('reachableTutorialTracks: multiple roles union their reachable tracks', () => {
  assert.deepEqual(reachableTutorialTracks(['qc', 'warehouse']).sort(), ['qc', 'warehouse']);
});
