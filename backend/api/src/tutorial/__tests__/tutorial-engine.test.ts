/**
 * TutorialEngine — pure reducer tests. No DB needed (see tutorial-engine.ts's own header).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTutorialEvent, type TutorialProgressRecord } from '../tutorial-engine.js';

const AT = new Date('2026-09-24T00:00:00.000Z');
const LATER = new Date('2026-09-24T00:05:00.000Z');

test('tutorial engine: start on a fresh (null) record begins in_progress at step 0', () => {
  const next = applyTutorialEvent(null, { type: 'start' }, 4, AT);
  assert.equal(next.status, 'in_progress');
  assert.equal(next.stepIndex, 0);
  assert.equal(next.startedAt, AT);
  assert.equal(next.completedAt, null);
  assert.equal(next.lastSeenAt, AT);
});

test('tutorial engine: start resumes an in-progress record at its current step, does not rewind', () => {
  const record: TutorialProgressRecord = {
    status: 'in_progress',
    stepIndex: 2,
    startedAt: AT,
    completedAt: null,
    lastSeenAt: AT,
  };
  const next = applyTutorialEvent(record, { type: 'start' }, 4, LATER);
  assert.equal(next.stepIndex, 2);
  assert.equal(next.startedAt, AT, 'startedAt is preserved, not reset to now');
  assert.equal(next.lastSeenAt, LATER);
});

test('tutorial engine: start on a completed record stays completed (never rewinds a finished lesson)', () => {
  const record: TutorialProgressRecord = {
    status: 'completed',
    stepIndex: 3,
    startedAt: AT,
    completedAt: AT,
    lastSeenAt: AT,
  };
  const next = applyTutorialEvent(record, { type: 'start' }, 4, LATER);
  assert.equal(next.status, 'completed');
  assert.equal(next.completedAt, AT);
});

test('tutorial engine: advance steps forward and stays in_progress before the last step', () => {
  const record: TutorialProgressRecord = {
    status: 'in_progress',
    stepIndex: 0,
    startedAt: AT,
    completedAt: null,
    lastSeenAt: AT,
  };
  const next = applyTutorialEvent(record, { type: 'advance' }, 4, LATER);
  assert.equal(next.status, 'in_progress');
  assert.equal(next.stepIndex, 1);
  assert.equal(next.completedAt, null);
});

test('tutorial engine: advance off the last step completes the lesson and clamps stepIndex', () => {
  const record: TutorialProgressRecord = {
    status: 'in_progress',
    stepIndex: 3,
    startedAt: AT,
    completedAt: null,
    lastSeenAt: AT,
  };
  const next = applyTutorialEvent(record, { type: 'advance' }, 4, LATER);
  assert.equal(next.status, 'completed');
  assert.equal(next.stepIndex, 3, 'clamped to the last valid index, never overshoots');
  assert.equal(next.completedAt, LATER);
});

test('tutorial engine: advance on a null record with totalSteps=1 completes immediately', () => {
  const next = applyTutorialEvent(null, { type: 'advance' }, 1, AT);
  assert.equal(next.status, 'completed');
  assert.equal(next.stepIndex, 0);
});

test('tutorial engine: dismiss closes the runner without finishing', () => {
  const record: TutorialProgressRecord = {
    status: 'in_progress',
    stepIndex: 1,
    startedAt: AT,
    completedAt: null,
    lastSeenAt: AT,
  };
  const next = applyTutorialEvent(record, { type: 'dismiss' }, 4, LATER);
  assert.equal(next.status, 'dismissed');
  assert.equal(next.stepIndex, 1, 'step position is preserved so a later start resumes here');
});

test('tutorial engine: dismiss never demotes a completed lesson', () => {
  const record: TutorialProgressRecord = {
    status: 'completed',
    stepIndex: 3,
    startedAt: AT,
    completedAt: AT,
    lastSeenAt: AT,
  };
  const next = applyTutorialEvent(record, { type: 'dismiss' }, 4, LATER);
  assert.equal(next.status, 'completed');
});

test('tutorial engine: restart always rewinds to step 0 and clears completedAt, even from completed', () => {
  const record: TutorialProgressRecord = {
    status: 'completed',
    stepIndex: 3,
    startedAt: AT,
    completedAt: AT,
    lastSeenAt: AT,
  };
  const next = applyTutorialEvent(record, { type: 'restart' }, 4, LATER);
  assert.equal(next.status, 'in_progress');
  assert.equal(next.stepIndex, 0);
  assert.equal(next.completedAt, null);
  assert.equal(next.startedAt, LATER);
});

test('tutorial engine: seen on a null record creates a not_started row (welcome-prompt "maybe later")', () => {
  const next = applyTutorialEvent(null, { type: 'seen' }, 4, AT);
  assert.equal(next.status, 'not_started');
  assert.equal(next.stepIndex, 0);
  assert.equal(next.lastSeenAt, AT);
});

test('tutorial engine: seen on an existing record only stamps lastSeenAt', () => {
  const record: TutorialProgressRecord = {
    status: 'in_progress',
    stepIndex: 2,
    startedAt: AT,
    completedAt: null,
    lastSeenAt: AT,
  };
  const next = applyTutorialEvent(record, { type: 'seen' }, 4, LATER);
  assert.equal(next.status, 'in_progress');
  assert.equal(next.stepIndex, 2);
  assert.equal(next.lastSeenAt, LATER);
});
