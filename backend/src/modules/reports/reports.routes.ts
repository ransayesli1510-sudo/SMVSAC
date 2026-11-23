import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../shared/http/authenticate.js';

export async function reportsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/v1/reports/overview?period=7d|30d — KPIs, séries temporais e distribuição por conexão
  app.get('/overview', async (_req, reply) => {
    return reply.status(501).send({ module: 'reports', action: 'overview', status: 'scaffold' });
  });

  // GET /api/v1/reports/export.csv?period=7d|30d — exportação CSV
  app.get('/export.csv', async (_req, reply) => {
    return reply.status(501).send({ module: 'reports', action: 'export-csv', status: 'scaffold' });
  });
}
