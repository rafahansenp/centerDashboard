import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { hashPassword, verifyPassword } from './password.js';
import type { AuthPayload } from './jwt.js';

const PasswordBodySchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12),
});

const LoginBodySchema = z.object({ email: z.string().email(), password: z.string().min(1) });

// Hash scrypt válido (formato `scrypt$<saltHex>$<hashHex>`) de uma senha
// fixa e nunca usada de verdade. Serve só para pagar o mesmo custo de
// `verifyPassword` quando o email não existe — sem isso, a resposta para
// "usuário inexistente" volta em ~1ms contra ~70ms de "senha errada", um
// oráculo de timing que permite enumerar emails cadastrados pela rede.
const DUMMY_HASH =
  'scrypt$8ee85cfaeec69f686555b0c1033218be$ce1ec3f525d5eda8728bf862323eef7f8b3cf80edbc5913618e676a78d3398e0b5f82ddc54272fcd7ecfa92261e67912e683ac3ba4365de2367dd047061e3b71';

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
      // Mesma resposta e o mesmo custo de scrypt para email inexistente e
      // senha errada: sem enumeração por corpo de resposta nem por timing.
      const passwordHash = user?.passwordHash ?? DUMMY_HASH;
      const valid = await verifyPassword(parsed.data.password, passwordHash);
      // Usuário desativado cai no mesmo 401 de senha errada (sem enumeração).
      if (!user || !user.active || !valid) {
        return reply.status(401).send({ error: 'unauthorized', message: 'credenciais inválidas' });
      }

      // Só após a senha correta: quem acertou a senha pode saber que o cliente está suspenso.
      const organization = await deps.prisma.organization.findUnique({
        where: { id: user.organizationId }, select: { status: true },
      });
      if (organization?.status !== 'ACTIVE') {
        return reply.status(403).send({ error: 'organization_suspended', message: 'cliente suspenso' });
      }

      const payload: AuthPayload = {
        userId: user.id, organizationId: user.organizationId, role: user.role,
      };
      return reply.send({
        // aud explícito: o @fastify/jwt não mescla o `sign` global quando há opções locais.
        token: app.jwt.sign(payload, { expiresIn: '12h', aud: 'client' }),
        user: {
          id: user.id, name: user.name, email: user.email, role: user.role,
          mustChangePassword: user.mustChangePassword,
        },
      });
    },
  );

  app.post(
    '/auth/password',
    {
      preHandler: app.authenticate,
      config: { allowDuringPasswordChange: true, rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const parsed = PasswordBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'bad_request', message: 'newPassword deve ter ao menos 12 caracteres' });
      }
      const user = await deps.prisma.user.findUnique({
        where: { id: request.auth.userId }, select: { passwordHash: true },
      });
      if (!user || !(await verifyPassword(parsed.data.currentPassword, user.passwordHash))) {
        return reply.status(401).send({ error: 'unauthorized', message: 'senha atual incorreta' });
      }
      await deps.prisma.user.update({
        where: { id: request.auth.userId },
        data: { passwordHash: await hashPassword(parsed.data.newPassword), mustChangePassword: false },
      });
      return reply.status(204).send();
    },
  );

  app.get(
    '/auth/me',
    { preHandler: app.authenticate, config: { readonlySafe: true, allowDuringPasswordChange: true } },
    async (request) => ({
      userId: request.auth.userId, organizationId: request.auth.organizationId, role: request.auth.role,
    }),
  );
}
