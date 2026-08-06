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

/** preHandler: valida o Bearer token e popula `request.auth`. */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    request.auth = await request.jwtVerify<AuthPayload>();
  } catch {
    await reply.status(401).send({ error: 'unauthorized', message: 'token ausente ou inválido' });
  }
}
