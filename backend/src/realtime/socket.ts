import type { Server as HttpServer } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { Server as SocketIOServer } from 'socket.io';
import { getCorsOrigins } from '../config/env.js';
import type { AuthJwtPayload } from '../shared/http/authenticate.js';

let ioInstance: SocketIOServer | null = null;

// Mapa de presença em memória para o MVP (quando adicionar Redis, trocar por @socket.io/redis-adapter)
const onlineUsersByOrg = new Map<string, Set<string>>();

export function initRealtime(httpServer: HttpServer, app: FastifyInstance): SocketIOServer {
  const allowedOrigins = getCorsOrigins();
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        const normalized = origin.replace(/\/+$/, '');
        if (allowedOrigins.includes('*') || allowedOrigins.includes(normalized)) {
          return cb(null, true);
        }
        return cb(null, false);
      },
      credentials: true,
    },
  });

  // Autentica todas as conexões Socket.IO via JWT (isola estritamente por organizationId do token)
  io.use((socket, next) => {
    const rawToken =
      (typeof socket.handshake.auth?.token === 'string' && socket.handshake.auth.token) ||
      (typeof socket.handshake.headers.authorization === 'string'
        ? socket.handshake.headers.authorization.replace(/^Bearer\s+/i, '')
        : '');

    if (!rawToken) {
      return next(new Error('UNAUTHORIZED'));
    }

    try {
      const decoded = app.jwt.verify<AuthJwtPayload>(rawToken);
      if (decoded.tokenType !== 'access' || !decoded.organizationId || !decoded.sub) {
        return next(new Error('INVALID_TOKEN'));
      }
      socket.data.organizationId = decoded.organizationId;
      socket.data.userId = decoded.sub;
      socket.data.role = decoded.role;
      return next();
    } catch {
      return next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket) => {
    const orgId = String(socket.data.organizationId ?? '');
    const userId = String(socket.data.userId ?? '');

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
