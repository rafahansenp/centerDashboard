import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { verifyPassword } from './password.js';
import { requireAuth, type AuthPayload } from './jwt.js';

const LoginBodySchema = z.object({ email: z.string().email(), password: z.string().min(1) });

export async function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.post(
    '/auth/login',
    // Força bruta é o risco real desta rota; o limite global de 300/min não basta.
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = LoginBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'bad_request', message: 'email e password são obrigatórios' });
      }

      const user = await deps.prisma.user.findUnique({ where: { email: parsed.data.email } });
      // Mesma resposta para email inexistente e senha errada: sem enumeração.
      const valid = user ? await verifyPassword(parsed.data.password, user.passwordHash) : false;
      if (!user || !valid) {
        return reply.status(401).send({ error: 'unauthorized', message: 'credenciais inválidas' });
      }

      const payload: AuthPayload = {
        userId: user.id, organizationId: user.organizationId, role: user.role,
      };
      return reply.send({
        token: app.jwt.sign(payload, { expiresIn: '12h' }),
        user: { id: user.id, name: user.name, email: user.email, role: user.role },
      });
    },
  );

  app.get('/auth/me', { preHandler: requireAuth }, async (request) => {
    // `request.auth` vem de `jwtVerify`, que também carrega `iat`/`exp` no
    // payload decodificado — não fazem parte de `AuthPayload` e não devem
    // vazar na resposta.
    const { userId, organizationId, role } = request.auth;
    return { userId, organizationId, role };
  });
}
