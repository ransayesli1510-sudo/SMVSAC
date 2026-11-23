import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../shared/http/authenticate.js';

export async function connectionsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/v1/connections — lista conexões ativas/arquivadas da organização
  app.get('/', async (_req, reply) => {
    return reply.status(501).send({ module: 'connections', action: 'list', status: 'scaffold' });
  });

  // POST /api/v1/connections — cria nova conexão (WhatsApp, WebChat, Instagram)
  app.post('/', async (_req, reply) => {
    return reply.status(501).send({ module: 'connections', action: 'create', status: 'scaffold' });
  });

  // PATCH /api/v1/connections/:id/status — arquivar ou reativar conexão
  app.patch('/:id/status', async (_req, reply) => {
    return reply.status(501).send({ module: 'connections', action: 'toggle-status', status: 'scaffold' });
  });
}
