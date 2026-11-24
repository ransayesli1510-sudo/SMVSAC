import fs from 'node:fs/promises';
import path from 'node:path';
import { Boom } from '@hapi/boom';
import {
  ALL_WA_PATCH_NAMES,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeWASocket,
  useMultiFileAuthState,
  type Contact as WaContact,
  type WASocket,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { ChannelType, ConnectionProvider, ConnectionStatus } from '@prisma/client';

import { prisma } from '../../shared/database/prisma.js';
import { formatPhoneFromJid, isGroupJid, isLidJid } from '../../shared/formatters/ticket.js';
import { emitToOrganization } from '../../realtime/socket.js';
import {
  enqueueMissingAvatarsForOrganization,
  handleWhatsAppStatusUpdates,
  processWhatsAppMessage,
  syncWhatsAppContactsBatch,
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
  lidToPn: Map<string, string>;
  knownNames: Map<string, string>;
  knownContacts: Map<string, Partial<WaContact>>;
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
    organizationId?: string;
  } {
    const entry = this.sessions.get(connectionId);
    if (!entry) {
      return { status: 'DISCONNECTED', qrDataUrl: null, identifier: null };
    }
    return {
      status: entry.status,
      qrDataUrl: entry.qrDataUrl,
      identifier: entry.identifier,
      organizationId: entry.organizationId,
    };
  }

  getActiveSessionForOrganization(
    organizationId: string,
    connectionId?: string
  ): {
    connectionId: string;
    socket: WASocket;
    lidToPn: Map<string, string>;
    knownNames: Map<string, string>;
  } | null {
    if (connectionId) {
      const entry = this.sessions.get(connectionId);
      if (entry && entry.organizationId === organizationId && entry.socket && entry.status === 'CONNECTED') {
        return {
          connectionId: entry.connectionId,
          socket: entry.socket,
          lidToPn: entry.lidToPn,
          knownNames: entry.knownNames,
        };
      }
      return null;
    }

    for (const entry of this.sessions.values()) {
      if (entry.organizationId === organizationId && entry.socket && entry.status === 'CONNECTED') {
        return {
          connectionId: entry.connectionId,
          socket: entry.socket,
          lidToPn: entry.lidToPn,
          knownNames: entry.knownNames,
        };
      }
    }
    return null;
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
      lidToPn: existing?.lidToPn ?? new Map<string, string>(),
      knownNames: existing?.knownNames ?? new Map<string, string>(),
      knownContacts: existing?.knownContacts ?? new Map<string, Partial<WaContact>>(),
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
      syncFullHistory: true,
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

        // Enfileira automaticamente fotos de perfil pendentes e limpa contatos @lid legados
        void enqueueMissingAvatarsForOrganization({
          organizationId,
          connectionId,
          sock,
          lidToPn: entry.lidToPn,
          knownNames: entry.knownNames,
          force: true,
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
          await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => { });
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

    // Mantém mapa em memória de LID -> PN e nomes reais de contatos/grupos
    sock.ev.on('lid-mapping.update', (mapping) => {
      if (mapping.lid && mapping.pn) {
        const pnJid = mapping.pn.includes('@') ? mapping.pn : `${mapping.pn.replace(/\D/g, '')}@s.whatsapp.net`;
        entry.lidToPn.set(mapping.lid, pnJid);
      }
    });

    const absorbContacts = (contacts: Array<Partial<WaContact>>) => {
      for (const c of contacts) {
        if (!c.id) continue;
        const prev = entry.knownContacts.get(c.id) ?? {};
        entry.knownContacts.set(c.id, { ...prev, ...c });

        const label = c.name || c.notify || '';
        const pnRaw = c.phoneNumber || (!isLidJid(c.id) && !isGroupJid(c.id) ? c.id : null);
        const pnJid = pnRaw
          ? pnRaw.includes('@')
            ? pnRaw
            : `${pnRaw.replace(/\D/g, '')}@s.whatsapp.net`
          : null;
        if (c.lid && pnJid) entry.lidToPn.set(c.lid, pnJid);
        if (isLidJid(c.id) && pnJid) entry.lidToPn.set(c.id, pnJid);
        if (label) {
          entry.knownNames.set(c.id, label);
          if (c.lid) entry.knownNames.set(c.lid, label);
          if (pnJid) entry.knownNames.set(pnJid, label);
        }
      }
    };

    sock.ev.on('contacts.upsert', (contacts) => {
      absorbContacts(contacts);
      void syncWhatsAppContactsBatch({
        organizationId,
        connectionId,
        contacts,
        lidToPn: entry.lidToPn,
        emitEvent: true,
      }).catch((err) => console.warn('[WhatsApp] Falha ao salvar contacts.upsert:', err));
    });

    sock.ev.on('contacts.update', (updates) => {
      absorbContacts(updates);
      const enriched = updates
        .map((u) => (u.id ? entry.knownContacts.get(u.id) ?? u : u))
        .filter((u) => Boolean(u.id));
      if (enriched.length > 0) {
        void syncWhatsAppContactsBatch({
          organizationId,
          connectionId,
          contacts: enriched,
          lidToPn: entry.lidToPn,
          emitEvent: true,
        }).catch((err) => console.warn('[WhatsApp] Falha ao salvar contacts.update:', err));
      }
    });

    sock.ev.on('groups.upsert', (groups) => {
      for (const g of groups) {
        if (g.id && g.subject) {
          entry.knownNames.set(g.id, g.subject);
        }
      }
    });

    sock.ev.on('groups.update', (groups) => {
      for (const g of groups) {
        if (g.id && g.subject) {
          entry.knownNames.set(g.id, g.subject);
        }
      }
    });

    // Sincronização inicial de conversas e mensagens recentes ao conectar
    sock.ev.on('messaging-history.set', (history) => {
      for (const m of history.lidPnMappings ?? []) {
        if (m.lid && m.pn) {
          const pnJid = m.pn.includes('@') ? m.pn : `${m.pn.replace(/\D/g, '')}@s.whatsapp.net`;
          entry.lidToPn.set(m.lid, pnJid);
        }
      }
      for (const c of history.contacts ?? []) {
        if (c.id) {
          const prev = entry.knownContacts.get(c.id) ?? {};
          entry.knownContacts.set(c.id, { ...prev, ...c });
        }
        const label = c.name || c.notify || '';
        if (label && c.id) entry.knownNames.set(c.id, label);
        if (label && c.lid) entry.knownNames.set(c.lid, label);
      }
      for (const ch of history.chats ?? []) {
        if (ch.id && ch.name) entry.knownNames.set(ch.id, ch.name);
      }

      void syncWhatsAppHistory({
        organizationId,
        connectionId,
        defaultDepartmentId: conn.defaultDepartmentId,
        sock,
        chats: history.chats,
        contacts: history.contacts,
        messages: history.messages,
        lidPnMappings: history.lidPnMappings,
        knownNames: entry.knownNames,
        knownLidToPn: entry.lidToPn,
      });
    });

    // Recebimento e envio em tempo real (inclusive mensagens enviadas pelo celular!)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (entry.paused) return;
      const isLive = type === 'notify';
      for (const msg of messages) {
        try {
          const jid = msg.key?.remoteJid;
          let nameHint = jid ? entry.knownNames.get(jid) ?? null : null;
          const pnHint = jid ? entry.lidToPn.get(jid) ?? null : null;
          if (!nameHint && pnHint) {
            nameHint = entry.knownNames.get(pnHint) ?? null;
          }
          // Para grupos sem assunto em cache, busca subject do grupo em segundo plano leve
          if (jid && isGroupJid(jid) && !nameHint) {
            try {
              const meta = await sock.groupMetadata(jid);
              if (meta?.subject) {
                nameHint = meta.subject;
                entry.knownNames.set(jid, meta.subject);
              }
            } catch {
              // Ignora se não conseguir ler metadados do grupo
            }
          }

          await processWhatsAppMessage({
            organizationId,
            connectionId,
            defaultDepartmentId: conn.defaultDepartmentId,
            msg,
            sock,
            contactNameHint: nameHint,
            phoneJidHint: pnHint,
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

  /**
   * Força a ressincronização da agenda de contatos no Baileys (resyncAppState)
   * e persiste imediatamente os contatos já recebidos na sessão em lotes de 100.
   */
  async syncContacts(
    connectionId: string,
    organizationId: string
  ): Promise<{ importedCount: number; updatedCount: number; totalContacts: number }> {
    const entry = this.sessions.get(connectionId);
    if (!entry || entry.organizationId !== organizationId || !entry.socket || entry.status !== 'CONNECTED') {
      throw new Error('Conexão WhatsApp não está conectada no momento. Conecte via QR Code antes de sincronizar contatos.');
    }

    // Dispara ressincronização do AppState (contatos, nomes salvos e metadados) com timeout de segurança
    try {
      await Promise.race([
        entry.socket.resyncAppState(ALL_WA_PATCH_NAMES, false),
        new Promise<void>((resolve) => setTimeout(resolve, 8000)),
      ]);
    } catch (err) {
      console.warn('[WhatsApp] Aviso ao executar resyncAppState:', err);
    }

    // Persiste imediatamente todos os contatos acumulados na sessão
    const batchContacts = Array.from(entry.knownContacts.values());
    const batchResult = await syncWhatsAppContactsBatch({
      organizationId,
      connectionId,
      contacts: batchContacts,
      lidToPn: entry.lidToPn,
      emitEvent: false,
    });

    // Também dispara busca de fotos de perfil em segundo plano
    void enqueueMissingAvatarsForOrganization({
      organizationId,
      connectionId,
      sock: entry.socket,
      lidToPn: entry.lidToPn,
      knownNames: entry.knownNames,
      force: true,
    });

    const totalContacts = await prisma.contact.count({
      where: { organizationId },
    });

    emitToOrganization(organizationId, 'whatsapp:contacts_synced', {
      connectionId,
      importedCount: batchResult.importedCount,
      updatedCount: batchResult.updatedCount,
      totalContacts,
    });

    return {
      importedCount: batchResult.importedCount,
      updatedCount: batchResult.updatedCount,
      totalContacts,
    };
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
      await fs.rm(this.getSessionDir(connectionId), { recursive: true, force: true }).catch(() => { });
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
