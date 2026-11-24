import crypto from 'node:crypto';
import {
  downloadMediaMessage,
  type Chat,
  type Contact as WaContact,
  type LIDMapping,
  type WAMessage,
  type WAMessageUpdate,
  type WASocket,
} from '@whiskeysockets/baileys';
import {
  ConversationStatus,
  MessageContentType,
  MessageDeliveryStatus,
  MessageDirection,
  MessageSenderType,
  MessageVisibility,
  Prisma,
  type Contact,
  type Conversation,
} from '@prisma/client';
import pino from 'pino';

import { prisma } from '../../shared/database/prisma.js';
import { storageService } from '../../shared/storage/supabase-storage.js';
import { apiCache } from '../../shared/cache/api-cache.js';
import {
  extractDigitsFromJid,
  formatPhoneFromJid,
  formatTicketNumber,
  getInitials,
  isGroupJid,
  isLidJid,
  isSuspiciousLidPhone,
} from '../../shared/formatters/ticket.js';
import { emitToOrganization } from '../../realtime/socket.js';

const silentLogger = pino({ level: 'silent' });

// Include padronizado para serializar conversas em uma única consulta Prisma (elimina N+1)
export const CONVERSATION_CLIENT_INCLUDE = {
  contact: {
    select: {
      id: true,
      name: true,
      roleTitle: true,
      phoneE164: true,
      email: true,
      avatarUrl: true,
    },
  },
  connection: { select: { id: true, name: true, channel: true, identifier: true } },
  department: { select: { id: true, name: true } },
  assignee: { select: { id: true, name: true, role: true } },
  labels: { include: { label: { select: { id: true, name: true, color: true } } } },
  messages: {
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: {
      id: true,
      visibility: true,
      direction: true,
      content: true,
      createdAt: true,
    },
  },
} satisfies Prisma.ConversationInclude;

export type ConversationWithClientRelations = Prisma.ConversationGetPayload<{
  include: typeof CONVERSATION_CLIENT_INCLUDE;
}>;

export function formatConversationForClient(conv: ConversationWithClientRelations) {
  const lastMsg = conv.messages[0] ?? null;
  const rawName = conv.contact.name;
  const displayName = isSuspiciousLidPhone(rawName) ? 'Contato WhatsApp' : rawName;

  let phoneDisplay: string;
  if (conv.contact.roleTitle?.includes('Grupo')) {
    phoneDisplay = displayName;
  } else if (!conv.contact.phoneE164 || isSuspiciousLidPhone(conv.contact.phoneE164)) {
    phoneDisplay = displayName;
  } else {
    phoneDisplay =
      formatPhoneFromJid(`${conv.contact.phoneE164.replace(/\D/g, '')}@s.whatsapp.net`) ||
      displayName;
  }

  return {
    id: conv.id,
    protocolNumber: conv.protocolNumber,
    ticketNumber: formatTicketNumber(conv.createdAt, conv.protocolNumber),
    status: conv.status.toLowerCase(), // open | pending | resolved
    assigneeId: conv.assigneeId,
    assigneeName: conv.assignee?.name ?? null,
    connectionId: conv.connectionId,
    connection: conv.connection.name,
    channel:
      conv.connection.channel === 'WHATSAPP'
        ? 'WhatsApp'
        : conv.connection.channel === 'WEBCHAT'
          ? 'WebChat'
          : 'Instagram',
    departmentId: conv.departmentId,
    department: conv.department?.name ?? 'Suporte',
    unread: conv.unreadCount,
    createdAt: conv.createdAt.toISOString(),
    lastMessageAt: conv.lastMessageAt.toISOString(),
    labels: conv.labels.map((l) => l.label.name),
    contact: {
      id: conv.contact.id,
      name: displayName,
      initials: getInitials(displayName),
      role: conv.contact.roleTitle ?? 'WhatsApp',
      phone: phoneDisplay,
      email: conv.contact.email ?? '-',
      avatarUrl: conv.contact.avatarUrl ?? null,
    },
    lastMessage: lastMsg
      ? {
        id: lastMsg.id,
        type:
          lastMsg.visibility === MessageVisibility.PRIVATE_NOTE
            ? 'private'
            : lastMsg.direction === MessageDirection.OUTGOING
              ? 'outgoing'
              : 'incoming',
        text: lastMsg.content,
        createdAt: lastMsg.createdAt.toISOString(),
      }
      : null,
  };
}

export async function serializeConversationForClient(conversationId: string) {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: CONVERSATION_CLIENT_INCLUDE,
  });

  if (!conv) return null;
  return formatConversationForClient(conv);
}

// =============================================================================
// FILA EM SEGUNDO PLANO PARA FOTOS DE PERFIL (smv-avatars) COM TIMEOUT DE 5s
// =============================================================================
const AVATAR_SYNC_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas
const AVATAR_STEP_TIMEOUT_MS = 5_000; // 5 segundos por operação para nunca travar slot
const MAX_CONCURRENT_AVATAR_JOBS = 3;
const ORG_AVATAR_SCAN_THROTTLE_MS = 20_000; // evita scans repetidos em rajadas de GET /conversations

const avatarSyncedAt = new Map<string, number>();
const avatarPendingIds = new Set<string>();
const avatarQueue: Array<() => Promise<void>> = [];
const lastOrgAvatarScanAt = new Map<string, number>();
let activeAvatarJobs = 0;

function withTimeout<T>(promise: Promise<T>, ms: number, label = 'timeout'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timeout (${ms}ms): ${label}`)), ms);
    }),
  ]);
}

function isAvatarQueryableJid(jid: string | null | undefined): jid is string {
  if (!jid || isLidJid(jid)) return false;
  return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@g.us');
}

function drainAvatarQueue(): void {
  while (activeAvatarJobs < MAX_CONCURRENT_AVATAR_JOBS && avatarQueue.length > 0) {
    const job = avatarQueue.shift();
    if (!job) break;
    activeAvatarJobs += 1;
    void Promise.resolve()
      .then(() => job())
      .catch(() => { })
      .finally(() => {
        activeAvatarJobs = Math.max(0, activeAvatarJobs - 1);
        if (avatarQueue.length > 0) {
          setImmediate(drainAvatarQueue);
        }
      });
  }
}

export function scheduleContactAvatarSync(params: {
  sock: WASocket | null | undefined;
  organizationId: string;
  contactId: string;
  conversationId: string;
  jid: string | null | undefined;
  existingAvatarUrl: string | null;
}): void {
  const { sock, organizationId, contactId, conversationId, jid, existingAvatarUrl } = params;
  // Nunca tenta buscar foto de perfil para @lid (trava ou falha no WhatsApp)
  if (!sock || !isAvatarQueryableJid(jid)) return;

  const now = Date.now();
  const lastAttempt = avatarSyncedAt.get(contactId);
  if (lastAttempt && now - lastAttempt < AVATAR_SYNC_TTL_MS) return;
  if (existingAvatarUrl && !lastAttempt) {
    avatarSyncedAt.set(contactId, now);
    return;
  }
  if (avatarPendingIds.has(contactId)) return;

  avatarPendingIds.add(contactId);
  avatarSyncedAt.set(contactId, now);

  avatarQueue.push(async () => {
    try {
      let picUrl: string | undefined;
      try {
        picUrl = await withTimeout(
          sock.profilePictureUrl(jid, 'image'),
          AVATAR_STEP_TIMEOUT_MS,
          'profilePictureUrl:image'
        );
      } catch {
        try {
          picUrl = await withTimeout(
            sock.profilePictureUrl(jid, 'preview'),
            AVATAR_STEP_TIMEOUT_MS,
            'profilePictureUrl:preview'
          );
        } catch {
          picUrl = undefined;
        }
      }

      if (!picUrl) return;

      const response = await withTimeout(fetch(picUrl), AVATAR_STEP_TIMEOUT_MS, 'fetch:avatar');
      if (!response.ok) return;

      const contentType = response.headers.get('content-type') || 'image/jpeg';
      if (!contentType.startsWith('image/')) return;

      const arrayBuf = await withTimeout(
        response.arrayBuffer(),
        AVATAR_STEP_TIMEOUT_MS,
        'arrayBuffer:avatar'
      );
      const buffer = Buffer.from(arrayBuf);
      if (buffer.length === 0 || buffer.length > 5 * 1024 * 1024) return;

      const ext = contentType.includes('png')
        ? '.png'
        : contentType.includes('webp')
          ? '.webp'
          : '.jpg';

      const uploaded = await withTimeout(
        storageService.uploadAvatar({
          organizationId,
          entityType: 'contacts',
          entityId: contactId,
          fileName: `avatar${ext}`,
          mimeType: contentType,
          buffer,
        }),
        AVATAR_STEP_TIMEOUT_MS,
        'uploadAvatar'
      );

      if (!uploaded.publicUrl) return;

      await withTimeout(
        prisma.contact.update({
          where: { id: contactId },
          data: {
            avatarBucket: uploaded.bucket,
            avatarPath: uploaded.storagePath,
            avatarUrl: uploaded.publicUrl,
          },
        }),
        AVATAR_STEP_TIMEOUT_MS,
        'prisma:avatarUpdate'
      );

      apiCache.patchContactAvatar(organizationId, contactId, uploaded.publicUrl);

      emitToOrganization(organizationId, 'contact:avatar_updated', {
        contactId,
        conversationId,
        avatarUrl: uploaded.publicUrl,
      });
    } catch {
      // Timeout, privacidade ou rede: libera o slot imediatamente para o próximo contato da fila
    } finally {
      avatarPendingIds.delete(contactId);
    }
  });

  drainAvatarQueue();
}

/**
 * Enfileira todos os contatos/grupos da organização com avatarUrl: null (usando @s.whatsapp.net ou @g.us)
 * e limpa contatos legados que ficaram com telefone falso de 15 dígitos iniciado em +1 (@lid).
 */
export async function enqueueMissingAvatarsForOrganization(params: {
  organizationId: string;
  sock: WASocket | null | undefined;
  connectionId?: string;
  lidToPn?: Map<string, string>;
  knownNames?: Map<string, string>;
  force?: boolean;
}): Promise<void> {
  const { organizationId, sock, connectionId, lidToPn, knownNames, force } = params;
  const now = Date.now();
  const lastScan = lastOrgAvatarScanAt.get(organizationId) ?? 0;
  if (!force && now - lastScan < ORG_AVATAR_SCAN_THROTTLE_MS) return;
  lastOrgAvatarScanAt.set(organizationId, now);

  try {
    const conversations = await prisma.conversation.findMany({
      where: {
        organizationId,
        ...(connectionId ? { connectionId } : {}),
        OR: [
          { contact: { avatarUrl: null } },
          { contact: { phoneE164: { startsWith: '+1' } } },
        ],
      },
      orderBy: { lastMessageAt: 'desc' },
      take: 200,
      select: {
        id: true,
        contact: {
          select: {
            id: true,
            name: true,
            phoneE164: true,
            avatarUrl: true,
            identities: {
              select: {
                externalContactId: true,
                metadata: true,
              },
            },
          },
        },
      },
    });

    const seenContacts = new Set<string>();
    let cleanedAnyContact = false;

    for (const conv of conversations) {
      const contact = conv.contact;
      if (seenContacts.has(contact.id)) continue;
      seenContacts.add(contact.id);

      let targetJid: string | null = null;
      let resolvedPhoneE164: string | null = null;
      let lidJidFound: string | null = null;

      for (const idRec of contact.identities) {
        const ext = idRec.externalContactId;
        if (isAvatarQueryableJid(ext)) {
          targetJid = ext;
          if (!isGroupJid(ext)) {
            resolvedPhoneE164 = extractDigitsFromJid(ext);
          }
          break;
        }
        if (isLidJid(ext)) {
          lidJidFound = ext;
          const meta =
            idRec.metadata && typeof idRec.metadata === 'object' && !Array.isArray(idRec.metadata)
              ? (idRec.metadata as Record<string, unknown>)
              : null;
          const metaPn = typeof meta?.phoneJid === 'string' ? meta.phoneJid : null;
          const mappedPn = metaPn || lidToPn?.get(ext) || null;
          if (isAvatarQueryableJid(mappedPn)) {
            targetJid = mappedPn;
            resolvedPhoneE164 = extractDigitsFromJid(mappedPn);
          }
        }
      }

      if (!targetJid && contact.phoneE164 && !isSuspiciousLidPhone(contact.phoneE164)) {
        const digits = contact.phoneE164.replace(/\D/g, '');
        if (digits.length >= 8 && digits.length <= 15 && !(digits.length === 15 && digits.startsWith('1'))) {
          targetJid = `${digits}@s.whatsapp.net`;
        }
      }

      // Limpeza de contatos antigos com telefone/nome falso de 15 dígitos iniciado em +1 (originado de @lid)
      const updates: Prisma.ContactUpdateInput = {};
      if (isSuspiciousLidPhone(contact.phoneE164)) {
        updates.phoneE164 = resolvedPhoneE164;
      }
      if (isSuspiciousLidPhone(contact.name)) {
        const betterName =
          (lidJidFound && knownNames?.get(lidJidFound)) ||
          (targetJid && knownNames?.get(targetJid)) ||
          (resolvedPhoneE164
            ? formatPhoneFromJid(`${resolvedPhoneE164.replace(/\D/g, '')}@s.whatsapp.net`)
            : null) ||
          'Contato WhatsApp';
        updates.name = betterName;
      }

      if (Object.keys(updates).length > 0) {
        await prisma.contact.update({
          where: { id: contact.id },
          data: updates,
        });
        cleanedAnyContact = true;
      }

      if (!contact.avatarUrl && sock && targetJid) {
        scheduleContactAvatarSync({
          sock,
          organizationId,
          contactId: contact.id,
          conversationId: conv.id,
          jid: targetJid,
          existingAvatarUrl: null,
        });
      }
    }

    if (cleanedAnyContact) {
      apiCache.invalidateOrgConversations(organizationId);
    }
  } catch (err) {
    console.warn('[WhatsApp Avatars] Falha ao enfileirar avatares pendentes:', err);
  }
}

// =============================================================================
// AUXILIARES DE JID, TELEFONE REAL (SEM @lid FALSO) E EXTRAÇÃO DE CONTEÚDO
// =============================================================================
function isSupportedJid(jid: string | null | undefined): jid is string {
  if (!jid) return false;
  if (jid === 'status@broadcast') return false;
  if (jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return false;
  return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@g.us') || jid.endsWith('@lid');
}

function normalizePhoneJidCandidate(candidate: unknown): string | null {
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  if (!trimmed || isLidJid(trimmed) || isGroupJid(trimmed)) return null;
  if (trimmed.endsWith('@s.whatsapp.net')) {
    return extractDigitsFromJid(trimmed) ? trimmed : null;
  }
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length >= 8 && digits.length <= 15 && !(digits.length === 15 && digits.startsWith('1'))) {
    return `${digits}@s.whatsapp.net`;
  }
  return null;
}

function extractRealPhoneJidFromMessage(msg: WAMessage, phoneJidHint?: string | null): string | null {
  const key = msg.key as Record<string, unknown> | undefined;
  const rawMsg = msg as unknown as Record<string, unknown>;
  const remoteJid = msg.key?.remoteJid;
  const isGroup = isGroupJid(remoteJid);

  const candidates: unknown[] = isGroup
    ? []
    : [
      remoteJid,
      key?.remoteJidAlt,
      key?.senderPn,
      key?.participantPn,
      key?.participantAlt,
      rawMsg.senderPn,
      rawMsg.participantPn,
      phoneJidHint,
    ];

  for (const cand of candidates) {
    const normalized = normalizePhoneJidCandidate(cand);
    if (normalized) return normalized;
  }
  return null;
}

function unwrapMessageContent(msg: WAMessage): WAMessage['message'] {
  const m = msg.message;
  if (!m) return undefined;
  if (m.ephemeralMessage?.message) return m.ephemeralMessage.message;
  if (m.viewOnceMessage?.message) return m.viewOnceMessage.message;
  if (m.viewOnceMessageV2?.message) return m.viewOnceMessageV2.message;
  return m;
}

interface ExtractedMessage {
  content: string;
  contentType: MessageContentType;
  quotedExternalId: string | null;
  hasDownloadableMedia: boolean;
  mediaFileName: string;
  mediaMimeType: string;
}

function extractMessageDetails(msg: WAMessage): ExtractedMessage | null {
  const m = unwrapMessageContent(msg);
  if (!m) return null;

  // Ignora eventos de protocolo/reação vazios
  if (m.protocolMessage || m.senderKeyDistributionMessage) {
    return null;
  }

  const contextInfo =
    m.extendedTextMessage?.contextInfo ??
    m.imageMessage?.contextInfo ??
    m.videoMessage?.contextInfo ??
    m.documentMessage?.contextInfo ??
    m.audioMessage?.contextInfo;

  const quotedExternalId = contextInfo?.stanzaId ?? null;

  if (m.conversation) {
    return {
      content: m.conversation,
      contentType: MessageContentType.TEXT,
      quotedExternalId,
      hasDownloadableMedia: false,
      mediaFileName: '',
      mediaMimeType: '',
    };
  }

  if (m.extendedTextMessage?.text) {
    return {
      content: m.extendedTextMessage.text,
      contentType: MessageContentType.TEXT,
      quotedExternalId,
      hasDownloadableMedia: false,
      mediaFileName: '',
      mediaMimeType: '',
    };
  }

  if (m.imageMessage) {
    return {
      content: m.imageMessage.caption || '📷 Imagem',
      contentType: MessageContentType.IMAGE,
      quotedExternalId,
      hasDownloadableMedia: true,
      mediaFileName: `imagem-${Date.now()}.jpg`,
      mediaMimeType: m.imageMessage.mimetype || 'image/jpeg',
    };
  }

  if (m.videoMessage) {
    return {
      content: m.videoMessage.caption || '🎬 Vídeo',
      contentType: MessageContentType.VIDEO,
      quotedExternalId,
      hasDownloadableMedia: true,
      mediaFileName: `video-${Date.now()}.mp4`,
      mediaMimeType: m.videoMessage.mimetype || 'video/mp4',
    };
  }

  if (m.audioMessage) {
    return {
      content: m.audioMessage.ptt ? '🎤 Mensagem de voz' : '🎧 Áudio',
      contentType: MessageContentType.AUDIO,
      quotedExternalId,
      hasDownloadableMedia: true,
      mediaFileName: `audio-${Date.now()}.ogg`,
      mediaMimeType: m.audioMessage.mimetype || 'audio/ogg',
    };
  }

  if (m.documentMessage) {
    const fileName = m.documentMessage.fileName || `documento-${Date.now()}`;
    return {
      content: m.documentMessage.caption || `📄 ${fileName}`,
      contentType: MessageContentType.DOCUMENT,
      quotedExternalId,
      hasDownloadableMedia: true,
      mediaFileName: fileName,
      mediaMimeType: m.documentMessage.mimetype || 'application/octet-stream',
    };
  }

  if (m.stickerMessage) {
    return {
      content: 'Figurinha',
      contentType: MessageContentType.IMAGE,
      quotedExternalId,
      hasDownloadableMedia: true,
      mediaFileName: `sticker-${Date.now()}.webp`,
      mediaMimeType: m.stickerMessage.mimetype || 'image/webp',
    };
  }

  if (m.contactMessage) {
    return {
      content: `👤 Contato: ${m.contactMessage.displayName || 'Sem nome'}`,
      contentType: MessageContentType.TEXT,
      quotedExternalId,
      hasDownloadableMedia: false,
      mediaFileName: '',
      mediaMimeType: '',
    };
  }

  if (m.locationMessage) {
    const lat = m.locationMessage.degreesLatitude ?? 0;
    const lng = m.locationMessage.degreesLongitude ?? 0;
    return {
      content: `📍 Localização (${lat.toFixed(5)}, ${lng.toFixed(5)})`,
      contentType: MessageContentType.LOCATION,
      quotedExternalId,
      hasDownloadableMedia: false,
      mediaFileName: '',
      mediaMimeType: '',
    };
  }

  if (m.pollCreationMessage?.name || m.pollCreationMessageV3?.name) {
    const pollName = m.pollCreationMessage?.name || m.pollCreationMessageV3?.name || 'Enquete';
    return {
      content: `📊 Enquete: ${pollName}`,
      contentType: MessageContentType.TEXT,
      quotedExternalId,
      hasDownloadableMedia: false,
      mediaFileName: '',
      mediaMimeType: '',
    };
  }

  return null;
}

function getMessageDate(msg: WAMessage): Date {
  const ts = msg.messageTimestamp;
  if (!ts) return new Date();
  const num = typeof ts === 'number' ? ts : Number(ts);
  if (!Number.isFinite(num) || num <= 0) return new Date();
  return new Date(num > 1e12 ? num : num * 1000);
}

function isFakeLidDigitsPhone(phoneValue: string | null | undefined, remoteJid: string): boolean {
  if (!phoneValue) return false;
  if (isSuspiciousLidPhone(phoneValue)) return true;
  if (!isLidJid(remoteJid)) return false;
  const lidDigits = (remoteJid.split('@')[0]?.split(':')[0] ?? '').replace(/\D/g, '');
  const phoneDigits = phoneValue.replace(/\D/g, '');
  return Boolean(lidDigits && phoneDigits && lidDigits === phoneDigits);
}

function isPlaceholderContactName(name: string, remoteJid: string): boolean {
  if (!name) return true;
  if (name === 'Contato WhatsApp') return true;
  if (name.startsWith('+') || name.startsWith('Grupo ')) return true;
  if (isFakeLidDigitsPhone(name, remoteJid)) return true;
  return false;
}

// =============================================================================
// MAPA EM MEMÓRIA POR LOTE DE SINCRONIZAÇÃO (ELIMINA QUERIES REPETIDAS)
// =============================================================================
export interface SyncBatchCache {
  contactByJid: Map<string, Contact>;
  conversationByContactId: Map<string, Conversation>;
  existingExternalIdsByConv: Map<string, Set<string>>;
  pendingLastMessageAtByConv: Map<string, Date>;
}

async function resolveOrCreateContactAndConversation(params: {
  organizationId: string;
  connectionId: string;
  defaultDepartmentId: string | null;
  remoteJid: string;
  realPhoneJid?: string | null;
  displayName?: string | null;
  messageDate: Date;
  batchCache?: SyncBatchCache;
}) {
  const isGroup = isGroupJid(params.remoteJid);
  const isLid = isLidJid(params.remoteJid);
  const batch = params.batchCache;

  // Nunca formata @lid ou @g.us como telefone; usa somente JID telefônico real quando disponível
  const phoneSourceJid = isGroup ? null : params.realPhoneJid || (!isLid ? params.remoteJid : null);
  const phonePretty = phoneSourceJid ? formatPhoneFromJid(phoneSourceJid) : '';
  const phoneE164 = phoneSourceJid ? extractDigitsFromJid(phoneSourceJid) : null;

  const cleanDisplayName = params.displayName?.trim() || '';
  const fallbackName = isGroup
    ? cleanDisplayName || `Grupo ${params.remoteJid.slice(0, 8)}`
    : cleanDisplayName || phonePretty || 'Contato WhatsApp';

  // 1. Tenta resolver contato no mapa em memória do lote primeiro (0 queries ao banco)
  let contact: Contact | null =
    batch?.contactByJid.get(params.remoteJid) ??
    (phoneSourceJid ? batch?.contactByJid.get(phoneSourceJid) ?? null : null);

  if (!contact) {
    let identity = await prisma.contactIdentity.findUnique({
      where: {
        connectionId_externalContactId: {
          connectionId: params.connectionId,
          externalContactId: params.remoteJid,
        },
      },
      include: { contact: true },
    });

    if (!identity && phoneSourceJid && phoneSourceJid !== params.remoteJid) {
      identity = await prisma.contactIdentity.findUnique({
        where: {
          connectionId_externalContactId: {
            connectionId: params.connectionId,
            externalContactId: phoneSourceJid,
          },
        },
        include: { contact: true },
      });
    }

    if (!identity) {
      let existingContact = phoneE164
        ? await prisma.contact.findFirst({
          where: { organizationId: params.organizationId, phoneE164 },
        })
        : null;

      if (!existingContact) {
        existingContact = await prisma.contact.create({
          data: {
            organizationId: params.organizationId,
            name: fallbackName,
            roleTitle: isGroup ? 'Grupo • WhatsApp' : 'WhatsApp',
            phoneE164: isGroup ? null : phoneE164,
          },
        });
      }

      identity = await prisma.contactIdentity.upsert({
        where: {
          connectionId_externalContactId: {
            connectionId: params.connectionId,
            externalContactId: params.remoteJid,
          },
        },
        update: {},
        create: {
          contactId: existingContact.id,
          connectionId: params.connectionId,
          externalContactId: params.remoteJid,
          metadata: {
            isGroup,
            isLid,
            ...(phoneSourceJid ? { phoneJid: phoneSourceJid } : {}),
          },
        },
        include: { contact: true },
      });
    }

    contact = identity.contact;
    if (batch) {
      batch.contactByJid.set(params.remoteJid, contact);
      if (phoneSourceJid) batch.contactByJid.set(phoneSourceJid, contact);
    }
  }

  // Enriquece nome real e corrige eventuais registros antigos de @lid que tinham telefone/nome falso "+1..."
  const contactUpdates: Prisma.ContactUpdateInput = {};

  if (
    cleanDisplayName &&
    (isPlaceholderContactName(contact.name, params.remoteJid) ||
      (phonePretty && contact.name === phonePretty))
  ) {
    contactUpdates.name = cleanDisplayName;
  } else if (!cleanDisplayName && isFakeLidDigitsPhone(contact.name, params.remoteJid)) {
    contactUpdates.name = phonePretty || 'Contato WhatsApp';
  }

  if (!isGroup) {
    if (phoneE164 && (!contact.phoneE164 || isFakeLidDigitsPhone(contact.phoneE164, params.remoteJid))) {
      contactUpdates.phoneE164 = phoneE164;
    } else if (!phoneE164 && isFakeLidDigitsPhone(contact.phoneE164, params.remoteJid)) {
      contactUpdates.phoneE164 = null;
    }
  }

  if (Object.keys(contactUpdates).length > 0) {
    contact = await prisma.contact.update({
      where: { id: contact.id },
      data: contactUpdates,
    });
    if (batch) {
      batch.contactByJid.set(params.remoteJid, contact);
      if (phoneSourceJid) batch.contactByJid.set(phoneSourceJid, contact);
    }
  }

  // 2. Localiza conversa no mapa em memória do lote ou no banco
  let conversation = batch?.conversationByContactId.get(contact.id) ?? null;

  if (!conversation) {
    conversation = await prisma.conversation.findFirst({
      where: {
        organizationId: params.organizationId,
        connectionId: params.connectionId,
        contactId: contact.id,
        status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING] },
      },
      orderBy: { lastMessageAt: 'desc' },
    });

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          organizationId: params.organizationId,
          connectionId: params.connectionId,
          contactId: contact.id,
          departmentId: params.defaultDepartmentId,
          status: ConversationStatus.OPEN,
          lastMessageAt: params.messageDate,
        },
      });
    }

    if (batch) {
      batch.conversationByContactId.set(contact.id, conversation);
    }
  }

  return { contact, conversation, phoneSourceJid };
}

export async function processWhatsAppMessage(params: {
  organizationId: string;
  connectionId: string;
  defaultDepartmentId: string | null;
  msg: WAMessage;
  sock?: WASocket | null;
  contactNameHint?: string | null;
  phoneJidHint?: string | null;
  downloadMedia: boolean;
  emitRealtime: boolean;
  batchCache?: SyncBatchCache;
}): Promise<void> {
  const { msg, organizationId, connectionId, batchCache } = params;
  const remoteJid = msg.key?.remoteJid;
  if (!isSupportedJid(remoteJid)) return;

  const extracted = extractMessageDetails(msg);
  if (!extracted) return;

  const isFromMe = Boolean(msg.key?.fromMe);
  const externalId = msg.key?.id ?? null;
  const messageDate = getMessageDate(msg);
  const isGroup = isGroupJid(remoteJid);

  // Em grupos, o nome da conversa deve ser o assunto do grupo (contactNameHint), nunca o pushName de um participante
  const displayName = isGroup
    ? params.contactNameHint
    : !isFromMe
      ? msg.pushName || params.contactNameHint
      : params.contactNameHint;

  const realPhoneJid = extractRealPhoneJidFromMessage(msg, params.phoneJidHint);

  const { contact, conversation, phoneSourceJid } = await resolveOrCreateContactAndConversation({
    organizationId,
    connectionId,
    defaultDepartmentId: params.defaultDepartmentId,
    remoteJid,
    realPhoneJid,
    displayName,
    messageDate,
    batchCache,
  });

  // Agenda busca de foto de perfil em segundo plano (somente JIDs @s.whatsapp.net ou @g.us)
  const avatarJid = isGroup ? remoteJid : phoneSourceJid;
  scheduleContactAvatarSync({
    sock: params.sock,
    organizationId,
    contactId: contact.id,
    conversationId: conversation.id,
    jid: avatarJid,
    existingAvatarUrl: contact.avatarUrl,
  });

  // Idempotência limpa: checa cache em memória do lote primeiro, depois banco
  if (externalId) {
    const knownSet = batchCache?.existingExternalIdsByConv.get(conversation.id);
    if (knownSet?.has(externalId)) {
      return;
    }

    if (!batchCache) {
      const existingMsg = await prisma.message.findUnique({
        where: {
          conversationId_externalId: {
            conversationId: conversation.id,
            externalId,
          },
        },
        select: { id: true },
      });
      if (existingMsg) {
        return;
      }
    }
  }

  // Resolve mensagem citada se já estiver no banco
  let quotedMessageId: string | null = null;
  if (extracted.quotedExternalId) {
    const quoted = await prisma.message.findUnique({
      where: {
        conversationId_externalId: {
          conversationId: conversation.id,
          externalId: extracted.quotedExternalId,
        },
      },
      select: { id: true },
    });
    quotedMessageId = quoted?.id ?? null;
  }

  const messageData = {
    conversationId: conversation.id,
    externalId,
    direction: isFromMe ? MessageDirection.OUTGOING : MessageDirection.INCOMING,
    visibility: MessageVisibility.PUBLIC,
    senderType: isFromMe ? MessageSenderType.AGENT : MessageSenderType.CONTACT,
    senderName: isFromMe ? 'Você (WhatsApp)' : msg.pushName || contact.name,
    content: extracted.content,
    contentType: extracted.contentType,
    quotedMessageId,
    deliveryStatus: isFromMe ? MessageDeliveryStatus.SENT : MessageDeliveryStatus.DELIVERED,
    createdAt: messageDate,
  };

  // Upsert garante ausência total de erro P2002 mesmo em condição de corrida com POST /messages
  const savedMessage = externalId
    ? await prisma.message.upsert({
      where: {
        conversationId_externalId: {
          conversationId: conversation.id,
          externalId,
        },
      },
      update: {},
      create: messageData,
    })
    : await prisma.message.create({ data: messageData });

  if (externalId && batchCache) {
    let set = batchCache.existingExternalIdsByConv.get(conversation.id);
    if (!set) {
      set = new Set<string>();
      batchCache.existingExternalIdsByConv.set(conversation.id, set);
    }
    set.add(externalId);
  }

  // Upload opcional de mídia para o Supabase Storage (apenas em mensagens em tempo real)
  let signedAttachmentUrl: string | null = null;
  let attachmentInfo: {
    id: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    url: string | null;
  } | null = null;

  if (params.downloadMedia && extracted.hasDownloadableMedia) {
    try {
      const mediaBuffer = (await downloadMediaMessage(
        msg,
        'buffer',
        {},
        { logger: silentLogger, reuploadRequest: async (m) => m }
      )) as Buffer;

      if (Buffer.isBuffer(mediaBuffer) && mediaBuffer.length > 0 && mediaBuffer.length <= 20 * 1024 * 1024) {
        const uploaded = await storageService.uploadAttachment({
          organizationId,
          conversationId: conversation.id,
          fileName: extracted.mediaFileName,
          mimeType: extracted.mediaMimeType,
          buffer: mediaBuffer,
        });

        try {
          signedAttachmentUrl = await storageService.getSignedUrl(uploaded.bucket, uploaded.storagePath, 3600);
        } catch {
          signedAttachmentUrl = null;
        }

        const att = await prisma.messageAttachment.create({
          data: {
            messageId: savedMessage.id,
            storageBucket: uploaded.bucket,
            storagePath: uploaded.storagePath,
            publicUrl: uploaded.publicUrl,
            fileName: extracted.mediaFileName,
            mimeType: extracted.mediaMimeType,
            sizeBytes: mediaBuffer.length,
          },
        });

        attachmentInfo = {
          id: att.id,
          fileName: att.fileName,
          mimeType: att.mimeType,
          sizeBytes: att.sizeBytes,
          url: signedAttachmentUrl,
        };
      }
    } catch (mediaErr) {
      console.warn('[WhatsApp Sync] Não foi possível salvar anexo no Supabase Storage:', mediaErr);
    }
  }

  // No modo lote (sync histórico), acumula lastMessageAt em memória e faz 1 update por conversa no final
  if (!params.emitRealtime && batchCache) {
    const prevDate = batchCache.pendingLastMessageAtByConv.get(conversation.id) ?? conversation.lastMessageAt;
    if (messageDate > prevDate) {
      batchCache.pendingLastMessageAtByConv.set(conversation.id, messageDate);
      conversation.lastMessageAt = messageDate;
    }
    return;
  }

  // Modo tempo real: atualiza conversa e retorna payload serializado em 1 único round-trip
  const updatedConvRecord = await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      lastMessageAt: messageDate > conversation.lastMessageAt ? messageDate : conversation.lastMessageAt,
      unreadCount: !isFromMe ? { increment: 1 } : undefined,
      status: !isFromMe && conversation.status === ConversationStatus.RESOLVED ? ConversationStatus.OPEN : undefined,
    },
    include: CONVERSATION_CLIENT_INCLUDE,
  });

  apiCache.invalidateConversationMessages(organizationId, conversation.id);
  apiCache.invalidateOrgConversations(organizationId);

  emitToOrganization(organizationId, 'message:created', {
    conversationId: conversation.id,
    message: {
      id: savedMessage.id,
      conversationId: conversation.id,
      externalId: savedMessage.externalId,
      type: isFromMe ? 'outgoing' : 'incoming',
      sender: savedMessage.senderName || contact.name,
      text: savedMessage.content,
      contentType: savedMessage.contentType,
      deliveryStatus: savedMessage.deliveryStatus,
      createdAt: savedMessage.createdAt.toISOString(),
      attachment: attachmentInfo,
    },
  });
  emitToOrganization(
    organizationId,
    'conversation:updated',
    formatConversationForClient(updatedConvRecord)
  );
}

const CONTACT_BATCH_CHUNK_SIZE = 100;

interface NormalizedWaContactEntry {
  externalJid: string;
  phoneE164: string | null;
  name: string;
  isStrongName: boolean;
  isGroup: boolean;
  lidJid: string | null;
}

/**
 * Importa/atualiza toda a agenda de contatos do WhatsApp em lotes de 100 registros
 * (createMany com skipDuplicates + enriquecimento de nomes), ignorando status@broadcast
 * e JIDs @lid sem telefone real associado para não sobrecarregar o pooler do Supabase.
 */
export async function syncWhatsAppContactsBatch(params: {
  organizationId: string;
  connectionId: string;
  contacts: Array<Partial<WaContact>>;
  chats?: Chat[];
  lidPnMappings?: LIDMapping[];
  lidToPn?: Map<string, string>;
  emitEvent?: boolean;
}): Promise<{ importedCount: number; updatedCount: number; totalProcessed: number }> {
  const { organizationId, connectionId } = params;
  const lidMap = new Map<string, string>(params.lidToPn ?? []);

  for (const m of params.lidPnMappings ?? []) {
    if (m.lid && m.pn) {
      const normalized = normalizePhoneJidCandidate(m.pn);
      if (normalized) lidMap.set(m.lid, normalized);
    }
  }

  for (const ch of params.chats ?? []) {
    const rawChat = ch as unknown as Record<string, unknown>;
    const pnCandidate = normalizePhoneJidCandidate(rawChat.pnJid || (!isLidJid(ch.id) ? ch.id : null));
    const lidCandidate =
      typeof rawChat.lidJid === 'string' ? rawChat.lidJid : isLidJid(ch.id) ? ch.id : null;
    if (lidCandidate && pnCandidate) {
      lidMap.set(lidCandidate, pnCandidate);
    }
  }

  // Normaliza e deduplica contatos em memória antes de acessar o banco
  const byExternalJid = new Map<string, NormalizedWaContactEntry>();

  for (const c of params.contacts) {
    const rawId = typeof c.id === 'string' ? c.id.trim() : '';
    if (!rawId || rawId === 'status@broadcast') continue;
    if (rawId.endsWith('@broadcast') || rawId.endsWith('@newsletter')) continue;

    const isGroup = isGroupJid(rawId);
    const savedName = typeof c.name === 'string' ? c.name.trim() : '';
    const pushNotify = typeof c.notify === 'string' ? c.notify.trim() : '';
    const bestLabel = savedName || pushNotify;

    if (isGroup) {
      if (!bestLabel) continue;
      byExternalJid.set(rawId, {
        externalJid: rawId,
        phoneE164: null,
        name: bestLabel,
        isStrongName: Boolean(savedName),
        isGroup: true,
        lidJid: null,
      });
      continue;
    }

    const lidJid = typeof c.lid === 'string' && isLidJid(c.lid) ? c.lid : isLidJid(rawId) ? rawId : null;
    const phoneJid =
      normalizePhoneJidCandidate(c.phoneNumber) ||
      normalizePhoneJidCandidate(!isLidJid(rawId) ? rawId : null) ||
      (lidJid ? normalizePhoneJidCandidate(lidMap.get(lidJid)) : null);

    // Ignora @lid sem telefone real associado
    if (!phoneJid) continue;

    const phoneE164 = extractDigitsFromJid(phoneJid);
    if (!phoneE164) continue;

    const prettyPhone = formatPhoneFromJid(phoneJid) || phoneE164;
    const resolvedName = bestLabel && !isSuspiciousLidPhone(bestLabel) ? bestLabel : prettyPhone;

    const existingEntry = byExternalJid.get(phoneJid);
    if (!existingEntry || (savedName && !existingEntry.isStrongName)) {
      byExternalJid.set(phoneJid, {
        externalJid: phoneJid,
        phoneE164,
        name: resolvedName,
        isStrongName: Boolean(savedName),
        isGroup: false,
        lidJid,
      });
    }
  }

  // Inclui também grupos/chats com nome presentes no histórico
  for (const ch of params.chats ?? []) {
    const rawId = typeof ch.id === 'string' ? ch.id.trim() : '';
    if (!rawId || rawId === 'status@broadcast' || rawId.endsWith('@broadcast') || rawId.endsWith('@newsletter')) {
      continue;
    }
    const chatName = typeof ch.name === 'string' ? ch.name.trim() : '';
    if (isGroupJid(rawId)) {
      if (chatName && !byExternalJid.has(rawId)) {
        byExternalJid.set(rawId, {
          externalJid: rawId,
          phoneE164: null,
          name: chatName,
          isStrongName: true,
          isGroup: true,
          lidJid: null,
        });
      }
      continue;
    }
    const rawChat = ch as unknown as Record<string, unknown>;
    const phoneJid =
      normalizePhoneJidCandidate(rawChat.pnJid) ||
      normalizePhoneJidCandidate(!isLidJid(rawId) ? rawId : null) ||
      (isLidJid(rawId) ? normalizePhoneJidCandidate(lidMap.get(rawId)) : null);
    if (!phoneJid || byExternalJid.has(phoneJid)) continue;
    const phoneE164 = extractDigitsFromJid(phoneJid);
    if (!phoneE164) continue;
    const prettyPhone = formatPhoneFromJid(phoneJid) || phoneE164;
    byExternalJid.set(phoneJid, {
      externalJid: phoneJid,
      phoneE164,
      name: chatName && !isSuspiciousLidPhone(chatName) ? chatName : prettyPhone,
      isStrongName: Boolean(chatName),
      isGroup: false,
      lidJid: isLidJid(rawId) ? rawId : null,
    });
  }

  const normalizedList = Array.from(byExternalJid.values());
  if (normalizedList.length === 0) {
    return { importedCount: 0, updatedCount: 0, totalProcessed: 0 };
  }

  let importedCount = 0;
  let updatedCount = 0;

  for (let i = 0; i < normalizedList.length; i += CONTACT_BATCH_CHUNK_SIZE) {
    const chunk = normalizedList.slice(i, i + CONTACT_BATCH_CHUNK_SIZE);
    const chunkJids = chunk.map((x) => x.externalJid);
    const chunkPhones = chunk
      .map((x) => x.phoneE164)
      .filter((p): p is string => Boolean(p));

    const [existingIdentities, existingContactsByPhone] = await Promise.all([
      prisma.contactIdentity.findMany({
        where: {
          connectionId,
          externalContactId: { in: chunkJids },
        },
        include: {
          contact: { select: { id: true, name: true, phoneE164: true } },
        },
      }),
      chunkPhones.length > 0
        ? prisma.contact.findMany({
            where: {
              organizationId,
              phoneE164: { in: chunkPhones },
            },
            select: { id: true, name: true, phoneE164: true },
          })
        : Promise.resolve([]),
    ]);

    const identityByExtId = new Map(
      existingIdentities.map((idRec) => [idRec.externalContactId, idRec])
    );
    const contactByPhone = new Map<string, { id: string; name: string; phoneE164: string | null }>();
    for (const c of existingContactsByPhone) {
      if (c.phoneE164) contactByPhone.set(c.phoneE164, c);
    }

    const contactsToCreate: Prisma.ContactCreateManyInput[] = [];
    const identitiesToCreate: Prisma.ContactIdentityCreateManyInput[] = [];
    const nameUpdates: Array<{ id: string; name: string; phoneE164?: string | null }> = [];

    for (const item of chunk) {
      const existingId = identityByExtId.get(item.externalJid);
      if (existingId) {
        const curName = existingId.contact.name;
        const shouldUpdateName =
          item.name &&
          item.name !== curName &&
          (isPlaceholderContactName(curName, item.externalJid) ||
            (item.isStrongName && !isSuspiciousLidPhone(item.name)));
        const shouldFixPhone =
          !item.isGroup &&
          item.phoneE164 &&
          (!existingId.contact.phoneE164 || isSuspiciousLidPhone(existingId.contact.phoneE164));

        if (shouldUpdateName || shouldFixPhone) {
          nameUpdates.push({
            id: existingId.contact.id,
            name: shouldUpdateName ? item.name : curName,
            ...(shouldFixPhone ? { phoneE164: item.phoneE164 } : {}),
          });
        }
        continue;
      }

      // Verifica se o contato já existe na organização pelo mesmo telefone E.164
      const existingPhoneContact = item.phoneE164 ? contactByPhone.get(item.phoneE164) : undefined;
      let contactId: string;

      if (existingPhoneContact) {
        contactId = existingPhoneContact.id;
        const curName = existingPhoneContact.name;
        if (
          item.name &&
          item.name !== curName &&
          (isPlaceholderContactName(curName, item.externalJid) || item.isStrongName)
        ) {
          nameUpdates.push({ id: contactId, name: item.name });
        }
      } else {
        contactId = crypto.randomUUID();
        contactsToCreate.push({
          id: contactId,
          organizationId,
          name: item.name,
          roleTitle: item.isGroup ? 'Grupo • WhatsApp' : 'WhatsApp',
          phoneE164: item.isGroup ? null : item.phoneE164,
        });
        if (item.phoneE164) {
          contactByPhone.set(item.phoneE164, {
            id: contactId,
            name: item.name,
            phoneE164: item.phoneE164,
          });
        }
      }

      identitiesToCreate.push({
        contactId,
        connectionId,
        externalContactId: item.externalJid,
        metadata: {
          isGroup: item.isGroup,
          isLid: false,
          ...(item.lidJid ? { lidJid: item.lidJid } : {}),
          source: 'whatsapp_address_book',
        },
      });
    }

    if (contactsToCreate.length > 0) {
      const created = await prisma.contact.createMany({
        data: contactsToCreate,
        skipDuplicates: true,
      });
      importedCount += created.count;
    }

    if (identitiesToCreate.length > 0) {
      await prisma.contactIdentity.createMany({
        data: identitiesToCreate,
        skipDuplicates: true,
      });
    }

    // Atualiza nomes enriquecidos em sub-lotes paralelos de 10 para não sobrecarregar o pooler
    if (nameUpdates.length > 0) {
      for (let u = 0; u < nameUpdates.length; u += 10) {
        const slice = nameUpdates.slice(u, u + 10);
        await Promise.all(
          slice.map((upd) =>
            prisma.contact
              .update({
                where: { id: upd.id },
                data: {
                  name: upd.name,
                  ...(upd.phoneE164 !== undefined ? { phoneE164: upd.phoneE164 } : {}),
                },
              })
              .catch(() => {})
          )
        );
      }
      updatedCount += nameUpdates.length;
    }
  }

  apiCache.invalidateOrgContacts(organizationId);
  if (updatedCount > 0) {
    apiCache.invalidateOrgConversations(organizationId);
  }

  if (params.emitEvent !== false && (importedCount > 0 || updatedCount > 0)) {
    const totalContacts = await prisma.contact.count({ where: { organizationId } });
    emitToOrganization(organizationId, 'whatsapp:contacts_synced', {
      connectionId,
      importedCount,
      updatedCount,
      totalContacts,
    });
  }

  return {
    importedCount,
    updatedCount,
    totalProcessed: normalizedList.length,
  };
}

/**
 * Sincronização inicial de conversas e mensagens recentes ao conectar o QR Code.
 * Usa pré-carregamento em lote (maps em memória) para evitar centenas de consultas repetidas.
 */
export async function syncWhatsAppHistory(params: {
  organizationId: string;
  connectionId: string;
  defaultDepartmentId: string | null;
  sock?: WASocket | null;
  chats: Chat[];
  contacts: WaContact[];
  messages: WAMessage[];
  lidPnMappings?: LIDMapping[];
  knownNames?: Map<string, string>;
  knownLidToPn?: Map<string, string>;
}): Promise<void> {
  const nameByJid = new Map<string, string>(params.knownNames ?? []);
  const lidToPn = new Map<string, string>(params.knownLidToPn ?? []);

  for (const mapping of params.lidPnMappings ?? []) {
    if (mapping.lid && mapping.pn) {
      const normalizedPn = normalizePhoneJidCandidate(mapping.pn);
      if (normalizedPn) lidToPn.set(mapping.lid, normalizedPn);
    }
  }

  for (const c of params.contacts) {
    const label = c.name || c.notify || '';
    const pnCandidate = normalizePhoneJidCandidate(c.phoneNumber || (!isLidJid(c.id) ? c.id : null));
    if (c.lid && pnCandidate) {
      lidToPn.set(c.lid, pnCandidate);
    }
    if (isLidJid(c.id) && pnCandidate) {
      lidToPn.set(c.id, pnCandidate);
    }
    if (label) {
      if (c.id) nameByJid.set(c.id, label);
      if (c.lid) nameByJid.set(c.lid, label);
      if (pnCandidate) nameByJid.set(pnCandidate, label);
    }
  }

  for (const ch of params.chats) {
    const rawChat = ch as unknown as Record<string, unknown>;
    const chatLabel =
      (typeof ch.name === 'string' && ch.name.trim()) ||
      (typeof rawChat.displayName === 'string' && rawChat.displayName.trim()) ||
      '';
    const pnCandidate = normalizePhoneJidCandidate(rawChat.pnJid || (!isLidJid(ch.id) ? ch.id : null));
    const lidCandidate = typeof rawChat.lidJid === 'string' ? rawChat.lidJid : isLidJid(ch.id) ? ch.id : null;

    if (lidCandidate && pnCandidate) {
      lidToPn.set(lidCandidate, pnCandidate);
    }
    if (chatLabel) {
      if (ch.id) nameByJid.set(ch.id, chatLabel);
      if (lidCandidate) nameByJid.set(lidCandidate, chatLabel);
      if (pnCandidate) nameByJid.set(pnCandidate, chatLabel);
    }
  }

  // Importa toda a agenda de contatos do pacote messaging-history.set em lotes de 100
  if ((params.contacts?.length ?? 0) > 0 || (params.chats?.length ?? 0) > 0) {
    try {
      await syncWhatsAppContactsBatch({
        organizationId: params.organizationId,
        connectionId: params.connectionId,
        contacts: params.contacts ?? [],
        chats: params.chats ?? [],
        lidPnMappings: params.lidPnMappings,
        lidToPn,
        emitEvent: true,
      });
    } catch (err) {
      console.warn('[WhatsApp History] Falha ao importar lote de contatos da agenda:', err);
    }
  }

  // Limita para as 200 mensagens mais recentes para sincronização rápida e limpa
  const recentMessages = [...params.messages]
    .filter((m) => isSupportedJid(m.key?.remoteJid))
    .sort((a, b) => getMessageDate(a).getTime() - getMessageDate(b).getTime())
    .slice(-200);

  // Pré-carrega em lote ContactIdentities, Conversations e externalIds já existentes (3 queries em vez de ~600)
  const batchCache: SyncBatchCache = {
    contactByJid: new Map<string, Contact>(),
    conversationByContactId: new Map<string, Conversation>(),
    existingExternalIdsByConv: new Map<string, Set<string>>(),
    pendingLastMessageAtByConv: new Map<string, Date>(),
  };

  const uniqueJids = new Set<string>();
  const batchExternalIds: string[] = [];
  for (const msg of recentMessages) {
    const jid = msg.key?.remoteJid;
    if (jid) {
      uniqueJids.add(jid);
      const pn = lidToPn.get(jid);
      if (pn) uniqueJids.add(pn);
    }
    if (msg.key?.id) batchExternalIds.push(msg.key.id);
  }

  if (uniqueJids.size > 0) {
    const identities = await prisma.contactIdentity.findMany({
      where: {
        connectionId: params.connectionId,
        externalContactId: { in: Array.from(uniqueJids) },
      },
      include: { contact: true },
    });

    const contactIds: string[] = [];
    for (const idRec of identities) {
      batchCache.contactByJid.set(idRec.externalContactId, idRec.contact);
      contactIds.push(idRec.contact.id);
    }

    if (contactIds.length > 0) {
      const openConvs = await prisma.conversation.findMany({
        where: {
          organizationId: params.organizationId,
          connectionId: params.connectionId,
          contactId: { in: contactIds },
          status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING] },
        },
        orderBy: { lastMessageAt: 'desc' },
      });

      const convIds: string[] = [];
      for (const c of openConvs) {
        if (!batchCache.conversationByContactId.has(c.contactId)) {
          batchCache.conversationByContactId.set(c.contactId, c);
          convIds.push(c.id);
        }
      }

      if (convIds.length > 0 && batchExternalIds.length > 0) {
        const existingMsgs = await prisma.message.findMany({
          where: {
            conversationId: { in: convIds },
            externalId: { in: batchExternalIds },
          },
          select: { conversationId: true, externalId: true },
        });

        for (const em of existingMsgs) {
          if (!em.externalId) continue;
          let set = batchCache.existingExternalIdsByConv.get(em.conversationId);
          if (!set) {
            set = new Set<string>();
            batchCache.existingExternalIdsByConv.set(em.conversationId, set);
          }
          set.add(em.externalId);
        }
      }
    }
  }

  for (const msg of recentMessages) {
    const jid = msg.key?.remoteJid;
    const mappedPn = jid ? lidToPn.get(jid) ?? null : null;
    const nameHint =
      (jid ? nameByJid.get(jid) : null) ??
      (mappedPn ? nameByJid.get(mappedPn) : null) ??
      null;

    try {
      await processWhatsAppMessage({
        organizationId: params.organizationId,
        connectionId: params.connectionId,
        defaultDepartmentId: params.defaultDepartmentId,
        msg,
        sock: params.sock,
        contactNameHint: nameHint,
        phoneJidHint: mappedPn,
        downloadMedia: false,
        emitRealtime: false,
        batchCache,
      });
    } catch (err) {
      console.warn('[WhatsApp History] Falha ao importar mensagem do histórico:', err);
    }
  }

  // Persiste os lastMessageAt acumulados em paralelo (1 update por conversa alterada)
  if (batchCache.pendingLastMessageAtByConv.size > 0) {
    await Promise.all(
      Array.from(batchCache.pendingLastMessageAtByConv.entries()).map(([convId, lastDate]) =>
        prisma.conversation
          .update({
            where: { id: convId },
            data: { lastMessageAt: lastDate },
          })
          .catch(() => { })
      )
    );
  }

  apiCache.invalidateOrgAll(params.organizationId);

  emitToOrganization(params.organizationId, 'whatsapp:history_synced', {
    connectionId: params.connectionId,
    syncedMessages: recentMessages.length,
  });

  // Garante enfileiramento de todos os contatos/grupos sem avatar após o sync do histórico
  void enqueueMissingAvatarsForOrganization({
    organizationId: params.organizationId,
    connectionId: params.connectionId,
    sock: params.sock,
    lidToPn,
    knownNames: nameByJid,
    force: true,
  });
}

export async function handleWhatsAppStatusUpdates(
  organizationId: string,
  connectionId: string,
  updates: WAMessageUpdate[]
): Promise<void> {
  for (const upd of updates) {
    const externalId = upd.key?.id;
    const rawStatus = upd.update?.status;
    if (!externalId || typeof rawStatus !== 'number') continue;

    // Baileys status: 2 = SERVER_ACK (SENT), 3 = DELIVERY_ACK (DELIVERED), 4 = READ
    let deliveryStatus: MessageDeliveryStatus | null = null;
    if (rawStatus === 2) deliveryStatus = MessageDeliveryStatus.SENT;
    else if (rawStatus === 3) deliveryStatus = MessageDeliveryStatus.DELIVERED;
    else if (rawStatus >= 4) deliveryStatus = MessageDeliveryStatus.READ;

    if (!deliveryStatus) continue;

    const existing = await prisma.message.findFirst({
      where: {
        externalId,
        conversation: { organizationId, connectionId },
      },
      select: { id: true, conversationId: true },
    });

    if (!existing) continue;

    await prisma.message.update({
      where: { id: existing.id },
      data: { deliveryStatus },
    });

    apiCache.invalidateConversationMessages(organizationId, existing.conversationId);

    emitToOrganization(organizationId, 'message:status', {
      conversationId: existing.conversationId,
      messageId: existing.id,
      deliveryStatus,
    });
  }
}
