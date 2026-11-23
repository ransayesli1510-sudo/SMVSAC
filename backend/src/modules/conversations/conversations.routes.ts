import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../shared/http/authenticate.js';

export async function conversationsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/v1/conversations — filtros: tab (mine|queue|all), status (open|resolved|all), q
  app.get('/', async (_req, reply) => {
    return reply.status(501).send({ module: 'conversations', action: 'list', status: 'scaffold' });
  });

  // GET /api/v1/conversations/:id — detalhes da conversa, contato, etiquetas e resumo IA
  app.get('/:id', async (_req, reply) => {
    return reply.status(501).send({ module: 'conversations', action: 'detail', status: 'scaffold' });
  });

  // PATCH /api/v1/conversations/:id/assign — assumir ou transferir atendente/departamento
  app.patch('/:id/assign', async (_req, reply) => {
    return reply.status(501).send({ module: 'conversations', action: 'assign', status: 'scaffold' });
  });

  // PATCH /api/v1/conversations/:id/status — finalizar ou reabrir atendimento
  app.patch('/:id/status', async (_req, reply) => {
    return reply.status(501).send({ module: 'conversations', action: 'status', status: 'scaffold' });
  });
}
