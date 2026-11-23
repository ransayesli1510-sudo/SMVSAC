import type { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { env } from '../config/env.js';

let ioInstance: SocketIOServer | null = null;

// Mapa de presença em memória para o MVP (quando adicionar Redis, trocar por @socket.io/redis-adapter)
const onlineUsersByOrg = new Map<string, Set<string>>();

export function initRealtime(httpServer: HttpServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: env.CORS_ORIGIN.split(',').map((o) => o.trim()),
      credentials: true,
    },
  });

  io.on('connection', (socket) => {
    const orgId = String(socket.handshake.auth?.organizationId ?? '');
    const userId = String(socket.handshake.auth?.userId ?? '');

    if (orgId) {
      socket.join(`org:${orgId}`);
      if (userId) {
        let orgUsers = onlineUsersByOrg.get(orgId);
        if (!orgUsers) {
          orgUsers = new Set<string>();
          onlineUsersByOrg.set(orgId, orgUsers);
        }
        orgUsers.add(userId);
      }
    }

    socket.on('conversation:join', (conversationId: string) => {
      if (conversationId) socket.join(`conv:${conversationId}`);
    });

    socket.on('conversation:leave', (conversationId: string) => {
      if (conversationId) socket.leave(`conv:${conversationId}`);
    });

    socket.on('typing:start', (payload: { conversationId: string; senderName: string }) => {
      if (payload?.conversationId) {
        socket.to(`conv:${payload.conversationId}`).emit('typing:start', payload);
      }
    });

    socket.on('typing:stop', (payload: { conversationId: string }) => {
      if (payload?.conversationId) {
        socket.to(`conv:${payload.conversationId}`).emit('typing:stop', payload);
      }
    });

    socket.on('disconnect', () => {
      if (orgId && userId) {
        onlineUsersByOrg.get(orgId)?.delete(userId);
      }
    });
  });

  ioInstance = io;
  return io;
}

export function getRealtime(): SocketIOServer | null {
  return ioInstance;
}

export function emitToOrganization(organizationId: string, event: string, payload: unknown): void {
  ioInstance?.to(`org:${organizationId}`).emit(event, payload);
}

export function emitToConversation(conversationId: string, event: string, payload: unknown): void {
  ioInstance?.to(`conv:${conversationId}`).emit(event, payload);
}
