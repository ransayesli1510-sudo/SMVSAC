import type { FastifyInstance, FastifyRequest } from 'fastify';

import { env } from '../../config/env.js';
import { authenticate, getTenantContext } from '../../shared/http/authenticate.js';
import {
  anonymizeSchema,
  exportDataQuerySchema,
  recordConsentSchema,
  revokeConsentSchema,
} from './lgpd.schemas.js';
import { lgpdService, type RequestAuditMeta } from './lgpd.service.js';

function extractAuditMeta(request: FastifyRequest): RequestAuditMeta {
  const forwarded = request.headers['x-forwarded-for'];
  const ipFromHeader = Array.isArray(forwarded)
    ? forwarded[0]
    : typeof forwarded === 'string'
      ? forwarded.split(',')[0]?.trim()
      : undefined;

  return {
    ipAddress: ipFromHeader || request.ip || null,
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
  };
}

export async function lgpdRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // POST /api/v1/lgpd/consents — registro imutável (append-only) de consentimento
  app.post('/consents', async (request, reply) => {
    const tenant = getTenantContext(request);
    const input = recordConsentSchema.parse(request.body);
    const result = await lgpdService.recordConsent(tenant, input, extractAuditMeta(request));
    return reply.status(201).send(result);
  });

  // POST /api/v1/lgpd/consents/revoke — revogação append-only (Art. 18, IX da LGPD)
  app.post('/consents/revoke', async (request, reply) => {
    const tenant = getTenantContext(request);
    const input = revokeConsentSchema.parse(request.body);
    const result = await lgpdService.revokeConsent(tenant, input, extractAuditMeta(request));
    return reply.status(201).send(result);
  });

  // GET /api/v1/lgpd/consents/me — histórico de consentimentos do usuário autenticado
  app.get('/consents/me', async (request, reply) => {
    const tenant = getTenantContext(request);
    const result = await lgpdService.listMyConsents(tenant);
    return reply.status(200).send(result);
  });

  // GET /api/v1/lgpd/data-export?contactId=<uuid> — consulta/exportação (Art. 18, I, II e V)
  app.get('/data-export', async (request, reply) => {
    const tenant = getTenantContext(request);
    const query = exportDataQuerySchema.parse(request.query);
    const result = await lgpdService.exportData(tenant, query.contactId);
    return reply.status(200).send(result);
  });

  // POST /api/v1/lgpd/anonymize — anonimização irreversível (Art. 18, IV e VI)
  app.post('/anonymize', async (request, reply) => {
    const tenant = getTenantContext(request);
    const input = anonymizeSchema.parse(request.body);
    const result = await lgpdService.anonymize(tenant, input, extractAuditMeta(request));

    if (input.target === 'self') {
      reply.clearCookie('smv_refresh_token', {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/api/v1/auth',
      });
    }

    return reply.status(200).send(result);
  });
}
