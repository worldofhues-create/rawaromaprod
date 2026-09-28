/**
 * CryptoController — the only two endpoints a browser ever calls.
 *
 *   POST /crypto/handshake  (public)  → ECDH: client sends its public key, gets ours + a keyId.
 *   POST /rpc               (public)  → the ENCRYPTED TUNNEL. Body is one opaque blob. We decrypt
 *      it to { method, path, body, token }, replay it INTERNALLY through the full Nest/Fastify
 *      pipeline via fastify.inject() (so the real route's guards, per-role masking and envelope
 *      all run), then seal the reply. The network tab sees only POST /rpc + ciphertext — no
 *      readable paths, tokens, or data. Auth happens INSIDE the tunnel (the JWT travels sealed).
 *
 * The inner request carries the caller's real client address and User-Agent (sign-ins are
 * recorded in iam.login_history from them), and — when the console asks — the saved-session
 * cookie is set, read and cleared here, because only this outer response reaches the browser
 * (see session-cookie.ts).
 */
import { Body, Controller, Headers, Post, Req, Res } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Public } from '@core/backend-kernel';
import { SessionKeysService } from './session-keys.service.js';
import {
  LOGOUT_ROUTE, SESSION_ROUTES, clearSessionCookie, isSameOriginRequest, readSessionCookie, setSessionCookie,
} from './session-cookie.js';

type OuterHeaders = Record<string, string | string[] | undefined>;
interface OuterRequest { ip?: string; headers: OuterHeaders }
interface OuterReply { header(name: string, value: string): unknown }

interface TunnelRequest {
  method?: string;
  path?: string;
  body?: unknown;
  token?: string;
  /** The console wants its session kept across reloads in the HttpOnly cookie (Factory,
   *  Platform). Absent = the old behaviour exactly: nothing set or read, body untouched. */
  persist?: boolean;
}

@Controller()
export class CryptoController {
  constructor(
    private readonly keys: SessionKeysService,
    private readonly adapterHost: HttpAdapterHost,
  ) {}

  @Public()
  @Post('crypto/handshake')
  handshake(@Body() body: { clientPub?: string }): { keyId: string; serverPub: string } {
    if (!body?.clientPub) throw new Error('clientPub required');
    return this.keys.handshake(body.clientPub);
  }

  @Public()
  @Post('rpc')
  async rpc(
    @Body() body: { enc?: string },
    @Headers('x-ra-key') keyId: string | undefined,
    @Req() outer: OuterRequest,
    @Res({ passthrough: true }) reply: OuterReply,
  ): Promise<{ enc: string }> {
    if (!keyId || !body?.enc) throw new Error('encrypted channel not established');
    const opened = this.keys.open(keyId, body.enc);
    if (opened === null) throw new Error('bad channel key or payload');

    let req: TunnelRequest;
    try {
      req = JSON.parse(opened) as TunnelRequest;
    } catch {
      throw new Error('malformed tunnel request');
    }

    const method = (req.method || 'GET').toUpperCase();
    const path = req.path || '/';
    const route = path.split('?')[0] ?? path;
    const seal = (status: number, payload: unknown): { enc: string } => {
      const sealed = this.keys.seal(keyId, JSON.stringify({ status, body: JSON.stringify(payload) }));
      if (sealed === null) throw new Error('channel key expired');
      return { enc: sealed };
    };

    // Saved-session cookie handling applies only when the console asked for it AND the request
    // came from a page on this console's own origin.
    const cookieSession = req.persist === true && isSameOriginRequest(outer.headers);
    if (route === LOGOUT_ROUTE) {
      if (cookieSession) reply.header('set-cookie', clearSessionCookie());
      return seal(200, { data: { signedOut: true } });
    }
    if (cookieSession && route === '/auth/refresh' && method === 'POST') {
      const given = (req.body as { refreshToken?: unknown } | undefined)?.refreshToken;
      if (typeof given !== 'string' || !given) {
        const saved = readSessionCookie(outer.headers);
        if (!saved) {
          return seal(401, { data: null, error: { code: 'AUTH_TOKEN_INVALID', message: 'No saved session. Sign in again.' } });
        }
        req.body = { refreshToken: saved };
      }
    }
    const hasBody = req.body !== undefined && method !== 'GET' && method !== 'HEAD';

    // Replay internally — full pipeline runs (JwtAuthGuard reads the tunneled token, masking applies).
    const fastify = this.adapterHost.httpAdapter.getInstance() as {
      inject: (o: unknown) => Promise<{ statusCode: number; payload: string }>;
    };
    const uaHeader = outer.headers['user-agent'];
    const ua = Array.isArray(uaHeader) ? uaHeader[0] : uaHeader;
    const res = await fastify.inject({
      method,
      url: path,
      payload: hasBody ? JSON.stringify(req.body) : undefined,
      // The caller's real address (Fastify trustProxy already resolved it from X-Forwarded-For
      // on this outer request) — without it every tunnelled call reads as 127.0.0.1.
      ...(outer.ip ? { remoteAddress: outer.ip } : {}),
      headers: {
        'content-type': 'application/json',
        ...(ua ? { 'user-agent': ua } : {}),
        ...(req.token ? { authorization: 'Bearer ' + req.token } : {}),
      },
    });

    let payload = res.payload;
    if (cookieSession && SESSION_ROUTES.has(route)) {
      if (res.statusCode < 400) {
        // The refresh token goes into the HttpOnly cookie and out of the body page script sees.
        try {
          const parsed = JSON.parse(payload) as { data?: { refreshToken?: unknown } };
          if (parsed?.data && typeof parsed.data.refreshToken === 'string') {
            reply.header('set-cookie', setSessionCookie(parsed.data.refreshToken));
            delete parsed.data.refreshToken;
            payload = JSON.stringify(parsed);
          }
        } catch { /* not JSON: pass through untouched */ }
      } else if (route === '/auth/refresh' && (res.statusCode === 401 || res.statusCode === 403)) {
        reply.header('set-cookie', clearSessionCookie());
      }
    }

    // Seal the inner reply ({status, body}) so the client can reconstruct it.
    const sealed = this.keys.seal(keyId, JSON.stringify({ status: res.statusCode, body: payload }));
    if (sealed === null) throw new Error('channel key expired');
    return { enc: sealed };
  }
}
