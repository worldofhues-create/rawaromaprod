/**
 * TutorialController — self-service, like ALEMBIC's own tutorial routes (and like this
 * backend's own `/me`): any authenticated staff member manages only THEIR OWN progress, so
 * every route here carries `@SelfService()` rather than a `@Permissions(...)` list. The one real
 * authorization check (which TRACK a caller may write progress against) lives in
 * `TutorialService.applyEvent`, exactly where ALEMBIC's own `reachableTutorialTracks` check
 * lives — a per-resource check the static `@Permissions` decorator can't express, which is
 * precisely what `@SelfService()` + a service-level check is for.
 */
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CurrentUser, SelfService, ZodValidationPipe, type AuthPrincipal } from '@core/backend-kernel';
import { TutorialService } from './tutorial.service.js';
import { tutorialEventBody, type TutorialEventBody } from './tutorial.dtos.js';
import type { TutorialLesson } from './tutorial-lessons.js';

@Controller('v1/tutorial')
export class TutorialController {
  constructor(private readonly tutorial: TutorialService) {}

  /** The full lesson registry — not sensitive (UI copy + already-public permission strings +
   * endpoint paths). Both consoles filter which lessons they OFFER against the caller's own
   * `can`/`hasPerm` after fetching this — see tutorial-lessons.ts's header comment. */
  @SelfService()
  @Get('lessons')
  lessons(): TutorialLesson[] {
    return this.tutorial.lessons();
  }

  @SelfService()
  @Get('progress')
  progress(@CurrentUser() principal: AuthPrincipal) {
    return this.tutorial.progress(principal);
  }

  @SelfService()
  @Post('progress/:lessonId')
  advance(
    @Param('lessonId') lessonId: string,
    @Body(new ZodValidationPipe(tutorialEventBody)) body: TutorialEventBody,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.tutorial.applyEvent(principal, lessonId, body);
  }

  /** Deletes only the caller's own rows. */
  @SelfService()
  @Post('reset')
  reset(@CurrentUser() principal: AuthPrincipal) {
    return this.tutorial.resetAll(principal);
  }
}
