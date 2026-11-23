import type { FastifyInstance } from 'fastify';
import { jobQueue } from '../../shared/queue/queue.js';
import { JOB_NAMES, type InboundWebhookJob } from '../../workers/index.js';

export async function webhooksRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/webhooks/meta/:connectionId — verificação de desafio da Meta Cloud API
  app.get('/meta/:connectionId', async (req, reply) => {
    const query = req.query as Record<string, string | undefined>;
    if (query['hub.mode'] === 'subscribe' && query['hub.challenge']) {
      return reply.type('text/plain').send(query['hub.challenge']);
    }
    return reply.status(400).send({ error: 'INVALID_CHALLENGE' });
  });

  // POST /api/v1/webhooks/:channel/:connectionId — responde 200 OK imediato e enfileira em memória (MVP)
  app.post('/:channel/:connectionId', async (req, reply) => {
    const { channel, connectionId } = req.params as { channel: string; connectionId: string };
    const normalized = channel.toUpperCase();

    if (normalized !== 'WHATSAPP' && normalized !== 'WEBCHAT' && normalized !== 'INSTAGRAM') {
      return reply.status(400).send({ error: 'UNSUPPORTED_CHANNEL' });
    }

    const jobId = await jobQueue.enqueue<InboundWebhookJob>(JOB_NAMES.WEBHOOK_INBOUND, {
      connectionId,
      channel: normalized,
      payload: req.body,
    });

    return reply.status(200).send({ received: true, jobId });
  });
}
