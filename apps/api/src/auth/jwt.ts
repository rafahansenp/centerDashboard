import type { FastifyReply, FastifyRequest } from 'fastify';
import '../authz/principal.js';

export interface AuthPayload {
  userId: string;
  organizationId: string;
  role: 'ADMIN' | 'MEMBER';
  /** Presente só em sessão de visualização de operador. */
  viewedBy?: string;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthPayload;
    user: AuthPayload;
  }
}

/** Roda depois de `app.authenticate`. Barra qualquer papel que não seja ADMIN. */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.auth.role !== 'ADMIN') {
    await reply.status(403).send({ error: 'forbidden', message: 'requer papel de administrador' });
  }
}
