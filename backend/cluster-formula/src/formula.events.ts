/**
 * formula cluster events — cross-cluster signals via the transactional outbox. Payloads
 * carry IDS ONLY: a formula/version id, never an ingredient, alias, or percentage. The vault
 * publishes WHEN a formula became usable (version approved/locked) or was duplicated; the real
 * recipe is fetched cold, audited, through the FORMULA_LOOKUP port — never broadcast.
 *
 * Downstream: production subscribes to `formula.version.approved` to allow that version to be
 * selected for a production order (23-step flow, step 12 "Formula Selection").
 */
import { z } from 'zod';
import { defineEvent, uuid } from '@core/contracts';

export const formulaEvents = {
  versionApproved: defineEvent(
    'formula.version.approved',
    z.object({ formulaId: uuid, formulaVersionId: uuid, versionNumber: z.number().int() }),
  ),
  copyApproved: defineEvent(
    'formula.copy.approved',
    z.object({ formulaCopyRequestId: uuid, sourceFormulaId: uuid, targetFormulaId: uuid }),
  ),
} as const;
