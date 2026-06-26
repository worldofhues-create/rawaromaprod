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
import { loginBody, setPasswordBody, type LoginBody, type SetPasswordBody } from "./auth.dtos.js";

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

  @Permissions("iam:user:write")
  @Post("auth/users/:id/password")
  setPassword(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(setPasswordBody)) body: SetPasswordBody,
  ): Promise<{ userId: string }> {
    return this.auth.setPassword(id, body.password);
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
