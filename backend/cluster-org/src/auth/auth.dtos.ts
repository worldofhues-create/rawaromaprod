import { z } from "zod";

/** POST /auth/login — identifier is the user_master email. */
export const loginBody = z.object({
  identifier: z.string().min(1),
  password: z.string().min(1),
});
export type LoginBody = z.infer<typeof loginBody>;

/** POST /auth/users/:id/password — set/reset a user's password. */
export const setPasswordBody = z.object({
  password: z.string().min(8).max(200),
});
export type SetPasswordBody = z.infer<typeof setPasswordBody>;

/** POST /auth/refresh — exchange a refresh token for a fresh access token. */
export const refreshBody = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshBody = z.infer<typeof refreshBody>;

/** POST /auth/alembic-assertion — PB-04/SB-02, the one-login identity bridge. */
export const alembicAssertionBody = z.object({
  assertion: z.string().min(1),
});
export type AlembicAssertionBody = z.infer<typeof alembicAssertionBody>;
