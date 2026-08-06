import type { FastifyReply, FastifyRequest } from 'fastify';

export interface AuthPayload {
  userId: string;
  organizationId: string;
  role: 'ADMIN' | 'VIEWER';
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthPayload;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthPayload;
    user: AuthPayload;
  }
}

/**
 * preHandler: valida o Bearer token e popula `request.auth`.
 *
 * `jwtVerify` retorna o payload decodificado com `iat`/`exp` inclusos, que
 * não fazem parte de `AuthPayload`. Reconstruímos o objeto aqui para que
 * `request.auth` seja sempre o formato limpo — na origem, não em cada rota
 * que o lê — evitando que esses claims vazem em qualquer resposta futura
 * que retorne ou espalhe `request.auth` diretamente.
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const decoded = await request.jwtVerify<AuthPayload>();
    request.auth = { userId: decoded.userId, organizationId: decoded.organizationId, role: decoded.role };
  } catch {
    await reply.status(401).send({ error: 'unauthorized', message: 'token ausente ou inválido' });
  }
}
