import fs from 'node:fs/promises';
import path from 'node:path';
import { Boom } from '@hapi/boom';
import {
  ALL_WA_PATCH_NAMES,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeWASocket,
  type Contact as WaContact,
  type WASocket,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { ChannelType, ConnectionProvider, ConnectionStatus } from '@prisma/client';

import { env } from '../../config/env.js';
import { prisma } from '../../shared/database/prisma.js';
import { apiCache } from '../../shared/cache/api-cache.js';
import { extractDigitsFromJid, formatPhoneFromJid, isGroupJid, isLidJid } from '../../shared/formatters/ticket.js';
import { emitToOrganization } from '../../realtime/socket.js';
import {
  useDatabaseAuthState,
  type ManagedBaileysAuthState,
} from './whatsapp.auth-state.js';
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

export type ContactPresenceState = 'typing' | 'recording';

interface ActivePresenceEntry {
  organizationId: string;
  connectionId: string;
  conversationId: string;
  status: ContactPresenceState;
  updatedAt: number;
  lastEmittedAt: number;
  timer: NodeJS.Timeout;
}

const PRESENCE_TIMEOUT_MS = 15_000; // 15s de segurança caso o WhatsApp não envie 'paused'
const PRESENCE_REEMIT_THROTTLE_MS = 2_000;
const PRESENCE_SUBSCRIBE_THROTTLE_MS = 30_000;
const JID_CONV_CACHE_TTL_MS = 5 * 60_000;
const JID_CONV_CACHE_MAX_SIZE = 2000;

function normalizePresenceJid(rawJid: string | null | undefined): string | null {
  if (!rawJid || typeof rawJid !== 'string') return null;
  const trimmed = rawJid.trim();
  if (!trimmed) return null;
  // Remove sufixo de dispositivo (ex.: 5511999999999:12@s.whatsapp.net -> 5511999999999@s.whatsapp.net)
  const atIdx = trimmed.indexOf('@');
  if (atIdx === -1) return trimmed;
  const userPart = trimmed.slice(0, atIdx).split(':')[0] ?? '';
  const serverPart = trimmed.slice(atIdx);
  return userPart ? `${userPart}${serverPart}` : null;
}

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
  authState: ManagedBaileysAuthState | null;
}

const SESSIONS_ROOT = path.resolve(process.cwd(), '.baileys_sessions');
const baileysLogger = pino({ level: 'silent' });

class WhatsAppSessionManager {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly activePresences = new Map<string, ActivePresenceEntry>();
  private readonly jidToConversationCache = new Map<string, { conversationId: string; expiresAt: number }>();
  private readonly presenceSubscribedAt = new Map<string, number>();

  private getSessionDir(connectionId: string): string {
    return path.join(SESSIONS_ROOT, connectionId);
  }

  getConversationPresence(conversationId: string): ContactPresenceState | null {
    const entry = this.activePresences.get(conversationId);
    if (!entry) return null;
    if (Date.now() - entry.updatedAt > PRESENCE_TIMEOUT_MS) {
      clearTimeout(entry.timer);
      this.activePresences.delete(conversationId);
      return null;
    }
    return entry.status;
  }

  private cacheConversationJid(connectionId: string, jid: string | null | undefined, conversationId: string): void {
    const normalized = normalizePresenceJid(jid);
    if (!normalized) return;
    if (this.jidToConversationCache.size >= JID_CONV_CACHE_MAX_SIZE) {
      this.jidToConversationCache.clear();
    }
    this.jidToConversationCache.set(`${connectionId}:${normalized}`, {
      conversationId,
      expiresAt: Date.now() + JID_CONV_CACHE_TTL_MS,
    });
  }

  private async resolveConversationIdForJid(
    organizationId: string,
    connectionId: string,
    rawJid: string,
    lidToPn: Map<string, string>
  ): Promise<string | null> {
    const normalized = normalizePresenceJid(rawJid);
    if (!normalized) return null;

    const candidates = new Set<string>([rawJid, normalized]);
    const mappedPn = lidToPn.get(rawJid) ?? lidToPn.get(normalized);
    if (mappedPn) {
      candidates.add(mappedPn);
      const normPn = normalizePresenceJid(mappedPn);
      if (normPn) candidates.add(normPn);
    }

    const now = Date.now();
    for (const candidate of candidates) {
      const cached = this.jidToConversationCache.get(`${connectionId}:${candidate}`);
      if (cached && cached.expiresAt > now) {
        return cached.conversationId;
      }
    }

    const candidateList = Array.from(candidates);
    const identity = await prisma.contactIdentity.findFirst({
      where: {
        connectionId,
        externalContactId: { in: candidateList },
      },
      select: { contactId: true },
    });

    let contactId = identity?.contactId ?? null;
    if (!contactId) {
      const pnSource = mappedPn ?? (!isLidJid(normalized) && !isGroupJid(normalized) ? normalized : null);
      const digits = (pnSource ? extractDigitsFromJid(pnSource) : null) ?? '';
      if (digits.length >= 8) {
        const contact = await prisma.contact.findFirst({
          where: {
            organizationId,
            phoneE164: { endsWith: digits.slice(-10) },
          },
          select: { id: true },
        });
        contactId = contact?.id ?? null;
      }
    }

    if (!contactId) return null;

    const conv =
      (await prisma.conversation.findFirst({
        where: {
          organizationId,
          connectionId,
          contactId,
          status: { in: ['OPEN', 'PENDING'] },
        },
        orderBy: { lastMessageAt: 'desc' },
        select: { id: true },
      })) ??
      (await prisma.conversation.findFirst({
        where: {
          organizationId,
          connectionId,
          contactId,
        },
        orderBy: { lastMessageAt: 'desc' },
        select: { id: true },
      }));

    if (!conv) return null;

    for (const candidate of candidateList) {
      this.cacheConversationJid(connectionId, candidate, conv.id);
    }
    return conv.id;
  }

  private setConversationPresence(
    organizationId: string,
    connectionId: string,
    conversationId: string,
    status: ContactPresenceState | null
  ): void {
    const existing = this.activePresences.get(conversationId);

    if (!status) {
      if (!existing) return;
      clearTimeout(existing.timer);
      this.activePresences.delete(conversationId);
      emitToOrganization(organizationId, 'conversation:presence', {
        conversationId,
        connectionId,
        status: null,
        updatedAt: new Date().toISOString(),
      });
      return;
    }

    const now = Date.now();
    if (existing) {
      clearTimeout(existing.timer);
    }

    const timer = setTimeout(() => {
      this.setConversationPresence(organizationId, connectionId, conversationId, null);
    }, PRESENCE_TIMEOUT_MS);

    const shouldEmit =
      !existing ||
      existing.status !== status ||
      now - existing.lastEmittedAt >= PRESENCE_REEMIT_THROTTLE_MS;

    this.activePresences.set(conversationId, {
      organizationId,
      connectionId,
      conversationId,
      status,
      updatedAt: now,
      lastEmittedAt: shouldEmit ? now : existing?.lastEmittedAt ?? now,
      timer,
    });

    if (shouldEmit) {
      emitToOrganization(organizationId, 'conversation:presence', {
        conversationId,
        connectionId,
        status,
        expiresInMs: PRESENCE_TIMEOUT_MS,
        updatedAt: new Date(now).toISOString(),
      });
    }
  }

  private clearAllPresencesForConnection(connectionId: string): void {
    for (const [convId, entry] of this.activePresences.entries()) {
      if (entry.connectionId === connectionId) {
        this.setConversationPresence(entry.organizationId, connectionId, convId, null);
      }
    }
    const jidPrefix = `${connectionId}:`;
    for (const key of this.jidToConversationCache.keys()) {
      if (key.startsWith(jidPrefix)) {
        this.jidToConversationCache.delete(key);
      }
    }
  }

  private async handlePresenceUpdate(
    organizationId: string,
    connectionId: string,
    entry: SessionEntry,
    update: { id: string; presences: Record<string, { lastKnownPresence?: string; lastSeen?: number }> }
  ): Promise<void> {
    const chatJid = update?.id;
    if (!chatJid || !update?.presences || entry.paused) return;

    const selfUserBare = normalizePresenceJid(entry.socket?.user?.id)?.split('@')[0] ?? null;
    const selfLidBare = normalizePresenceJid(entry.socket?.user?.lid)?.split('@')[0] ?? null;

    let nextState: ContactPresenceState | null = null;
    let sawClearEvent = false;

    for (const [participantJid, presenceData] of Object.entries(update.presences)) {
      const pBare = normalizePresenceJid(participantJid)?.split('@')[0] ?? null;
      if (pBare && (pBare === selfUserBare || pBare === selfLidBare)) {
        continue;
      }

      const rawState = presenceData?.lastKnownPresence;
      if (rawState === 'recording') {
        nextState = 'recording';
        break;
      }
      if (rawState === 'composing') {
        nextState = 'typing';
      } else if (rawState === 'paused' || rawState === 'available' || rawState === 'unavailable') {
        sawClearEvent = true;
      }
    }

    if (!nextState && !sawClearEvent) return;

    const conversationId = await this.resolveConversationIdForJid(
      organizationId,
      connectionId,
      chatJid,
      entry.lidToPn
    );
    if (!conversationId) return;

    this.setConversationPresence(organizationId, connectionId, conversationId, nextState);
  }

  private async clearPresenceForIncomingJid(
    organizationId: string,
    connectionId: string,
    rawJid: string | null | undefined,
    lidToPn: Map<string, string>
  ): Promise<void> {
    if (!rawJid) return;
    const conversationId = await this.resolveConversationIdForJid(
      organizationId,
      connectionId,
      rawJid,
      lidToPn
    );
    if (conversationId) {
      this.setConversationPresence(organizationId, connectionId, conversationId, null);
    }
  }

  /**
   * Inscreve o socket Baileys nos eventos de presença (`presenceSubscribe`) do contato da conversa.
   * Executa com throttle (30s) e try/catch seguro para nunca impactar a abertura do chat.
   */
  async subscribePresenceForConversation(organizationId: string, conversationId: string): Promise<void> {
    const now = Date.now();
    const lastSub = this.presenceSubscribedAt.get(conversationId);
    if (lastSub && now - lastSub < PRESENCE_SUBSCRIBE_THROTTLE_MS) {
      return;
    }

    try {
      const conv = await prisma.conversation.findFirst({
        where: { id: conversationId, organizationId },
        select: {
          id: true,
          connectionId: true,
          contact: {
            select: {
              phoneE164: true,
              identities: {
                select: { connectionId: true, externalContactId: true },
              },
            },
          },
        },
      });
      if (!conv) return;

      const entry = this.sessions.get(conv.connectionId);
      if (!entry?.socket || entry.status !== 'CONNECTED' || entry.paused) return;

      const connIdentities = conv.contact.identities.filter((i) => i.connectionId === conv.connectionId);
      const preferredIdentity =
        connIdentities.find((i) => i.externalContactId.endsWith('@s.whatsapp.net') || i.externalContactId.endsWith('@g.us')) ??
        connIdentities[0];

      let targetJid: string | null = preferredIdentity?.externalContactId ?? null;
      if (targetJid && isLidJid(targetJid)) {
        const mappedPn = entry.lidToPn.get(targetJid);
        if (mappedPn) targetJid = mappedPn;
      }
      if (!targetJid && conv.contact.phoneE164) {
        const digits = conv.contact.phoneE164.replace(/\D/g, '');
        if (digits.length >= 8 && digits.length <= 15) {
          targetJid = `${digits}@s.whatsapp.net`;
        }
      }

      if (!targetJid) return;

      // Pré-aquece o cache JID -> conversationId para latência zero quando o evento chegar
      this.cacheConversationJid(conv.connectionId, targetJid, conv.id);
      for (const ident of connIdentities) {
        this.cacheConversationJid(conv.connectionId, ident.externalContactId, conv.id);
      }

      this.presenceSubscribedAt.set(conversationId, now);
      await entry.socket.presenceSubscribe(targetJid);
    } catch {
      // Falha silenciosa: presenceSubscribe é best-effort no WhatsApp
    }
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
    const authState = await useDatabaseAuthState({
      connectionId,
      organizationId,
      legacySessionDir: sessionDir,
    });
    const { state, saveCreds } = authState;

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
      authState,
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

        apiCache.invalidateOrgConversations(organizationId);

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
          this.clearAllPresencesForConnection(connectionId);
          entry.status = 'DISCONNECTED';
          entry.socket = null;
          await entry.authState?.clearState().catch(() => {});
          await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
          await prisma.connection.updateMany({
            where: { id: connectionId, organizationId },
            data: { status: ConnectionStatus.DISCONNECTED, credentialsEncrypted: null },
          });
          apiCache.invalidateOrgConversations(organizationId);
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
          if (jid && !msg.key?.fromMe) {
            void this.clearPresenceForIncomingJid(organizationId, connectionId, jid, entry.lidToPn);
          }
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

    // Presença em tempo real do contato ("digitando..." / "gravando áudio...")
    sock.ev.on('presence.update', (update) => {
      void this.handlePresenceUpdate(organizationId, connectionId, entry, update).catch(() => {});
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
      this.clearAllPresencesForConnection(connectionId);
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
      await entry?.authState?.clearState().catch(() => {});
      await fs.rm(this.getSessionDir(connectionId), { recursive: true, force: true }).catch(() => {});
    }

    await prisma.connection.updateMany({
      where: { id: connectionId, organizationId },
      data: {
        status: ConnectionStatus.DISCONNECTED,
        ...(clearAuth ? { credentialsEncrypted: null } : {}),
      },
    });

    apiCache.invalidateOrgConversations(organizationId);

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
   * Reconecta automaticamente sessões Baileys ativas salvas no PostgreSQL (credentials_encrypted)
   * ou no disco legado (.baileys_sessions), sobrevivendo a reinícios e redeploys na nuvem.
   */
  async restoreActiveSessions(): Promise<void> {
    try {
      const activeConns = await prisma.connection.findMany({
        where: {
          channel: ChannelType.WHATSAPP,
          provider: ConnectionProvider.BAILEYS,
          status: ConnectionStatus.ACTIVE,
        },
        select: { id: true, organizationId: true, credentialsEncrypted: true },
      });

      for (const conn of activeConns) {
        if (env.BAILEYS_AUTH_STORAGE === 'database' && conn.credentialsEncrypted) {
          void this.startSession(conn.id, conn.organizationId);
          continue;
        }

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
