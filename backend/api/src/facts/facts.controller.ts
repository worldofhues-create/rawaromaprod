/**
 * FactsController — PB-06's RawProd Facts API edge. Read-only, server-to-server: ALEMBIC's
 * ARIA calls this over the SAME signed channel the bridge event webhook uses (HMAC over the
 * raw body, the shared secret sealed in `bridge.connector_config` — see
 * `bridge/secret-box.ts`, `bridge/signing.ts`). `@Public()` for the same reason
 * `BridgeController.receive` is: the caller is a second deployment, not a signed-in user, and
 * the signature IS the authentication.
 *
 * THE SIGNATURE PROVES THE CALLER IS ALEMBIC. IT DOES NOT PROVE THE STAFF MEMBER ON WHOSE
 * BEHALF ALEMBIC IS ASKING MAY SEE THIS FACT. That is re-checked here, against RawProd's own
 * role→permission mapping (`FactsService.permissionsForRoles`), from the `caller.roles`
 * ALEMBIC attached to the body — never from anything ALEMBIC believes about its own actor.
 * A caller whose roles hold nothing in `FACT_KIND_PERMISSION[factKind]` gets FORBIDDEN.
 *
 * `@Body() _parsed` is unused on purpose: like `BridgeController.receive`, this route signs
 * over the exact raw bytes (`req.rawBody`, populated by main.ts's content-type parser), and
 * re-parses those same bytes below rather than trusting Nest's already-parsed copy — a
 * re-serialization can differ byte-for-byte from what was signed.
 */
import { Body, Controller, Headers, Post, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Public } from "@core/backend-kernel";
import { FactsService } from "./facts.service.js";
import {
  FACT_KIND_PERMISSION, isKnownFactKind, isNeverResolvable, validateFactsQueryBody,
} from "./facts.contract.js";

@Controller()
export class FactsController {
  constructor(private readonly facts: FactsService) {}

  @Public()
  @Post("v1/bridge/facts/query")
  async query(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() _parsed: unknown,
    @Headers("x-bridge-signature") signature: string | undefined,
  ): Promise<Record<string, unknown>> {
    const rawBody = (req as unknown as { rawBody?: string }).rawBody ?? "";

    const signed = await this.facts.verifySignature(rawBody, signature ?? null);
    if (!signed) {
      reply.status(401);
      return { ok: false, reason: "unauthenticated" };
    }

    let parsed: unknown;
    try {
      parsed = rawBody.length ? JSON.parse(rawBody) : {};
    } catch {
      reply.status(400);
      return { ok: false, reason: "bad_request", problems: ["bad_params"] };
    }

    const validation = validateFactsQueryBody(parsed);
    if (!validation.ok) {
      reply.status(400);
      return { ok: false, reason: "bad_request", problems: validation.problems };
    }
    const { factKind, params, caller } = validation.body;

    // Belt-and-braces refusal FIRST, before the allow-list lookup even runs: a kind that
    // merely looks formula/vault-shaped never reaches `isKnownFactKind`.
    if (isNeverResolvable(factKind)) {
      reply.status(403);
      return forbiddenVaultBoundary();
    }
    if (!isKnownFactKind(factKind)) {
      reply.status(403);
      return {
        ok: false, reason: "forbidden",
        boundary: `'${factKind}' is not a fact ARIA may resolve.`,
        permittedNextAction: "ask for one of the published fact kinds "
          + "(production requirement status, material availability, PO/GRN status, "
          + "QC status, FG/ATP, dispatch status)",
      };
    }

    const held = await this.facts.permissionsForRoles(caller.roles);
    const required = FACT_KIND_PERMISSION[factKind];
    if (!held.has(required)) {
      reply.status(403);
      return {
        ok: false, reason: "forbidden",
        boundary: `The caller's RawProd roles do not hold '${required}'.`,
        permittedNextAction: "ask an administrator to grant a RawProd role that holds "
          + "this permission",
      };
    }

    const data = await this.facts.resolve(factKind, params);
    if (data === null) {
      reply.status(404);
      return { ok: false, reason: "not_found" };
    }
    return { ok: true, factKind, data };
  }
}

function forbiddenVaultBoundary(): Record<string, unknown> {
  return {
    ok: false,
    reason: "forbidden",
    boundary: "Formula composition and Vault-protected material identity are never "
      + "resolvable by ARIA, whatever the caller's permissions.",
    permittedNextAction: "view the coded manufacturing instruction (production/compounding) "
      + "or request Vault access via a vault_approver",
  };
}
