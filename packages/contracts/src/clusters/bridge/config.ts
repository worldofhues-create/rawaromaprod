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
 */
import { z } from "zod";

/** True for a hostname that is loopback, RFC1918 private, link-local, or otherwise internal —
 *  syntactic checks only (no DNS resolution). Case-insensitive; brackets/zone-id stripped for
 *  IPv6 literals as `new URL(...).hostname` supplies them. */
export function isUnsafeWebhookHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (host === "localhost" || host === "localhost.localdomain") return true;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return true; // malformed → refuse, don't guess
    if (a === 127) return true; // loopback 127.0.0.0/8
    if (a === 10) return true; // RFC1918 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 172.16.0.0/12
    if (a === 192 && b === 168) return true; // RFC1918 192.168.0.0/16
    if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16 (covers the metadata IP)
    if (a === 0) return true; // "this network" 0.0.0.0/8
    return false;
  }

  if (host.includes(":")) {
    // IPv6 literal. Strip a zone id (%eth0) and an IPv4-mapped suffix if present.
    const zoneless = host.split("%")[0]!;
    if (zoneless === "::1" || zoneless === "::") return true; // loopback / unspecified
    if (zoneless.startsWith("fe80:")) return true; // link-local fe80::/10
    if (/^f[cd][0-9a-f]{0,2}:/.test(zoneless)) return true; // ULA fc00::/7 (fc.. / fd..)
    // IPv4-mapped IPv6, textual form (::ffff:127.0.0.1).
    const mapped = zoneless.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return isUnsafeWebhookHost(mapped[1]!);
    // IPv4-mapped IPv6, the hex form the WHATWG URL parser normalizes to (::ffff:7f00:1 for
    // 127.0.0.1) — decode the last 32 bits back to four octets and recheck.
    const mappedHex = zoneless.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1]!, 16);
      const lo = parseInt(mappedHex[2]!, 16);
      const octets = [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
      return isUnsafeWebhookHost(octets.join("."));
    }
    return false;
  }

  return false;
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
    if (url.protocol !== "https:") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "webhookUrl must use https://" });
    }
    if (isUnsafeWebhookHost(url.hostname)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "webhookUrl host is not allowed (loopback, private/RFC1918, link-local/metadata, or localhost addresses are refused)",
      });
    }
  });

/** `PUT /v1/bridge/config` body. */
export const configureBridgeRequest = z.object({
  enabled: z.boolean().optional(),
  webhookUrl: safeWebhookUrl.optional(),
  hmacSecret: z.string().min(16).optional(),
});

export type ConfigureBridgeRequest = z.infer<typeof configureBridgeRequest>;
