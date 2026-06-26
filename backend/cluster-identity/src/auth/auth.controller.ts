/**
 * AuthController — `/v1/auth/*` + `GET /v1/me` (doc 06 §1).
 *
 * Bodies are validated by the `ZodValidationPipe` against the `@core/contracts` schemas
 * (the password is read off the validated body where present; register takes it as a
 * field too). register/login/refresh are `@Public()` (no token yet); `/me` and logout
 * require auth. The `@RequiredFlag('all.auth')` gate lets ops kill the whole auth surface
 * from the control plane.
 */
import {
  Body,
  Controller,
  Get,
  Post,
  UsePipes,
} from '@nestjs/common';
import {
  CurrentUser,
  Public,
  RequiredFlag,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { identity } from '@core/contracts';
import { z } from 'zod';
import { AuthService } from './auth.service.js';
import type {
  AuthResult,
  LoginRequest,
  MeProfile,
  RegisterRequest,
  TokenPair,
} from './auth.types.js';

/** register accepts the contract fields + a password (kept out of the shared DTO that
 *  also describes OTP registration). */
const registerBody = identity.auth.registerRequest.and(
  z.object({ password: z.string().min(8).max(128) }),
);
type RegisterBody = RegisterRequest & { password: string };

@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @RequiredFlag('all.auth')
  @Post('v1/auth/register')
  @UsePipes(new ZodValidationPipe(registerBody))
  register(@Body() body: RegisterBody): Promise<AuthResult> {
    const { password, ...input } = body;
    return this.auth.register(input, password);
  }

  @Public()
  @RequiredFlag('all.auth')
  @Post('v1/auth/login')
  @UsePipes(new ZodValidationPipe(identity.auth.loginRequest))
  login(@Body() body: LoginRequest): Promise<AuthResult> {
    return this.auth.login(body);
  }

  @Public()
  @RequiredFlag('all.auth')
  @Post('v1/auth/refresh')
  @UsePipes(new ZodValidationPipe(identity.auth.refreshRequest))
  async refresh(@Body() body: { refreshToken: string }): Promise<TokenPair> {
    return this.auth.refresh(body.refreshToken);
  }

  @Post('v1/auth/logout')
  async logout(@CurrentUser() user: AuthPrincipal): Promise<{ ok: true }> {
    await this.auth.logout(user.sessionId);
    return { ok: true };
  }

  @Get('v1/me')
  me(@CurrentUser() user: AuthPrincipal): Promise<MeProfile> {
    return this.auth.me(user);
  }
}
