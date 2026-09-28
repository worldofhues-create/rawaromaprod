/**
 * AuthController — `/auth/login` (public), `/auth/users/:id/password` (admin), `/me`.
 * Login is the dictionary-backed replacement for the generic @core identity auth: it
 * authenticates against USER_MASTER and mints the JWT the edge guards consume.
 */
import { Body, Controller, Get, Param, Post, Req } from "@nestjs/common";
import {
  CurrentUser,
  Permissions,
  Public,
  SelfService,
  ZodValidationPipe,
  type AuthPrincipal,
} from "@core/backend-kernel";
import { AuthService, type LoginResult, type SignInContext } from "./auth.service.js";
import {
  loginBody,
  refreshBody,
  setPasswordBody,
  alembicAssertionBody,
  type LoginBody,
  type RefreshBody,
  type SetPasswordBody,
  type AlembicAssertionBody,
} from "./auth.dtos.js";

/** The client address + browser a sign-in came from, for iam.login_history. `req.ip` is the
 *  client address behind the load balancer (main.ts runs Fastify with `trustProxy: true`). */
function signInContext(req: { ip?: string; headers?: Record<string, string | string[] | undefined> }): SignInContext {
  const ua = req.headers?.["user-agent"];
  return { ip: req.ip ?? null, userAgent: Array.isArray(ua) ? ua[0] ?? null : ua ?? null };
}

@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post("auth/login")
  login(
    @Body(new ZodValidationPipe(loginBody)) body: LoginBody,
    @Req() req: Parameters<typeof signInContext>[0],
  ): Promise<LoginResult> {
    return this.auth.login(body.identifier, body.password, signInContext(req));
  }

  @Public()
  @Post("auth/refresh")
  refresh(
    @Body(new ZodValidationPipe(refreshBody)) body: RefreshBody,
  ): Promise<LoginResult> {
    return this.auth.refresh(body.refreshToken);
  }

  /** PB-04 / SB-02 — the one-login identity bridge. ALEMBIC's console posts the
   *  signed assertion here (never a redirect carrying it in a URL a server would
   *  log — see that repository's `rawprod-assertion.ts` for why the browser lands
   *  with it in a fragment instead, and this app's boot script for the exchange). */
  @Public()
  @Post("auth/alembic-assertion")
  loginWithAssertion(
    @Body(new ZodValidationPipe(alembicAssertionBody)) body: AlembicAssertionBody,
    @Req() req: Parameters<typeof signInContext>[0],
  ): Promise<LoginResult> {
    return this.auth.loginWithAssertion(body.assertion, signInContext(req));
  }

  @Permissions("iam:user_master:write")
  @Post("auth/users/:id/password")
  setPassword(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(setPasswordBody)) body: SetPasswordBody,
    @CurrentUser() principal: AuthPrincipal,
  ): Promise<{ userId: string }> {
    return this.auth.setPassword(id, body.password, principal);
  }

  @SelfService()
  @Get("me")
  me(@CurrentUser() principal: AuthPrincipal): Promise<{
    userId: string;
    userName: string | null;
    email: string | null;
    roles: string[];
    permissions: string[];
  }> {
    return this.auth.me(principal);
  }
}
