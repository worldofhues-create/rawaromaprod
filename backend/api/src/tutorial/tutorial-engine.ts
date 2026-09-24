/**
 * TutorialEngine — pure reducer for one (user, track, lesson) progress row, ported from
 * ALEMBIC's `packages/domain/src/tutorial/engine.ts` (`applyTutorialEvent(progress, event, at)`,
 * handling `start|advance|dismiss|restart|seen`). No I/O, no DB — TutorialService is the only
 * caller, and reads/writes the persisted row around this function; kept separate (and covered
 * by its own unit tests, `__tests__/tutorial-engine.test.ts`) so the state-transition rules can
 * be verified without a database.
 *
 * `totalSteps` is always the CALLER's server-side lesson-registry value (TutorialService reads
 * it off `TUTORIAL_LESSONS`, never off client input) — see tutorial.service.ts's own comment on
 * why `tutorialVersion`/step counts are never trusted from the request body.
 */

export type TutorialProgressStatus = 'not_started' | 'in_progress' | 'completed' | 'dismissed';

export interface TutorialProgressRecord {
  status: TutorialProgressStatus;
  stepIndex: number;
  startedAt: Date | null;
  completedAt: Date | null;
  lastSeenAt: Date | null;
}

export type TutorialEventType = 'start' | 'advance' | 'dismiss' | 'restart' | 'seen';

export interface TutorialEvent {
  type: TutorialEventType;
}

const EMPTY_RECORD: TutorialProgressRecord = {
  status: 'not_started',
  stepIndex: 0,
  startedAt: null,
  completedAt: null,
  lastSeenAt: null,
};

/**
 * Applies one lifecycle event to a progress record (or `null` — no row exists yet, i.e. the
 * lesson has never been started/seen by this user for this track) and returns the NEXT record
 * to persist. Pure: same inputs always produce the same output.
 *
 *   start   — begins (or idempotently resumes) the lesson. A `completed` lesson stays
 *             `completed` (starting again is `restart`, not `start`) — mirrors ALEMBIC's own
 *             "start resumes, never rewinds a finished lesson" rule.
 *   advance — moves to the next step; reaching (or passing) the last step marks `completed`
 *             and stamps `completedAt`. Clamped so an out-of-range advance can't overshoot.
 *   dismiss — closes the runner without finishing. Never demotes a `completed` lesson.
 *   restart — always rewinds to step 0 and clears `completedAt`, regardless of prior status —
 *             the one event that DOES rewind a finished lesson (explicit user choice, unlike
 *             `start`).
 *   seen    — no status/step change; only stamps `lastSeenAt`. Used for the "maybe later" reply
 *             to the welcome prompt: it still creates a persisted row (status stays
 *             `not_started`) so the prompt satisfies ALEMBIC's own "no progress row of any
 *             status yet" gate and does not re-appear on the next page load.
 */
export function applyTutorialEvent(
  record: TutorialProgressRecord | null,
  event: TutorialEvent,
  totalSteps: number,
  at: Date,
): TutorialProgressRecord {
  const base = record ?? EMPTY_RECORD;
  const lastStepIndex = Math.max(totalSteps - 1, 0);

  switch (event.type) {
    case 'start':
      return {
        status: base.status === 'completed' ? base.status : 'in_progress',
        stepIndex: Math.min(base.stepIndex, lastStepIndex),
        startedAt: base.startedAt ?? at,
        completedAt: base.completedAt,
        lastSeenAt: at,
      };

    case 'advance': {
      const nextIndex = Math.min(base.stepIndex + 1, lastStepIndex);
      const isDone = base.stepIndex + 1 >= totalSteps;
      return {
        status: isDone ? 'completed' : 'in_progress',
        stepIndex: nextIndex,
        startedAt: base.startedAt ?? at,
        completedAt: isDone ? at : base.completedAt,
        lastSeenAt: at,
      };
    }

    case 'dismiss':
      return {
        ...base,
        status: base.status === 'completed' ? base.status : 'dismissed',
        lastSeenAt: at,
      };

    case 'restart':
      return {
        status: 'in_progress',
        stepIndex: 0,
        startedAt: at,
        completedAt: null,
        lastSeenAt: at,
      };

    case 'seen':
      return { ...base, lastSeenAt: at };

    default:
      return { ...base, lastSeenAt: at };
  }
}
