import type { PrismaClient } from '@prisma/client';
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { AuthPayload } from '../auth/jwt.js';

export interface Principal {
  userId: string;
  organizationId: string;
  role: 'ADMIN' | 'MEMBER';
  /** Id do operador quando é uma sessão de visualização; null para o usuário do cliente. */
  viewedBy: string | null;
  mustChangePassword: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: Principal;
  }
  interface FastifyInstance {
    authenticate: preHandlerAsyncHookHandler;
  }
  interface FastifyContextConfig {
    /** Rota que uma sessão de visualização (somente leitura) pode chamar. */
    readonlySafe?: boolean;
    /** Rota liberada mesmo com troca de senha obrigatória pendente. */
    allowDuringPasswordChange?: boolean;
  }
}

function deny(reply: FastifyReply, status: number, error: string, message: string) {
  return reply.status(status).send({ error, message });
}

/**
 * preHandler: valida o token do cliente e monta `request.auth` a partir do
 * BANCO a cada requisição. Papel, estado do usuário e status do cliente nunca
 * vêm do token — assim desativar um usuário ou suspender um cliente vale na
 * hora, sem esperar o token expirar.
 */
export function makeAuthenticate(prisma: PrismaClient): preHandlerAsyncHookHandler {
  return async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    let decoded: AuthPayload;
    try {
      decoded = await request.jwtVerify<AuthPayload>();
    } catch {
      await deny(reply, 401, 'unauthorized', 'token ausente ou inválido');
      return;
    }

    const config = request.routeOptions.config;
    const organization = await prisma.organization.findUnique({
      where: { id: decoded.organizationId },
      select: { status: true },
    });

    // Sessão de visualização (operador): somente leitura, nunca depende de User.
    if (decoded.viewedBy) {
      // Logado antes de qualquer decisão: tentativas negadas também ficam auditadas.
      request.log.info(
        { viewedBy: decoded.viewedBy, organizationId: decoded.organizationId, url: request.url },
        'view_session_request',
      );
      if (organization?.status !== 'ACTIVE') {
        await deny(reply, 403, 'organization_suspended', 'cliente suspenso');
        return;
      }
      if (!config?.readonlySafe) {
        await deny(reply, 403, 'readonly_session', 'sessão de visualização é somente leitura');
        return;
      }
      request.auth = {
        userId: decoded.userId, organizationId: decoded.organizationId, role: 'ADMIN',
        viewedBy: decoded.viewedBy, mustChangePassword: false,
      };
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { active: true, role: true, mustChangePassword: true, organizationId: true },
    });
    // O token só vale para o cliente do próprio usuário.
    if (!user || !user.active || user.organizationId !== decoded.organizationId) {
      await deny(reply, 401, 'unauthorized', 'token ausente ou inválido');
      return;
    }
    if (organization?.status !== 'ACTIVE') {
      await deny(reply, 403, 'organization_suspended', 'cliente suspenso');
      return;
    }
    if (user.mustChangePassword && !config?.allowDuringPasswordChange) {
      await deny(reply, 403, 'password_change_required', 'troca de senha obrigatória');
      return;
    }
    request.auth = {
      userId: decoded.userId, organizationId: decoded.organizationId, role: user.role,
      viewedBy: null, mustChangePassword: user.mustChangePassword,
    };
  };
}
