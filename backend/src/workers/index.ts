import { jobQueue } from '../shared/queue/queue.js';

export const JOB_NAMES = {
  WEBHOOK_INBOUND: 'webhook.inbound',
  MESSAGE_OUTBOUND: 'message.outbound',
  AI_TRIAGE: 'ai.triage',
  METRICS_AGGREGATE: 'metrics.aggregate',
} as const;

export interface InboundWebhookJob {
  connectionId: string;
  channel: 'WHATSAPP' | 'WEBCHAT' | 'INSTAGRAM';
  payload: unknown;
}

export interface OutboundMessageJob {
  messageId: string;
  conversationId: string;
}

export interface AiTriageJob {
  organizationId: string;
  conversationId: string;
  messageId: string;
}

/**
 * Registra os workers assíncronos no motor de fila (em memória no MVP).
 */
export function registerWorkers(): void {
  jobQueue.register<InboundWebhookJob>(JOB_NAMES.WEBHOOK_INBOUND, async (job) => {
    // TODO: normalizar payload do provedor, garantir idempotência via externalId,
    // criar/atualizar contato + conversa + mensagem e emitir evento Socket.IO.
    console.info(`[Worker:${JOB_NAMES.WEBHOOK_INBOUND}] Processando webhook da conexão ${job.connectionId}`);
  });

  jobQueue.register<OutboundMessageJob>(JOB_NAMES.MESSAGE_OUTBOUND, async (job) => {
    // TODO: enviar mensagem pelo provedor da conexão (Meta Cloud / Evolution / WebChat)
    // e atualizar deliveryStatus para SENT / FAILED.
    console.info(`[Worker:${JOB_NAMES.MESSAGE_OUTBOUND}] Despachando mensagem ${job.messageId}`);
  });

  jobQueue.register<AiTriageJob>(JOB_NAMES.AI_TRIAGE, async (job) => {
    // TODO: consultar ai_knowledge_chunks via pgvector, responder automaticamente
    // ou transferir para o departamento adequado registrando em ai_interactions.
    console.info(`[Worker:${JOB_NAMES.AI_TRIAGE}] Executando triagem IA para conversa ${job.conversationId}`);
  });
}
