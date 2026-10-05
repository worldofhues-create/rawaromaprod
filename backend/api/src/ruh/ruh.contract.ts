/**
 * Always-on Ruh — the shapes and pure rules every Ruh piece on this box shares (owner rulings
 * 2026-10-06; cross-lane contract C1/C3/C4).
 *
 *   Insight     what Ruh noticed or predicted (C1's shape, held locally): kind, severity, the
 *               RawProd ROLES it is for, the console + deep link that open the record, an optional
 *               prediction with its basis, and a dedupe key (one open insight per key).
 *   Risk        one reason a guarded action deserves a second look (C4). A risk never blocks: the
 *               same request with a typed reason (≥ 8 characters) goes through, and every such
 *               override alerts the admins (C3 `override`, which ALEMBIC emails).
 *   C3 signal   an insight as ALEMBIC receives it: absolute https deep link, ALEMBIC roles.
 *
 * Words on screen are operator words. Nothing here ever carries formula content: a Vault insight is
 * a count (vaultSafe() refuses anything else before it leaves this box).
 */
export const RUH_SEVERITIES = ['info', 'suggest', 'warn', 'urgent'] as const;
export type RuhSeverity = (typeof RUH_SEVERITIES)[number];
export const SEVERITY_RANK: Readonly<Record<RuhSeverity, number>> = { info: 0, suggest: 1, warn: 2, urgent: 3 };

export const RUH_CONSOLES = ['factory', 'platform', 'vault'] as const;
export type RuhConsole = (typeof RUH_CONSOLES)[number];

export const RUH_STATUSES = ['open', 'snoozed', 'done', 'dismissed'] as const;
export type RuhStatus = (typeof RUH_STATUSES)[number];

/** A typed reason is required to continue past a Ruh warning, at least this long (C4). */
export const RUH_REASON_MIN = 8;
export const RUH_REASON_MAX = 1000;

/** Who sees every insight regardless of audience (as the produce alert feed). */
export const SEES_ALL_ROLES = ['owner', 'super_admin'];
/** Who hears about every override (owner ruling: "every override alerts admins"). */
export const OVERRIDE_AUDIENCE = ['owner', 'admin'];

export interface RuhSubject {
  type: string;
  id?: string | null;
  code?: string | null;
}

export interface RuhPrediction {
  metric: string;
  value: string | number;
  unit: string;
  /** When the prediction was made (ISO). */
  at: string;
  /** 0..1 — how much history the number rests on. */
  confidence: number;
  /** Plain words: what the number was worked out from. */
  basis: string;
}

export interface InsightDraft {
  kind: string;
  severity: RuhSeverity;
  audienceRoles: string[];
  console: RuhConsole;
  subject: RuhSubject;
  title: string;
  body: string;
  /** In-console link: Factory `#/go/<section>[/<record id>]`, Platform/Vault `#/<section>`. */
  deepLink: string | null;
  prediction?: RuhPrediction | null;
  dedupeKey: string;
  /** Mirror to ALEMBIC as a C3 signal (and resolve it there when cleared). */
  mirror: boolean;
}

export interface Risk {
  code: string;
  title: string;
  detail: string;
  severity: RuhSeverity;
}

export interface RuhOverrideBody {
  reason: string;
}

/** The person's typed reason from a request body, or null; never throws. */
export function readOverride(body: unknown): { reason: string } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const o = (body as Record<string, unknown>).ruhOverride;
  if (!o || typeof o !== 'object') return null;
  const reason = (o as Record<string, unknown>).reason;
  if (typeof reason !== 'string') return null;
  return { reason: reason.trim().slice(0, RUH_REASON_MAX) };
}

export function reasonOk(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && reason.trim().length >= RUH_REASON_MIN;
}

/** Highest severity among the risks (info when none). */
export function topSeverity(risks: readonly { severity: RuhSeverity }[]): RuhSeverity {
  let best: RuhSeverity = 'info';
  for (const r of risks) if (SEVERITY_RANK[r.severity] > SEVERITY_RANK[best]) best = r.severity;
  return best;
}

/* ── ALEMBIC side ─────────────────────────────────────────────────────────────────────── */

export const ALEMBIC_ROLES = ['admin', 'ops', 'dispatch'] as const;
export type AlembicRole = (typeof ALEMBIC_ROLES)[number];

/** RawProd role → the ALEMBIC role that looks after the same thing. */
const ROLE_MAP: Readonly<Record<string, AlembicRole>> = {
  owner: 'admin', admin: 'admin', platform_super_admin: 'admin', super_admin: 'admin',
  production: 'ops', compounding: 'ops', filling: 'ops', packaging: 'ops', qc: 'ops', warehouse: 'ops',
  receiving: 'ops', procurement: 'ops', formulator: 'ops', vault_approver: 'ops',
  sales: 'dispatch',
};

export function alembicRolesFor(roles: readonly string[]): AlembicRole[] {
  const out = new Set<AlembicRole>();
  for (const r of roles) { const a = ROLE_MAP[r]; if (a) out.add(a); }
  // An insight always reaches someone on the ALEMBIC side.
  if (out.size === 0) out.add('admin');
  return ALEMBIC_ROLES.filter((r) => out.has(r));
}

export interface ConsoleLinks {
  factory: string | null;
  platform: string | null;
  vault: string | null;
}

/** An https origin (no path), or null. */
export function cleanOrigin(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** The absolute https link that opens the record in its console, or null when its origin is unknown. */
export function absoluteLink(console: RuhConsole, deepLink: string | null, links: ConsoleLinks): string | null {
  const origin = links[console];
  if (!origin) return null;
  const path = deepLink && deepLink.startsWith('#') ? `/${deepLink}` : deepLink && deepLink.startsWith('/') ? deepLink : '/';
  return `${origin}${path}`;
}

export interface C3Override {
  actorEmail: string | null;
  action: string;
  reason: string;
  risks: Array<{ code: string; title: string; detail: string }>;
}

export interface C3Signal {
  kind: string;
  severity: RuhSeverity;
  title: string;
  body: string;
  dedupeKey: string;
  deepLink?: string;
  audienceRoles: AlembicRole[];
  prediction?: RuhPrediction;
  override?: C3Override;
}

export function toC3Signal(i: Pick<InsightDraft, 'kind' | 'severity' | 'title' | 'body' | 'dedupeKey' | 'audienceRoles' | 'console' | 'deepLink' | 'prediction'>,
  links: ConsoleLinks, override?: C3Override): C3Signal {
  const href = absoluteLink(i.console, i.deepLink, links);
  const s: C3Signal = {
    kind: i.kind,
    severity: i.severity,
    title: i.title,
    body: i.body,
    dedupeKey: i.dedupeKey,
    audienceRoles: override ? ['admin'] : alembicRolesFor(i.audienceRoles),
    ...(href ? { deepLink: href } : {}),
    ...(i.prediction ? { prediction: i.prediction } : {}),
    ...(override ? { override } : {}),
  };
  if (i.console === 'vault') vaultSafe(s);
  return s;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * A Vault-side signal leaves this box as counts and fixed words only: no id, no code, no name.
 * Throws (the caller drops the signal) when a Vault insight carries anything that could identify a
 * formula — the guard for "Ruh never sees or transmits formula content".
 */
export function vaultSafe(s: C3Signal): C3Signal {
  const text = [s.title, s.body, s.override?.reason ?? '', ...(s.override?.risks ?? []).flatMap((r) => [r.title, r.detail])].join(' \n ');
  if (UUID_RE.test(text)) throw new Error('vault signal carries an identifier');
  if (/\b(formula|recipe)\s+(code|name)\b|\bFRM-|\bF-\d{3,}/i.test(text)) throw new Error('vault signal names a formula');
  if (/%/.test(text) || /\b(ingredient|material)s?\s+[A-Z0-9-]{3,}/.test(text)) throw new Error('vault signal carries composition');
  if (s.prediction) throw new Error('vault signal carries a prediction');
  return s;
}

/* ── small helpers ────────────────────────────────────────────────────────────────────── */

export const plural = (n: number, one: string, many?: string) => `${n} ${n === 1 ? one : (many ?? `${one}s`)}`;
export const round1 = (n: number) => Math.round(n * 10) / 10;
export const ymd = (d: Date) => d.toISOString().slice(0, 10);
export const hoursBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 3_600_000;
