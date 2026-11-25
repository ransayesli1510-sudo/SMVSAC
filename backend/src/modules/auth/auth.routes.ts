import type { FastifyInstance, FastifyReply } from 'fastify';

import { env } from '../../config/env.js';
import { authenticate, getTenantContext } from '../../shared/http/authenticate.js';
import {
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
  updateAvailabilitySchema,
} from './auth.schemas.js';
import { authService } from './auth.service.js';

const REFRESH_COOKIE_NAME = 'smv_refresh_token';
const REFRESH_COOKIE_MAX_AGE_SEC = 7 * 24 * 60 * 60; // 7 dias

function setRefreshCookie(reply: FastifyReply, refreshToken: string): void {
  const isProd = env.NODE_ENV === 'production';
  reply.setCookie(REFRESH_COOKIE_NAME, refreshToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    path: '/api/v1/auth',
    maxAge: REFRESH_COOKIE_MAX_AGE_SEC,
  });
}

function clearRefreshCookie(reply: FastifyReply): void {
  const isProd = env.NODE_ENV === 'production';
  reply.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    path: '/api/v1/auth',
  });
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/v1/auth/login
  app.post('/login', async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const result = await authService.login(app, input);
    setRefreshCookie(reply, result.refreshToken);
    return reply.status(200).send(result);
  });

  // POST /api/v1/auth/register — auto-cadastro corporativo (aguarda aprovação do Administrador)
  app.post('/register', async (request, reply) => {
    const input = registerSchema.parse(request.body);
    const result = await authService.register(input);
    clearRefreshCookie(reply);
    return reply.status(201).send(result);
  });

  // POST /api/v1/auth/refresh
  app.post('/refresh', async (request, reply) => {
    const body = refreshSchema.parse(request.body);
    const rawRefreshToken = request.cookies?.[REFRESH_COOKIE_NAME] ?? body?.refreshToken;
    const result = await authService.refresh(app, rawRefreshToken);
    setRefreshCookie(reply, result.refreshToken);
    return reply.status(200).send(result);
  });

  // POST /api/v1/auth/logout
  app.post('/logout', async (request, reply) => {
    // Se o cliente enviar um access token válido, marca o agente como OFFLINE no banco
    if (request.headers.authorization?.startsWith('Bearer ')) {
      try {
        await request.jwtVerify();
        if (request.user?.tokenType === 'access') {
          await authService.logout({
            organizationId: request.user.organizationId,
            userId: request.user.sub,
            email: request.user.email,
            role: request.user.role,
          });
        }
      } catch {
        // Mesmo com access token expirado, o logout limpa o cookie de sessão
      }
    }

    clearRefreshCookie(reply);
    return reply.status(200).send({
      message: 'Sessão encerrada com sucesso.',
    });
  });

  // GET /api/v1/auth/me
  app.get('/me', { preHandler: [authenticate] }, async (request, reply) => {
    const tenant = getTenantContext(request);
    const result = await authService.getMe(tenant);
    return reply.status(200).send(result);
  });

  // PATCH /api/v1/auth/availability
  app.patch('/availability', { preHandler: [authenticate] }, async (request, reply) => {
    const tenant = getTenantContext(request);
    const input = updateAvailabilitySchema.parse(request.body);
    const result = await authService.updateAvailability(tenant, input);
    return reply.status(200).send(result);
  });

  // POST /api/v1/auth/forgot-password
  app.post('/forgot-password', async (request, reply) => {
    const input = forgotPasswordSchema.parse(request.body);
    const result = await authService.forgotPassword(input);
    return reply.status(200).send(result);
  });

  // POST /api/v1/auth/reset-password
  app.post('/reset-password', async (request, reply) => {
    const input = resetPasswordSchema.parse(request.body);
    const result = await authService.resetPassword(input);
    return reply.status(200).send(result);
  });
}
