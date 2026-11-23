import {
  downloadMediaMessage,
  type Chat,
  type Contact as WaContact,
  type WAMessage,
  type WAMessageUpdate,
} from '@whiskeysockets/baileys';
import {
  ConversationStatus,
  MessageContentType,
  MessageDeliveryStatus,
  MessageDirection,
  MessageSenderType,
  MessageVisibility,
  Prisma,
} from '@prisma/client';
import pino from 'pino';

import { prisma } from '../../shared/database/prisma.js';
import { storageService } from '../../shared/storage/supabase-storage.js';
import {
  extractDigitsFromJid,
  formatPhoneFromJid,
  formatTicketNumber,
  getInitials,
} from '../../shared/formatters/ticket.js';
import { emitToOrganization } from '../../realtime/socket.js';

const silentLogger = pino({ level: 'silent' });

function isSupportedJid(jid: string | null | undefined): jid is string {
  if (!jid) return false;
  if (jid === 'status@broadcast') return false;
  if (jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return false;
  return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@g.us') || jid.endsWith('@lid');
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

async function resolveOrCreateContactAndConversation(params: {
  organizationId: string;
  connectionId: string;
  defaultDepartmentId: string | null;
  remoteJid: string;
  displayName?: string | null;
  messageDate: Date;
}) {
  const isGroup = params.remoteJid.endsWith('@g.us');
  const phonePretty = isGroup ? 'Grupo WhatsApp' : formatPhoneFromJid(params.remoteJid);
  const phoneE164 = extractDigitsFromJid(params.remoteJid);
  const fallbackName = isGroup
    ? params.displayName?.trim() || `Grupo ${params.remoteJid.slice(0, 8)}`
    : params.displayName?.trim() || phonePretty;

  // 1. Busca identidade existente para (connectionId, remoteJid)
  let identity = await prisma.contactIdentity.findUnique({
    where: {
      connectionId_externalContactId: {
        connectionId: params.connectionId,
        externalContactId: params.remoteJid,
      },
    },
    include: { contact: true },
  });

  if (!identity) {
    // Tenta reutilizar contato existente pelo mesmo telefone E.164 na organização
    let contact = phoneE164
      ? await prisma.contact.findFirst({
          where: { organizationId: params.organizationId, phoneE164 },
        })
      : null;

    if (!contact) {
      contact = await prisma.contact.create({
        data: {
          organizationId: params.organizationId,
          name: fallbackName,
          roleTitle: isGroup ? 'Grupo • WhatsApp' : 'WhatsApp',
          phoneE164: phoneE164 ?? (isGroup ? null : phonePretty),
        },
      });
    }

    try {
      identity = await prisma.contactIdentity.create({
        data: {
          contactId: contact.id,
          connectionId: params.connectionId,
          externalContactId: params.remoteJid,
          metadata: { isGroup },
        },
        include: { contact: true },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        identity = await prisma.contactIdentity.findUniqueOrThrow({
          where: {
            connectionId_externalContactId: {
              connectionId: params.connectionId,
              externalContactId: params.remoteJid,
            },
          },
          include: { contact: true },
        });
      } else {
        throw err;
      }
    }
  } else if (
    params.displayName &&
    params.displayName.trim() &&
    (identity.contact.name === phonePretty || identity.contact.name.startsWith('+'))
  ) {
    // Enriquece o nome do contato quando chega o pushName real do WhatsApp
    await prisma.contact.update({
      where: { id: identity.contact.id },
      data: { name: params.displayName.trim() },
    });
    identity.contact.name = params.displayName.trim();
  }

  // 2. Localiza conversa aberta existente ou cria uma nova para o contato/conexão
  let conversation = await prisma.conversation.findFirst({
    where: {
      organizationId: params.organizationId,
      connectionId: params.connectionId,
      contactId: identity.contact.id,
      status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING] },
    },
    orderBy: { lastMessageAt: 'desc' },
  });

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        organizationId: params.organizationId,
        connectionId: params.connectionId,
        contactId: identity.contact.id,
        departmentId: params.defaultDepartmentId,
        status: ConversationStatus.OPEN,
        lastMessageAt: params.messageDate,
      },
    });
  }

  return { contact: identity.contact, conversation };
}

export async function serializeConversationForClient(conversationId: string) {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      contact: true,
      connection: { select: { id: true, name: true, channel: true, identifier: true } },
      department: { select: { id: true, name: true } },
      assignee: { select: { id: true, name: true, role: true } },
      labels: { include: { label: { select: { id: true, name: true, color: true } } } },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: { attachments: true },
      },
    },
  });

  if (!conv) return null;

  const lastMsg = conv.messages[0] ?? null;

  return {
    id: conv.id,
    protocolNumber: conv.protocolNumber,
    ticketNumber: formatTicketNumber(conv.createdAt, conv.protocolNumber),
    status: conv.status.toLowerCase(), // open | pending | resolved
    assigneeId: conv.assigneeId,
    assigneeName: conv.assignee?.name ?? null,
    connectionId: conv.connectionId,
    connection: conv.connection.name,
    channel: conv.connection.channel === 'WHATSAPP' ? 'WhatsApp' : conv.connection.channel === 'WEBCHAT' ? 'WebChat' : 'Instagram',
    departmentId: conv.departmentId,
    department: conv.department?.name ?? 'Suporte',
    unread: conv.unreadCount,
    createdAt: conv.createdAt.toISOString(),
    lastMessageAt: conv.lastMessageAt.toISOString(),
    labels: conv.labels.map((l) => l.label.name),
    contact: {
      id: conv.contact.id,
      name: conv.contact.name,
      initials: getInitials(conv.contact.name),
      role: conv.contact.roleTitle ?? 'WhatsApp',
      phone: conv.contact.phoneE164 ?? 'WhatsApp',
      email: conv.contact.email ?? '-',
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

export async function processWhatsAppMessage(params: {
  organizationId: string;
  connectionId: string;
  defaultDepartmentId: string | null;
  msg: WAMessage;
  contactNameHint?: string | null;
  downloadMedia: boolean;
  emitRealtime: boolean;
}): Promise<void> {
  const { msg, organizationId, connectionId } = params;
  const remoteJid = msg.key?.remoteJid;
  if (!isSupportedJid(remoteJid)) return;

  const extracted = extractMessageDetails(msg);
  if (!extracted) return;

  const isFromMe = Boolean(msg.key?.fromMe);
  const externalId = msg.key?.id ?? null;
  const messageDate = getMessageDate(msg);
  const displayName = !isFromMe ? msg.pushName ?? params.contactNameHint : params.contactNameHint;

  const { contact, conversation } = await resolveOrCreateContactAndConversation({
    organizationId,
    connectionId,
    defaultDepartmentId: params.defaultDepartmentId,
    remoteJid,
    displayName,
    messageDate,
  });

  // Resolve mensagem citada se já estiver no banco
  let quotedMessageId: string | null = null;
  if (extracted.quotedExternalId) {
    const quoted = await prisma.message.findFirst({
      where: {
        conversationId: conversation.id,
        externalId: extracted.quotedExternalId,
      },
      select: { id: true },
    });
    quotedMessageId = quoted?.id ?? null;
  }

  let savedMessage;
  try {
    savedMessage = await prisma.message.create({
      data: {
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
      },
    });
  } catch (err) {
    // Idempotência: mensagem já sincronizada anteriormente
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return;
    }
    throw err;
  }

  // Upload opcional de mídia para o Supabase Storage (apenas em mensagens em tempo real para não sobrecarregar o sync inicial)
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

  // Atualiza lastMessageAt e unreadCount na conversa
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      lastMessageAt: messageDate > conversation.lastMessageAt ? messageDate : conversation.lastMessageAt,
      unreadCount: !isFromMe && params.emitRealtime ? { increment: 1 } : undefined,
      status: !isFromMe && conversation.status === ConversationStatus.RESOLVED ? ConversationStatus.OPEN : undefined,
    },
  });

  if (params.emitRealtime) {
    const serializedConv = await serializeConversationForClient(conversation.id);
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
    if (serializedConv) {
      emitToOrganization(organizationId, 'conversation:updated', serializedConv);
    }
  }
}

/**
 * Sincronização inicial de conversas e mensagens recentes ao conectar o QR Code.
 */
export async function syncWhatsAppHistory(params: {
  organizationId: string;
  connectionId: string;
  defaultDepartmentId: string | null;
  chats: Chat[];
  contacts: WaContact[];
  messages: WAMessage[];
}): Promise<void> {
  const nameByJid = new Map<string, string>();
  for (const c of params.contacts) {
    if (c.id && (c.name || c.notify)) {
      nameByJid.set(c.id, c.name || c.notify || '');
    }
  }
  for (const ch of params.chats) {
    if (ch.id && ch.name) {
      nameByJid.set(ch.id, ch.name);
    }
  }

  // Limita para as 200 mensagens mais recentes para sincronização rápida e limpa
  const recentMessages = [...params.messages]
    .filter((m) => isSupportedJid(m.key?.remoteJid))
    .sort((a, b) => getMessageDate(a).getTime() - getMessageDate(b).getTime())
    .slice(-200);

  for (const msg of recentMessages) {
    const jid = msg.key?.remoteJid;
    try {
      await processWhatsAppMessage({
        organizationId: params.organizationId,
        connectionId: params.connectionId,
        defaultDepartmentId: params.defaultDepartmentId,
        msg,
        contactNameHint: jid ? nameByJid.get(jid) ?? null : null,
        downloadMedia: false,
        emitRealtime: false,
      });
    } catch (err) {
      console.warn('[WhatsApp History] Falha ao importar mensagem do histórico:', err);
    }
  }

  emitToOrganization(params.organizationId, 'whatsapp:history_synced', {
    connectionId: params.connectionId,
    syncedMessages: recentMessages.length,
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

    emitToOrganization(organizationId, 'message:status', {
      conversationId: existing.conversationId,
      messageId: existing.id,
      deliveryStatus,
    });
  }
}
