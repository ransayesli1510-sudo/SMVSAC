import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../shared/http/authenticate.js';

export async function cannedResponsesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/v1/canned-responses — lista respostas rápidas (/ola, /acesso, /pix, /encerrar)
  app.get('/', async (_req, reply) => {
    return reply.status(501).send({ module: 'canned-responses', action: 'list', status: 'scaffold' });
  });

  // POST /api/v1/canned-responses
  app.post('/', async (_req, reply) => {
    return reply.status(501).send({ module: 'canned-responses', action: 'create', status: 'scaffold' });
  });
}
