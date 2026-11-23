import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../shared/http/authenticate.js';

export async function contactsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/v1/contacts — listagem e busca fuzzy (pg_trgm)
  app.get('/', async (_req, reply) => {
    return reply.status(501).send({ module: 'contacts', action: 'list', status: 'scaffold' });
  });

  // POST /api/v1/contacts
  app.post('/', async (_req, reply) => {
    return reply.status(501).send({ module: 'contacts', action: 'create', status: 'scaffold' });
  });

  // PATCH /api/v1/contacts/:id
  app.patch('/:id', async (_req, reply) => {
    return reply.status(501).send({ module: 'contacts', action: 'update', status: 'scaffold' });
  });
}
