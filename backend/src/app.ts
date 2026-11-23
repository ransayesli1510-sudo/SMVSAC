import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';

import { env } from './config/env.js';
import { prisma } from './shared/database/prisma.js';
import { AppError } from './shared/http/errors.js';

import { authRoutes } from './modules/auth/auth.routes.js';
import { lgpdRoutes } from './modules/lgpd/lgpd.routes.js';
import { connectionsRoutes } from './modules/connections/connections.routes.js';
import { webhooksRoutes } from './modules/webhooks/webhooks.routes.js';
import { conversationsRoutes } from './modules/conversations/conversations.routes.js';
import { messagesRoutes } from './modules/messages/messages.routes.js';
import { contactsRoutes } from './modules/contacts/contacts.routes.js';
import { cannedResponsesRoutes } from './modules/canned-responses/canned-responses.routes.js';
import { aiRoutes } from './modules/ai/ai.routes.js';
import { reportsRoutes } from './modules/reports/reports.routes.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: env.NODE_ENV === 'development',
    trustProxy: true,
  });

  await app.register(helmet);
  await app.register(cors, {
    origin: env.CORS_ORIGIN.split(',').map((o) => o.trim()),
    credentials: true,
  });
  await app.register(cookie);
  await app.register(jwt, {
    secret: env.JWT_SECRET,
    sign: {
      expiresIn: env.JWT_EXPIRES_IN,
    },
  });
  await app.register(multipart, {
    limits: {
      fileSize: 25 * 1024 * 1024, // 25 MB por anexo
    },
  });

  // Tratamento padronizado de erros (AppError, Zod e Prisma)
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: error.code,
        message: error.message,
        ...(error.details !== undefined ? { details: error.details } : {}),
      });
    }

    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: 'VALIDATION_ERROR',
        message: 'Dados da requisição inválidos.',
        details: error.flatten().fieldErrors,
      });
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        return reply.status(409).send({
          error: 'CONFLICT',
          message: 'Registro duplicado para um campo único.',
        });
      }
      if (error.code === 'P2025') {
        return reply.status(404).send({
          error: 'NOT_FOUND',
          message: 'Registro não encontrado.',
        });
      }
    }

    app.log.error(error);
    return reply.status(500).send({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Erro interno inesperado no servidor.',
    });
  });

  // Healthcheck (verifica conectividade com o Supabase PostgreSQL)
  app.get('/health', async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return reply.send({
        status: 'ok',
        service: 'smv-sac-backend',
        database: 'connected',
        queueMode: env.REDIS_URL ? 'redis' : 'in-memory',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      app.log.error(error, 'Healthcheck DB failed');
      return reply.status(503).send({
        status: 'degraded',
        database: 'disconnected',
      });
    }
  });

  // Módulos de domínio sob /api/v1
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(lgpdRoutes, { prefix: '/api/v1/lgpd' });
  await app.register(connectionsRoutes, { prefix: '/api/v1/connections' });
  await app.register(webhooksRoutes, { prefix: '/api/v1/webhooks' });
  await app.register(conversationsRoutes, { prefix: '/api/v1/conversations' });
  await app.register(messagesRoutes, { prefix: '/api/v1/messages' });
  await app.register(contactsRoutes, { prefix: '/api/v1/contacts' });
  await app.register(cannedResponsesRoutes, { prefix: '/api/v1/canned-responses' });
  await app.register(aiRoutes, { prefix: '/api/v1/ai' });
  await app.register(reportsRoutes, { prefix: '/api/v1/reports' });

  return app;
}
