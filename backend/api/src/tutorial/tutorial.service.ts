/**
 * TutorialService — persistence + authorization for the tutorial engine (ticket G4). Raw SQL
 * over the shared `PG_CLIENT` pool (same pattern as `platform-ops.service.ts` — no dedicated
 * Drizzle schema package for a single small table), against `platform.tutorial_progress`
 * (scripts/migrations/2026-09-24-tutorial-system.sql).
 *
 * `totalSteps`/`version` are ALWAYS resolved here, off `TUTORIAL_LESSONS` (the server-side
 * registry) — never trusted from the client. A client-supplied `tutorialVersion` is used ONLY as
 * a staleness check: if it disagrees with the registry's current version for that lesson, the
 * write is rejected with 409 `TUTORIAL_STALE_VERSION` rather than silently applied against
 * step content the client's UI may no longer match (mirrors ALEMBIC's
 * `StaleTutorialVersion`/409).
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sql } from 'postgres';
import { DomainError, PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import { asDate, isoOf } from '../pg-timestamp.js';
import { applyTutorialEvent, type TutorialProgressRecord } from './tutorial-engine.js';
import {
  TUTORIAL_LESSONS,
  getLesson,
  reachableTutorialTracks,
  type TutorialLesson,
} from './tutorial-lessons.js';
import type { TutorialEventBody } from './tutorial.dtos.js';

export interface TutorialProgressDto {
  lessonId: string;
  role: string;
  status: TutorialProgressRecord['status'];
  stepIndex: number;
  totalSteps: number;
  tutorialVersion: number;
  startedAt: string | null;
  completedAt: string | null;
  lastSeenAt: string | null;
}

/** Timestamps are `Date | string`: on the API's Drizzle-wrapped PG_CLIENT they arrive as text (pg-timestamp.ts). */
interface ProgressRow {
  lesson_id: string;
  role: string;
  status: TutorialProgressRecord['status'];
  step_index: number;
  tutorial_version: number;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  last_seen_at: Date | string | null;
}

/** A timestamp as bound to the insert: ISO text, never a JS Date (which the Drizzle-wrapped pool cannot serialize). */
const bindTs = (v: Date | null): string | null => (v ? isoOf(v) : null);

function toDto(row: ProgressRow, lesson: TutorialLesson | undefined): TutorialProgressDto {
  return {
    lessonId: row.lesson_id,
    role: row.role,
    status: row.status,
    stepIndex: row.step_index,
    // Always the REGISTRY's current step count/version, not whatever was last persisted — a
    // lesson whose content grew since this row was written reports the new totalSteps
    // immediately (the row's own `tutorial_version` only matters for the staleness check on a
    // WRITE, see applyEvent below).
    totalSteps: lesson ? lesson.steps.length : 0,
    tutorialVersion: lesson ? lesson.version : row.tutorial_version,
    startedAt: row.started_at ? isoOf(row.started_at) : null,
    completedAt: row.completed_at ? isoOf(row.completed_at) : null,
    lastSeenAt: row.last_seen_at ? isoOf(row.last_seen_at) : null,
  };
}

@Injectable()
export class TutorialService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  /** The full lesson registry, JSON-serializable as-is — see tutorial-lessons.ts's header on why
   * the browser fetches this instead of statically importing it. Not filtered by permission
   * here: the content is not sensitive (UI copy + already-public permission strings + endpoint
   * paths), and the fine-grained hide-the-whole-lesson gate is the CLIENT's job (both
   * web/tutorial.js and web-platform/platform.js do this against their own session's `can`/
   * `hasPerm`) — see tutorial-lessons.ts's header comment for why. */
  lessons(): TutorialLesson[] {
    return TUTORIAL_LESSONS;
  }

  async progress(principal: AuthPrincipal): Promise<TutorialProgressDto[]> {
    const rows = await this.sql<ProgressRow[]>`
      select lesson_id, role, status, step_index, tutorial_version, started_at, completed_at, last_seen_at
      from platform.tutorial_progress
      where user_id = ${principal.userId}
      order by lesson_id, role
    `;
    return rows.map((row) => toDto(row, getLesson(row.lesson_id)));
  }

  async applyEvent(
    principal: AuthPrincipal,
    lessonId: string,
    body: TutorialEventBody,
  ): Promise<TutorialProgressDto> {
    const lesson = getLesson(lessonId);
    if (!lesson) {
      throw DomainError.notFound(`Unknown tutorial lesson '${lessonId}'`);
    }
    if (lesson.track !== body.role) {
      throw DomainError.forbidden(
        'AUTH_FORBIDDEN',
        `Lesson '${lessonId}' is not on the '${body.role}' tutorial track`,
      );
    }
    const reachable = reachableTutorialTracks(principal.roles);
    if (!reachable.includes(lesson.track)) {
      throw DomainError.forbidden(
        'AUTH_FORBIDDEN',
        `Your role assignment does not reach the '${lesson.track}' tutorial track`,
      );
    }
    if (
      body.event.tutorialVersion !== undefined &&
      body.event.tutorialVersion !== lesson.version
    ) {
      throw new DomainError(
        'TUTORIAL_STALE_VERSION',
        'This tutorial has changed since you started it — restart to see the current steps.',
        409,
      );
    }

    const existingRows = await this.sql<
      Pick<ProgressRow, 'status' | 'step_index' | 'started_at' | 'completed_at' | 'last_seen_at'>[]
    >`
      select status, step_index, started_at, completed_at, last_seen_at
      from platform.tutorial_progress
      where user_id = ${principal.userId} and role = ${body.role} and lesson_id = ${lessonId}
      limit 1
    `;
    const existing = existingRows[0];
    const current: TutorialProgressRecord | null = existing
      ? {
          status: existing.status,
          stepIndex: existing.step_index,
          startedAt: asDate(existing.started_at),
          completedAt: asDate(existing.completed_at),
          lastSeenAt: asDate(existing.last_seen_at),
        }
      : null;

    const now = new Date();
    const next = applyTutorialEvent(current, body.event, lesson.steps.length, now);

    const upserted = await this.sql<ProgressRow[]>`
      insert into platform.tutorial_progress
        (user_id, role, lesson_id, status, step_index, tutorial_version, started_at, completed_at, last_seen_at, created_by, updated_by)
      values
        (${principal.userId}, ${body.role}, ${lessonId}, ${next.status}, ${next.stepIndex}, ${lesson.version},
         ${bindTs(next.startedAt)}, ${bindTs(next.completedAt)}, ${bindTs(next.lastSeenAt)}, ${principal.userId}, ${principal.userId})
      on conflict (user_id, role, lesson_id) do update set
        status = excluded.status,
        step_index = excluded.step_index,
        tutorial_version = excluded.tutorial_version,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        last_seen_at = excluded.last_seen_at,
        updated_dt = now(),
        updated_by = excluded.updated_by
      returning lesson_id, role, status, step_index, tutorial_version, started_at, completed_at, last_seen_at
    `;
    const row = upserted[0];
    if (!row) throw new Error('upsert failed: platform.tutorial_progress');
    return toDto(row, lesson);
  }

  /** Deletes only the CALLER's own rows — never another user's (mirrors ALEMBIC's
   * `POST /api/v1/tutorial/reset`). */
  async resetAll(principal: AuthPrincipal): Promise<{ deleted: number }> {
    const result = await this.sql`
      delete from platform.tutorial_progress where user_id = ${principal.userId}
    `;
    return { deleted: result.count ?? 0 };
  }
}
