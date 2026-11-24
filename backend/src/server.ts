import WebSocket from 'ws';

if (!globalThis.WebSocket) {
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = WebSocket;
}

import { env } from './config/env.js';
import { buildApp } from './app.js';
import { initRealtime } from './realtime/socket.js';
import { registerWorkers } from './workers/index.js';
import { prisma } from './shared/database/prisma.js';
import { whatsappManager } from './modules/whatsapp/whatsapp.manager.js';

async function bootstrap(): Promise<void> {
  registerWorkers();

  const app = await buildApp();
  initRealtime(app.server, app);

  const shutdown = async (signal: string) => {
    app.log.info(`Recebido ${signal}. Encerrando SMV Sac Backend...`);
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(`🚀 SMV Sac Backend rodando em http://${env.HOST}:${env.PORT}`);

  // Restaura sessões WhatsApp (Baileys) previamente pareadas que seguem ativas
  void whatsappManager.restoreActiveSessions();
}

bootstrap().catch((err) => {
  console.error('❌ Falha ao iniciar servidor:', err);
  process.exit(1);
});
