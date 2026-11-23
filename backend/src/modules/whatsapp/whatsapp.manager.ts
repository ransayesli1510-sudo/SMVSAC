import fs from 'node:fs/promises';
import path from 'node:path';
import { Boom } from '@hapi/boom';
import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeWASocket,
  useMultiFileAuthState,
  type WASocket,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { ChannelType, ConnectionProvider, ConnectionStatus } from '@prisma/client';

import { prisma } from '../../shared/database/prisma.js';
import { formatPhoneFromJid } from '../../shared/formatters/ticket.js';
import { emitToOrganization } from '../../realtime/socket.js';
import {
  handleWhatsAppStatusUpdates,
  processWhatsAppMessage,
  syncWhatsAppHistory,
} from './whatsapp.sync.js';

export type RuntimeSessionStatus =
  | 'CONNECTING'
  | 'QR_PENDING'
  | 'CONNECTED'
  | 'PAUSED'
  | 'DISCONNECTED';

interface SessionEntry {
  connectionId: string;
  organizationId: string;
  socket: WASocket | null;
  status: RuntimeSessionStatus;
  qrDataUrl: string | null;
  identifier: string | null;
  paused: boolean;
  intentionalClose: boolean;
  reconnectTimer: NodeJS.Timeout | null;
}

const SESSIONS_ROOT = path.resolve(process.cwd(), '.baileys_sessions');
const baileysLogger = pino({ level: 'silent' });

class WhatsAppSessionManager {
  private readonly sessions = new Map<string, SessionEntry>();

  private getSessionDir(connectionId: string): string {
    return path.join(SESSIONS_ROOT, connectionId);
  }

  getSnapshot(connectionId: string): {
    status: RuntimeSessionStatus;
    qrDataUrl: string | null;
    identifier: string | null;
  } {
    const entry = this.sessions.get(connectionId);
    if (!entry) {
      return { status: 'DISCONNECTED', qrDataUrl: null, identifier: null };
    }
    return {
      status: entry.status,
      qrDataUrl: entry.qrDataUrl,
      identifier: entry.identifier,
    };
  }

  async startSession(connectionId: string, organizationId: string): Promise<void> {
    const conn = await prisma.connection.findFirst({
      where: { id: connectionId, organizationId },
      select: { id: true, defaultDepartmentId: true, identifier: true, metadata: true },
    });

    if (!conn) {
      throw new Error('Conexão não encontrada para esta organização.');
    }

    // Limpa socket anterior se existir
    const existing = this.sessions.get(connectionId);
    if (existing) {
      existing.intentionalClose = true;
      if (existing.reconnectTimer) {
        clearTimeout(existing.reconnectTimer);
        existing.reconnectTimer = null;
      }
      try {
        existing.socket?.end(undefined);
      } catch {
        // Ignora erro de encerramento de socket antigo
      }
    }

    const sessionDir = this.getSessionDir(connectionId);
    await fs.mkdir(sessionDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    let version: [number, number, number] = [2, 3000, 1023223821];
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
    } catch {
      // Usa versão padrão de fallback se falhar consulta externa
    }

    const entry: SessionEntry = {
      connectionId,
      organizationId,
      socket: null,
      status: 'CONNECTING',
      qrDataUrl: null,
      identifier: conn.identifier,
      paused: false,
      intentionalClose: false,
      reconnectTimer: null,
    };
    this.sessions.set(connectionId, entry);

    emitToOrganization(organizationId, 'whatsapp:status', {
      connectionId,
      status: 'CONNECTING',
      identifier: entry.identifier,
    });

    const sock = makeWASocket({
      version,
      auth: state,
      logger: baileysLogger,
      browser: ['SMV Sac', 'Chrome', '1.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    entry.socket = sock;

    sock.ev.on('creds.update', () => {
      void saveCreds();
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const qrDataUrl = await QRCode.toDataURL(qr, {
            width: 280,
            margin: 2,
            color: { dark: '#09090B', light: '#FFFFFF' },
          });
          entry.qrDataUrl = qrDataUrl;
          entry.status = 'QR_PENDING';
          emitToOrganization(organizationId, 'whatsapp:qr', {
            connectionId,
            status: 'QR_PENDING',
            qrDataUrl,
          });
        } catch (qrErr) {
          console.error('[WhatsApp] Erro ao renderizar QR Code:', qrErr);
        }
      }

      if (connection === 'open') {
        entry.qrDataUrl = null;
        entry.status = entry.paused ? 'PAUSED' : 'CONNECTED';
        const formattedPhone = formatPhoneFromJid(sock.user?.id) || entry.identifier || 'WhatsApp Conectado';
        entry.identifier = formattedPhone;

        const currentMeta =
          conn.metadata && typeof conn.metadata === 'object' && !Array.isArray(conn.metadata)
            ? (conn.metadata as Record<string, unknown>)
            : {};

        await prisma.connection.updateMany({
          where: { id: connectionId, organizationId },
          data: {
            status: ConnectionStatus.ACTIVE,
            identifier: formattedPhone,
            metadata: {
              ...currentMeta,
              jid: sock.user?.id ?? null,
              sessionState: entry.paused ? 'paused' : 'connected',
              connectedAt: new Date().toISOString(),
            },
          },
        });

        emitToOrganization(organizationId, 'whatsapp:status', {
          connectionId,
          status: entry.status,
          identifier: formattedPhone,
        });
      }

      if (connection === 'close') {
        if (entry.intentionalClose) return;

        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;

        entry.qrDataUrl = null;

        if (isLoggedOut) {
          entry.status = 'DISCONNECTED';
          entry.socket = null;
          await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
          await prisma.connection.updateMany({
            where: { id: connectionId, organizationId },
            data: { status: ConnectionStatus.DISCONNECTED },
          });
          emitToOrganization(organizationId, 'whatsapp:status', {
            connectionId,
            status: 'DISCONNECTED',
            identifier: entry.identifier,
            reason: 'logged_out',
          });
        } else {
          entry.status = 'CONNECTING';
          emitToOrganization(organizationId, 'whatsapp:status', {
            connectionId,
            status: 'CONNECTING',
            identifier: entry.identifier,
          });
          // Reconexão automática com pequeno backoff (ex.: código 515 após leitura do QR)
          entry.reconnectTimer = setTimeout(() => {
            void this.startSession(connectionId, organizationId);
          }, 2500);
        }
      }
    });

    // Sincronização inicial de conversas e mensagens recentes ao conectar
    sock.ev.on('messaging-history.set', (history) => {
      void syncWhatsAppHistory({
        organizationId,
        connectionId,
        defaultDepartmentId: conn.defaultDepartmentId,
        chats: history.chats,
        contacts: history.contacts,
        messages: history.messages,
      });
    });

    // Recebimento e envio em tempo real (inclusive mensagens enviadas pelo celular!)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (entry.paused) return;
      const isLive = type === 'notify';
      for (const msg of messages) {
        try {
          await processWhatsAppMessage({
            organizationId,
            connectionId,
            defaultDepartmentId: conn.defaultDepartmentId,
            msg,
            downloadMedia: isLive,
            emitRealtime: true,
          });
        } catch (err) {
          console.error('[WhatsApp] Erro ao processar mensagem recebida:', err);
        }
      }
    });

    // Atualizações de confirmação de entrega e leitura (✓✓)
    sock.ev.on('messages.update', (updates) => {
      void handleWhatsAppStatusUpdates(organizationId, connectionId, updates);
    });
  }

  async restartSession(connectionId: string, organizationId: string): Promise<void> {
    await this.startSession(connectionId, organizationId);
  }

  async setPaused(connectionId: string, organizationId: string, paused: boolean): Promise<void> {
    const entry = this.sessions.get(connectionId);
    if (entry) {
      entry.paused = paused;
      if (entry.status === 'CONNECTED' || entry.status === 'PAUSED') {
        entry.status = paused ? 'PAUSED' : 'CONNECTED';
      }
    }
    emitToOrganization(organizationId, 'whatsapp:status', {
      connectionId,
      status: paused ? 'PAUSED' : entry?.status ?? 'DISCONNECTED',
      identifier: entry?.identifier ?? null,
    });
  }

  async disconnectSession(
    connectionId: string,
    organizationId: string,
    clearAuth = false
  ): Promise<void> {
    const entry = this.sessions.get(connectionId);
    if (entry) {
      entry.intentionalClose = true;
      if (entry.reconnectTimer) {
        clearTimeout(entry.reconnectTimer);
        entry.reconnectTimer = null;
      }
      if (entry.socket) {
        try {
          if (clearAuth) {
            await entry.socket.logout();
          }
        } catch {
          // Ignora se já estiver fechado
        }
        try {
          entry.socket.end(undefined);
        } catch {
          // Ignora erro ao encerrar
        }
      }
      entry.socket = null;
      entry.qrDataUrl = null;
      entry.status = 'DISCONNECTED';
      this.sessions.delete(connectionId);
    }

    if (clearAuth) {
      await fs.rm(this.getSessionDir(connectionId), { recursive: true, force: true }).catch(() => {});
    }

    await prisma.connection.updateMany({
      where: { id: connectionId, organizationId },
      data: { status: ConnectionStatus.DISCONNECTED },
    });

    emitToOrganization(organizationId, 'whatsapp:status', {
      connectionId,
      status: 'DISCONNECTED',
    });
  }

  async sendTextMessage(connectionId: string, jid: string, text: string): Promise<string | null> {
    const entry = this.sessions.get(connectionId);
    if (!entry?.socket || entry.status !== 'CONNECTED') {
      throw new Error('Conexão WhatsApp não está conectada no momento. Escaneie o QR Code novamente.');
    }

    const sent = await entry.socket.sendMessage(jid, { text });
    return sent?.key?.id ?? null;
  }

  async sendMediaMessage(
    connectionId: string,
    jid: string,
    params: { buffer: Buffer; mimeType: string; fileName: string; caption?: string }
  ): Promise<string | null> {
    const entry = this.sessions.get(connectionId);
    if (!entry?.socket || entry.status !== 'CONNECTED') {
      throw new Error('Conexão WhatsApp não está conectada no momento.');
    }

    let sent;
    if (params.mimeType.startsWith('image/')) {
      sent = await entry.socket.sendMessage(jid, {
        image: params.buffer,
        caption: params.caption || undefined,
      });
    } else if (params.mimeType.startsWith('audio/')) {
      sent = await entry.socket.sendMessage(jid, {
        audio: params.buffer,
        mimetype: params.mimeType,
        ptt: true,
      });
    } else if (params.mimeType.startsWith('video/')) {
      sent = await entry.socket.sendMessage(jid, {
        video: params.buffer,
        caption: params.caption || undefined,
      });
    } else {
      sent = await entry.socket.sendMessage(jid, {
        document: params.buffer,
        mimetype: params.mimeType,
        fileName: params.fileName,
        caption: params.caption || undefined,
      });
    }

    return sent?.key?.id ?? null;
  }

  /**
   * Reconecta automaticamente sessões Baileys ativas que já possuem credenciais salvas em disco.
   */
  async restoreActiveSessions(): Promise<void> {
    try {
      const activeConns = await prisma.connection.findMany({
        where: {
          channel: ChannelType.WHATSAPP,
          provider: ConnectionProvider.BAILEYS,
          status: ConnectionStatus.ACTIVE,
        },
        select: { id: true, organizationId: true },
      });

      for (const conn of activeConns) {
        const credsPath = path.join(this.getSessionDir(conn.id), 'creds.json');
        try {
          await fs.access(credsPath);
          void this.startSession(conn.id, conn.organizationId);
        } catch {
          // Sem sessão salva ainda; aguarda o usuário clicar em Conectar / QR Code
        }
      }
    } catch (err) {
      console.warn('[WhatsApp] Não foi possível restaurar sessões ativas na inicialização:', err);
    }
  }
}

export const whatsappManager = new WhatsAppSessionManager();
