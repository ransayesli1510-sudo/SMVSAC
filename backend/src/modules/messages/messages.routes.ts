import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../shared/http/authenticate.js';

export async function messagesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/v1/messages/conversation/:conversationId — histórico paginado por cursor + busca inline
  app.get('/conversation/:conversationId', async (_req, reply) => {
    return reply.status(501).send({ module: 'messages', action: 'list', status: 'scaffold' });
  });

  // POST /api/v1/messages/conversation/:conversationId — envia mensagem pública ou nota interna (suporta anexos Supabase Storage)
  app.post('/conversation/:conversationId', async (_req, reply) => {
    return reply.status(501).send({ module: 'messages', action: 'send', status: 'scaffold' });
  });
}
