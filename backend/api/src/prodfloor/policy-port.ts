/**
 * PROD-B-1 — the PolicyService seam lane B codes against (production floor plan 12.0).
 *
 * Lane A owns the rules engine (backend/api/src/policy/: PolicyService.evaluate). Until it merges,
 * lane B's callers read policy through this port, which has EXACTLY the shared contract's shape:
 *
 *   evaluate(key, ctx, at?) -> { value, ruleId, version, explain }   throws PolicyUnresolved
 *
 * so binding lane A's service to POLICY_SERVICE is the whole merge. The stub below answers with
 * the owner's published defaults only, and says so in `explain` — it never pretends a rule matched
 * (ruleId null, version 0). A key it has no default for throws PolicyUnresolved, and every caller
 * HOLDS on that rather than guessing (12.0 "Safe failure").
 */
export interface PolicyDecision {
  value: unknown;
  ruleId: string | null;
  version: number;
  explain: string;
}

export interface PolicyPort {
  evaluate(key: string, ctx: Record<string, unknown>, at?: Date): Promise<PolicyDecision> | PolicyDecision;
}

export class PolicyUnresolved extends Error {
  constructor(readonly key: string) {
    super(`No rule and no default for policy "${key}". Held until an admin sets one.`);
    this.name = 'PolicyUnresolved';
  }
}

export const POLICY_SERVICE = Symbol.for('ra.policy.service');

/** The owner's defaults (plan 12.1, 12.7, 12.8). Thresholds are basis points of quantity. */
export const PFB_POLICY_DEFAULTS: Record<string, unknown> = {
  // 12.1: PO-wide by default; short >= 20% rejects the short line(s); extra > 5% is held for purchase.
  'receiving.shortfall': { scope: 'PO', shortRejectBps: 2000, extraHoldBps: 500 },
  // 12.8: the global default pays only against what was accepted. Advance and credit come from rules.
  'procurement.payment_terms': { mode: 'AGAINST_GRN' },
  // 12.7: two reworks, cumulative adjustment within 5% of batch weight, any inspector.
  'qc.rework': { maxReworks: 2, envelopeBps: 500, differentInspector: false },
};

export class DefaultPolicyStub implements PolicyPort {
  constructor(private readonly defaults: Record<string, unknown> = PFB_POLICY_DEFAULTS) {}
  evaluate(key: string): PolicyDecision {
    if (!(key in this.defaults)) throw new PolicyUnresolved(key);
    return {
      value: structuredClone(this.defaults[key]),
      ruleId: null,
      version: 0,
      explain: 'Otherwise: the default (no rule set on the Rules screen yet)',
    };
  }
}
