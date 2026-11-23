import crypto from 'node:crypto';

export type JobHandler<TPayload = unknown> = (payload: TPayload) => Promise<void>;

export interface EnqueueOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
}

export interface IJobQueue {
  register<TPayload>(jobName: string, handler: JobHandler<TPayload>): void;
  enqueue<TPayload>(jobName: string, payload: TPayload, options?: EnqueueOptions): Promise<string>;
}

/**
 * Fila assíncrona em memória para o MVP (sem dependência obrigatória de Redis).
 * Mantém o contrato `IJobQueue` para permitir troca transparente por BullMQ/Redis no futuro.
 */
class InMemoryJobQueue implements IJobQueue {
  private readonly handlers = new Map<string, JobHandler<unknown>>();

  register<TPayload>(jobName: string, handler: JobHandler<TPayload>): void {
    this.handlers.set(jobName, handler as JobHandler<unknown>);
  }

  async enqueue<TPayload>(
    jobName: string,
    payload: TPayload,
    options: EnqueueOptions = {}
  ): Promise<string> {
    const jobId = crypto.randomUUID();
    const maxAttempts = options.maxAttempts ?? 3;
    const retryDelayMs = options.retryDelayMs ?? 1500;

    const execute = async (attempt: number): Promise<void> => {
      const handler = this.handlers.get(jobName);
      if (!handler) {
        console.warn(`[Queue] Nenhum handler registrado para o job "${jobName}" (id=${jobId})`);
        return;
      }

      try {
        await handler(payload);
      } catch (err) {
        console.error(
          `[Queue] Erro no job "${jobName}" (id=${jobId}, tentativa ${attempt}/${maxAttempts}):`,
          err
        );
        if (attempt < maxAttempts) {
          setTimeout(() => {
            void execute(attempt + 1);
          }, retryDelayMs * attempt);
        }
      }
    };

    // Despacha fora do ciclo síncrono da request HTTP (ex.: webhooks respondem 200 OK na hora)
    setImmediate(() => {
      void execute(1);
    });

    return jobId;
  }
}

export const jobQueue: IJobQueue = new InMemoryJobQueue();
