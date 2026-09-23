/**
 * AuthController — `/auth/login` (public), `/auth/users/:id/password` (admin), `/me`.
 * Login is the dictionary-backed replacement for the generic @core identity auth: it
 * authenticates against USER_MASTER and mints the JWT the edge guards consume.
 */
import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import {
  CurrentUser,
  Permissions,
  Public,
  ZodValidationPipe,
  type AuthPrincipal,
} from "@core/backend-kernel";
import { AuthService, type LoginResult } from "./auth.service.js";
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

@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post("auth/login")
  login(
    @Body(new ZodValidationPipe(loginBody)) body: LoginBody,
  ): Promise<LoginResult> {
    return this.auth.login(body.identifier, body.password);
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
  ): Promise<LoginResult> {
    return this.auth.loginWithAssertion(body.assertion);
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
