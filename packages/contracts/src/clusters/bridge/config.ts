/**
 * Bridge connector self-service config (`PUT /v1/bridge/config`, backend/api/src/bridge/
 * bridge.controller.ts + config-admin.service.ts) — mirrors ALEMBIC's own connector console:
 * an admin sets the outbound webhook URL and rotates the shared HMAC secret, no `.env`, no
 * redeploy.
 *
 * Security review R1 #4: this endpoint had NO zod validation at all, and `webhookUrl` was
 * passed straight through with no scheme/host checks — an admin (or anyone who can reach the
 * admin route) could point the outbound webhook at an internal address and get RawProd's own
 * server to make requests to it (SSRF). `configureBridgeRequest` requires `https://` and
 * refuses a webhookUrl whose host resolves, syntactically, to loopback, RFC1918 private,
 * link-local (including the 169.254.169.254 cloud metadata address), IPv6 loopback/ULA, or
 * `localhost` — the same category of address every cloud SSRF checklist calls out.
 *
 * This is a syntactic host check (string/IP-literal), not a DNS-resolution check — it stops the
 * obvious "point it at 127.0.0.1 / 10.x / metadata" cases, which is what this review flagged.
 * DNS-rebinding protection (resolve at request time, not at config time) is a runtime-fetch
 * concern for whatever eventually calls this webhookUrl, not this validation boundary.
 *
 * GOLDEN JOURNEY FINDING (release/journey/GOLDEN_JOURNEY_EVIDENCE.md gap #3): a syntactic,
 * unconditional refusal of every private/loopback host also refuses the one pairing this bridge
 * exists for when ALEMBIC and RawProd share a VPC or a docker-compose network — "factory
 * ALEMBIC" is a private host BY DESIGN in that topology, and there was no way for an operator to
 * say so. `BRIDGE_WEBHOOK_ALLOWED_HOSTS` (deploy env, comma/whitespace-separated `host[:port]`
 * entries, exact string match, no wildcard, no subnet, no DNS resolution) lets an admin name
 * the specific private endpoints they have actually provisioned and trust, without opening
 * every private address. It does NOT cover link-local/cloud-metadata addresses
 * (169.254.0.0/16, fe80::/10) — see `isLinkLocalOrMetadataHost`'s own doc for why that range is
 * excluded even from an explicit allow-list entry naming it.
 */
import { z } from "zod";

type WebhookHostRisk = "safe" | "loopback" | "private" | "link_local" | "localhost_name";

/** Single classifier so the IPv4/IPv6/IPv4-mapped decoding logic exists in exactly one place —
 *  `isUnsafeWebhookHost` and `isLinkLocalOrMetadataHost` are both thin views over it. Syntactic
 *  checks only (no DNS resolution). Case-insensitive; brackets/zone-id stripped for IPv6
 *  literals as `new URL(...).hostname` supplies them. */
function classifyWebhookHost(hostname: string): WebhookHostRisk {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (host === "localhost" || host === "localhost.localdomain") return "localhost_name";

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return "private"; // malformed → refuse, don't guess
    if (a === 127) return "loopback"; // loopback 127.0.0.0/8
    if (a === 10) return "private"; // RFC1918 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return "private"; // RFC1918 172.16.0.0/12
    if (a === 192 && b === 168) return "private"; // RFC1918 192.168.0.0/16
    if (a === 169 && b === 254) return "link_local"; // link-local 169.254.0.0/16 (covers the metadata IP)
    if (a === 0) return "private"; // "this network" 0.0.0.0/8
    return "safe";
  }

  if (host.includes(":")) {
    // IPv6 literal. Strip a zone id (%eth0) and an IPv4-mapped suffix if present.
    const zoneless = host.split("%")[0]!;
    if (zoneless === "::1" || zoneless === "::") return "loopback"; // loopback / unspecified
    if (zoneless.startsWith("fe80:")) return "link_local"; // link-local fe80::/10
    if (/^f[cd][0-9a-f]{0,2}:/.test(zoneless)) return "private"; // ULA fc00::/7 (fc.. / fd..)
    // IPv4-mapped IPv6, textual form (::ffff:127.0.0.1).
    const mapped = zoneless.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return classifyWebhookHost(mapped[1]!);
    // IPv4-mapped IPv6, the hex form the WHATWG URL parser normalizes to (::ffff:7f00:1 for
    // 127.0.0.1) — decode the last 32 bits back to four octets and recheck.
    const mappedHex = zoneless.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1]!, 16);
      const lo = parseInt(mappedHex[2]!, 16);
      const octets = [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
      return classifyWebhookHost(octets.join("."));
    }
    return "safe";
  }

  return "safe";
}

/** True for a hostname that is loopback, RFC1918 private, link-local, or otherwise internal —
 *  syntactic checks only (no DNS resolution). This is the "would normally be refused" set;
 *  whether it is ACTUALLY refused also depends on `BRIDGE_WEBHOOK_ALLOWED_HOSTS` below. */
export function isUnsafeWebhookHost(hostname: string): boolean {
  return classifyWebhookHost(hostname) !== "safe";
}

/** True for loopback only (127.0.0.0/8, ::1, localhost) — the one category where plain
 *  http:// may be admitted, and only when also explicitly allow-listed. */
export function isLoopbackWebhookHost(hostname: string): boolean {
  const risk = classifyWebhookHost(hostname);
  return risk === "loopback" || risk === "localhost_name";
}

/** True only for the link-local range (169.254.0.0/16 — which contains 169.254.169.254, the
 *  AWS/GCP/Azure instance-metadata address — and its IPv6 counterpart fe80::/10). Deliberately
 *  NEVER allow-listable: every other category this file refuses (loopback, RFC1918, localhost)
 *  has a legitimate same-VPC pairing use case, which is what `BRIDGE_WEBHOOK_ALLOWED_HOSTS`
 *  exists to unblock — link-local does not. An admin allow-listing it would not be pairing with
 *  a factory ALEMBIC; they would be pointing RawProd's own outbound request at the cloud
 *  metadata service, which is exactly the credential-theft SSRF shape this whole file exists to
 *  stop. So this range is excluded from the allow-list check entirely, not merely absent from
 *  anyone's list by convention. */
export function isLinkLocalOrMetadataHost(hostname: string): boolean {
  return classifyWebhookHost(hostname) === "link_local";
}

/** Parses `BRIDGE_WEBHOOK_ALLOWED_HOSTS` (deploy env — see this file's header) into an exact
 *  `host[:port]` allow-list: comma- or whitespace-separated, case-insensitive, no wildcard, no
 *  subnet, no DNS resolution — listing one host never widens to a range. Absent or empty means
 *  no private host is allow-listed, which is the safe default every deployment gets with no
 *  env file to maintain (identical posture to today, before this variable existed). */
export function parseAllowedWebhookHosts(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? "")
      .split(/[,\s]+/)
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Whether `url` is one of the operator's explicitly allow-listed private endpoints.
 *  `url.host` is `hostname` or `hostname:port` exactly as the WHATWG URL parser renders it —
 *  it omits the port when it is the scheme's default (this schema requires `https:`, so a
 *  webhookUrl written as `https://host:443/...` and one written as `https://host/...` both
 *  match an allow-list entry of `host` with no port). A listed entry that DOES carry a port
 *  matches only that exact port; it is deliberately not treated as also matching the bare
 *  hostname on a different port. Link-local/metadata hosts are refused unconditionally — see
 *  `isLinkLocalOrMetadataHost`. */
export function isAllowlistedWebhookHost(url: URL, allowed: ReadonlySet<string>): boolean {
  if (isLinkLocalOrMetadataHost(url.hostname)) return false;
  return allowed.has(url.host.toLowerCase());
}

/** Reads `BRIDGE_WEBHOOK_ALLOWED_HOSTS` off `process.env` WITHOUT this package depending on
 *  `@types/node` — `packages/contracts` is imported by `web/feature-auth` too, whose tsconfig
 *  carries no Node lib/types, and a direct `process.env` reference here type-checked fine for
 *  THIS package but broke THAT one's build (an ambient `process` it never declared). `globalThis`
 *  is always resolvable and untyped, so the cast below names only the one shape this file reads;
 *  runtime behaviour in the one place this ever actually executes (backend/api, on Node) is
 *  unchanged — `globalThis.process` IS `process` there. */
function readAllowedHostsEnv(): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.BRIDGE_WEBHOOK_ALLOWED_HOSTS;
}

const safeWebhookUrl = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "webhookUrl must be a valid absolute URL" });
      return;
    }
    const allowed = parseAllowedWebhookHosts(readAllowedHostsEnv());
    /* Plain http:// is admitted in exactly ONE case: a LOOPBACK host (127.0.0.0/8, ::1,
     * localhost) that the operator has explicitly listed in BRIDGE_WEBHOOK_ALLOWED_HOSTS.
     * Loopback traffic never leaves the machine, so TLS protects nothing there, and this is
     * the only way a same-host pairing (local/CI, or both services behind one box's reverse
     * proxy) can configure the reverse bridge direction at all — the lane/w1 allow-list
     * alone could not, because this scheme check refused it first. RFC1918/public hosts
     * still require https:// even when allow-listed: that traffic crosses a network. */
    const loopbackAllowlisted = isLoopbackWebhookHost(url.hostname)
      && isAllowlistedWebhookHost(url, allowed);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopbackAllowlisted)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "webhookUrl must use https://" });
    }
    if (isUnsafeWebhookHost(url.hostname)) {
      if (!isAllowlistedWebhookHost(url, allowed)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "webhookUrl host is not allowed (loopback, private/RFC1918, link-local/metadata, or "
            + "localhost addresses are refused unless the exact host[:port] is listed in "
            + "BRIDGE_WEBHOOK_ALLOWED_HOSTS — the link-local/cloud-metadata range "
            + "169.254.0.0/16 can never be allow-listed)",
        });
      }
    }
  });

/** `PUT /v1/bridge/config` body. */
export const configureBridgeRequest = z.object({
  enabled: z.boolean().optional(),
  webhookUrl: safeWebhookUrl.optional(),
  hmacSecret: z.string().min(16).optional(),
});

export type ConfigureBridgeRequest = z.infer<typeof configureBridgeRequest>;
