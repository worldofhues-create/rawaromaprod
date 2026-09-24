/**
 * tutorial cluster DTOs — the single write body `POST /v1/tutorial/progress/:lessonId` accepts.
 */
import { z } from 'zod';

export const tutorialEventBody = z.object({
  /** the tutorial TRACK this progress write is against (see tutorial-lessons.ts
   * TUTORIAL_TRACKS) — validated server-side against both the lesson's own `track` and the
   * caller's `reachableTutorialTracks(principal.roles)`. */
  role: z.string().min(1),
  event: z.object({
    type: z.enum(['start', 'advance', 'dismiss', 'restart', 'seen']),
    /**
     * The client's cached lesson version, if it has one. Purely a staleness check — never used
     * to compute `totalSteps`/`version`, which TutorialService always reads off the server-side
     * registry. Omitted (e.g. the very first `start`) skips the staleness check.
     */
    tutorialVersion: z.number().int().positive().optional(),
  }),
});
export type TutorialEventBody = z.infer<typeof tutorialEventBody>;
