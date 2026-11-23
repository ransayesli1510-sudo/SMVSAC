import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../shared/http/authenticate.js';

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/v1/ai/config — configuração de triagem automática e KPIs da IA
  app.get('/config', async (_req, reply) => {
    return reply.status(501).send({ module: 'ai', action: 'config', status: 'scaffold' });
  });

  // PATCH /api/v1/ai/config — ativa/desativa triagem automática
  app.patch('/config', async (_req, reply) => {
    return reply.status(501).send({ module: 'ai', action: 'update-config', status: 'scaffold' });
  });

  // POST /api/v1/ai/sandbox — simula atendimento com RAG via pgvector
  app.post('/sandbox', async (_req, reply) => {
    return reply.status(501).send({ module: 'ai', action: 'sandbox', status: 'scaffold' });
  });

  // POST /api/v1/ai/conversations/:conversationId/draft — gera sugestão de resposta para o composer
  app.post('/conversations/:conversationId/draft', async (_req, reply) => {
    return reply.status(501).send({ module: 'ai', action: 'draft', status: 'scaffold' });
  });
}
