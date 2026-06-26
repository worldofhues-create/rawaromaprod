/**
 * CryptoController — the only two endpoints a browser ever calls.
 *
 *   POST /crypto/handshake  (public)  → ECDH: client sends its public key, gets ours + a keyId.
 *   POST /rpc               (public)  → the ENCRYPTED TUNNEL. Body is one opaque blob. We decrypt
 *      it to { method, path, body, token }, replay it INTERNALLY through the full Nest/Fastify
 *      pipeline via fastify.inject() (so the real route's guards, per-role masking and envelope
 *      all run), then seal the reply. The network tab sees only POST /rpc + ciphertext — no
 *      readable paths, tokens, or data. Auth happens INSIDE the tunnel (the JWT travels sealed).
 */
import { Body, Controller, Headers, Post } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Public } from '@core/backend-kernel';
import { SessionKeysService } from './session-keys.service.js';

interface TunnelRequest {
  method?: string;
  path?: string;
  body?: unknown;
  token?: string;
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
    @Headers('x-ra-key') keyId?: string,
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
    const hasBody = req.body !== undefined && method !== 'GET' && method !== 'HEAD';

    // Replay internally — full pipeline runs (JwtAuthGuard reads the tunneled token, masking applies).
    const fastify = this.adapterHost.httpAdapter.getInstance() as {
      inject: (o: unknown) => Promise<{ statusCode: number; payload: string }>;
    };
    const res = await fastify.inject({
      method,
      url: path,
      payload: hasBody ? JSON.stringify(req.body) : undefined,
      headers: {
        'content-type': 'application/json',
        ...(req.token ? { authorization: 'Bearer ' + req.token } : {}),
      },
    });

    // Seal the inner reply ({status, body}) so the client can reconstruct it.
    const sealed = this.keys.seal(keyId, JSON.stringify({ status: res.statusCode, body: res.payload }));
    if (sealed === null) throw new Error('channel key expired');
    return { enc: sealed };
  }
}
