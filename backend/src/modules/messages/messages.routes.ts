import type { FastifyInstance } from 'fastify';
import {
  ChannelType,
  ConnectionProvider,
  MessageContentType,
  MessageDeliveryStatus,
  MessageDirection,
  MessageSenderType,
  MessageVisibility,
} from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../../shared/database/prisma.js';
import { apiCache } from '../../shared/cache/api-cache.js';
import { authenticate, getTenantContext } from '../../shared/http/authenticate.js';
import { AppError } from '../../shared/http/errors.js';
import { storageService } from '../../shared/storage/supabase-storage.js';
import { emitToOrganization } from '../../realtime/socket.js';
import { whatsappManager } from '../whatsapp/whatsapp.manager.js';
import {
  CONVERSATION_CLIENT_INCLUDE,
  formatConversationForClient,
} from '../whatsapp/whatsapp.sync.js';

const sendTextMessageSchema = z.object({
  content: z.string().trim().min(1, 'Digite uma mensagem para enviar.').max(4096),
  visibility: z.enum(['PUBLIC', 'PRIVATE_NOTE']).default('PUBLIC'),
});

// Cache em memória de Signed URLs (30 min) para evitar round-trips repetidos ao Supabase Storage
const SIGNED_URL_CACHE_TTL_MS = 30 * 60 * 1000;
const signedUrlCache = new Map<string, { url: string; expiresAt: number }>();

async function getCachedSignedUrl(bucket: string, storagePath: string): Promise<string | null> {
  const key = `${bucket}:${storagePath}`;
  const now = Date.now();
  const cached = signedUrlCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.url;
  }
  try {
    const url = await storageService.getSignedUrl(bucket, storagePath, 3600);
    if (signedUrlCache.size > 1000) signedUrlCache.clear();
    signedUrlCache.set(key, { url, expiresAt: now + SIGNED_URL_CACHE_TTL_MS });
    return url;
  } catch {
    return null;
  }
}

export async function messagesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/v1/messages/conversation/:conversationId (cache em memória + consulta única consolidada)
  app.get('/conversation/:conversationId', async (request, reply) => {
    const tenant = getTenantContext(request);
    const { conversationId } = request.params as { conversationId: string };

    const cached = apiCache.getMessages(tenant.organizationId, conversationId);
    if (cached) {
      return reply.send({ messages: cached });
    }

    const conv = await prisma.conversation.findFirst({
      where: { id: conversationId, organizationId: tenant.organizationId },
      select: {
        id: true,
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 200,
          select: {
            id: true,
            conversationId: true,
            externalId: true,
            visibility: true,
            direction: true,
            senderName: true,
            content: true,
            contentType: true,
            deliveryStatus: true,
            createdAt: true,
            attachments: {
              take: 1,
              select: {
                id: true,
                storageBucket: true,
                storagePath: true,
                publicUrl: true,
                fileName: true,
                mimeType: true,
                sizeBytes: true,
              },
            },
            quotedMessage: {
              select: { id: true, senderName: true, content: true },
            },
          },
        },
      },
    });

    if (!conv) {
      throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'Conversa não encontrada.');
    }

    // Reverte para ordem cronológica ascendente após buscar as 200 mais recentes
    const rows = conv.messages.reverse();

    const messages = await Promise.all(
      rows.map(async (m) => {
        let attachment: {
          id: string;
          fileName: string;
          mimeType: string;
          sizeBytes: number;
          url: string | null;
        } | null = null;

        const firstAtt = m.attachments[0];
        if (firstAtt) {
          const url =
            firstAtt.publicUrl || (await getCachedSignedUrl(firstAtt.storageBucket, firstAtt.storagePath));
          attachment = {
            id: firstAtt.id,
            fileName: firstAtt.fileName,
            mimeType: firstAtt.mimeType,
            sizeBytes: firstAtt.sizeBytes,
            url,
          };
        }

        return {
          id: m.id,
          conversationId: m.conversationId,
          externalId: m.externalId,
          type:
            m.visibility === MessageVisibility.PRIVATE_NOTE
              ? 'private'
              : m.direction === MessageDirection.OUTGOING
                ? 'outgoing'
                : 'incoming',
          sender: m.senderName || (m.direction === MessageDirection.OUTGOING ? 'Atendente' : 'Contato'),
          text: m.content,
          contentType: m.contentType,
          deliveryStatus: m.deliveryStatus,
          quote: m.quotedMessage
            ? {
              author: m.quotedMessage.senderName || 'Mensagem',
              text: m.quotedMessage.content,
            }
            : null,
          attachment,
          createdAt: m.createdAt.toISOString(),
        };
      })
    );

    apiCache.setMessages(tenant.organizationId, conversationId, messages);

    return reply.send({ messages });
  });

  // POST /api/v1/messages/conversation/:conversationId — envia texto ou anexo (multipart) e despacha pelo WhatsApp real
  app.post('/conversation/:conversationId', async (request, reply) => {
    const tenant = getTenantContext(request);
    const { conversationId } = request.params as { conversationId: string };

    // Consulta única trazendo conexão, contato e identidades (evita 2 round-trips extras)
    const conv = await prisma.conversation.findFirst({
      where: { id: conversationId, organizationId: tenant.organizationId },
      select: {
        id: true,
        connectionId: true,
        contactId: true,
        assigneeId: true,
        firstResponseAt: true,
        createdAt: true,
        connection: {
          select: { id: true, channel: true, provider: true },
        },
        contact: {
          select: {
            id: true,
            phoneE164: true,
            identities: {
              select: { connectionId: true, externalContactId: true },
            },
          },
        },
      },
    });
    if (!conv) {
      throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'Conversa não encontrada.');
    }

    const senderDisplayName = tenant.name ?? 'Atendente';

    let content = '';
    let visibility: MessageVisibility = MessageVisibility.PUBLIC;
    let filePayload: { buffer: Buffer; fileName: string; mimeType: string } | null = null;

    if (request.isMultipart()) {
      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === 'file') {
          const buffer = await part.toBuffer();
          filePayload = {
            buffer,
            fileName: part.filename || `arquivo-${Date.now()}`,
            mimeType: part.mimetype || 'application/octet-stream',
          };
        } else if (part.fieldname === 'content' && typeof part.value === 'string') {
          content = part.value.trim();
        } else if (part.fieldname === 'visibility' && part.value === 'PRIVATE_NOTE') {
          visibility = MessageVisibility.PRIVATE_NOTE;
        }
      }
      if (!content && filePayload) {
        content = filePayload.fileName;
      }
      if (!content) {
        throw new AppError(400, 'EMPTY_MESSAGE', 'Envie um texto ou arquivo.');
      }
    } else {
      const parsed = sendTextMessageSchema.parse(request.body);
      content = parsed.content;
      visibility = parsed.visibility as MessageVisibility;
    }

    // Resolve o JID do WhatsApp para envio real quando a mensagem é pública (sem query extra)
    let externalId: string | null = null;
    const deliveryStatus: MessageDeliveryStatus = MessageDeliveryStatus.SENT;

    if (
      visibility === MessageVisibility.PUBLIC &&
      conv.connection.channel === ChannelType.WHATSAPP &&
      conv.connection.provider === ConnectionProvider.BAILEYS
    ) {
      const identity = conv.contact.identities.find((i) => i.connectionId === conv.connectionId);
      const digits = (conv.contact.phoneE164 || '').replace(/\D/g, '');
      const targetJid = identity?.externalContactId || (digits ? `${digits}@s.whatsapp.net` : null);

      if (!targetJid) {
        throw new AppError(
          400,
          'MISSING_WHATSAPP_JID',
          'Este contato não possui número/JID de WhatsApp vinculado.'
        );
      }

      try {
        if (filePayload) {
          externalId = await whatsappManager.sendMediaMessage(conv.connectionId, targetJid, {
            buffer: filePayload.buffer,
            mimeType: filePayload.mimeType,
            fileName: filePayload.fileName,
            caption: content !== filePayload.fileName ? content : undefined,
          });
        } else {
          externalId = await whatsappManager.sendTextMessage(conv.connectionId, targetJid, content);
        }
      } catch (waErr) {
        throw new AppError(
          502,
          'WHATSAPP_SEND_FAILED',
          waErr instanceof Error ? waErr.message : 'Falha ao enviar mensagem pelo WhatsApp.'
        );
      }
    }

    const contentType: MessageContentType = filePayload
      ? filePayload.mimeType.startsWith('image/')
        ? MessageContentType.IMAGE
        : filePayload.mimeType.startsWith('audio/')
          ? MessageContentType.AUDIO
          : filePayload.mimeType.startsWith('video/')
            ? MessageContentType.VIDEO
            : MessageContentType.DOCUMENT
      : MessageContentType.TEXT;

    const now = new Date();
    const createData = {
      conversationId: conv.id,
      externalId,
      direction: MessageDirection.OUTGOING,
      visibility,
      senderType: MessageSenderType.AGENT,
      senderUserId: tenant.userId,
      senderName: senderDisplayName,
      content,
      contentType,
      deliveryStatus,
      createdAt: now,
    };

    // Upsert evita P2002 caso o eco do Baileys (fromMe: true) chegue antes do INSERT
    const saved = externalId
      ? await prisma.message.upsert({
        where: {
          conversationId_externalId: {
            conversationId: conv.id,
            externalId,
          },
        },
        update: {
          senderUserId: tenant.userId,
          senderName: senderDisplayName,
        },
        create: createData,
      })
      : await prisma.message.create({ data: createData });

    // Salva anexo no Supabase Storage se houver arquivo
    let attachmentResponse: {
      id: string;
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      url: string | null;
    } | null = null;

    if (filePayload) {
      try {
        const uploaded = await storageService.uploadAttachment({
          organizationId: tenant.organizationId,
          conversationId: conv.id,
          fileName: filePayload.fileName,
          mimeType: filePayload.mimeType,
          buffer: filePayload.buffer,
        });

        const [signedUrl, att] = await Promise.all([
          getCachedSignedUrl(uploaded.bucket, uploaded.storagePath),
          prisma.messageAttachment.create({
            data: {
              messageId: saved.id,
              storageBucket: uploaded.bucket,
              storagePath: uploaded.storagePath,
              publicUrl: uploaded.publicUrl,
              fileName: filePayload.fileName,
              mimeType: filePayload.mimeType,
              sizeBytes: filePayload.buffer.length,
            },
          }),
        ]);

        attachmentResponse = {
          id: att.id,
          fileName: att.fileName,
          mimeType: att.mimeType,
          sizeBytes: att.sizeBytes,
          url: signedUrl,
        };
      } catch (storageErr) {
        console.warn('[Messages] Falha ao salvar anexo no Supabase Storage:', storageErr);
      }
    }

    // Atualiza conversa e retorna payload serializado em um único round-trip
    const updatedConvRecord = await prisma.conversation.update({
      where: { id: conv.id },
      data: {
        lastMessageAt: now,
        assigneeId:
          visibility === MessageVisibility.PUBLIC && conv.assigneeId === null
            ? tenant.userId
            : undefined,
        firstResponseAt:
          visibility === MessageVisibility.PUBLIC && !conv.firstResponseAt ? now : undefined,
        firstResponseSeconds:
          visibility === MessageVisibility.PUBLIC && !conv.firstResponseAt
            ? Math.max(1, Math.round((now.getTime() - conv.createdAt.getTime()) / 1000))
            : undefined,
      },
      include: CONVERSATION_CLIENT_INCLUDE,
    });

    const formattedMsg = {
      id: saved.id,
      conversationId: conv.id,
      externalId: saved.externalId,
      type: visibility === MessageVisibility.PRIVATE_NOTE ? 'private' : 'outgoing',
      sender: saved.senderName || 'Atendente',
      text: saved.content,
      contentType: saved.contentType,
      deliveryStatus: saved.deliveryStatus,
      attachment: attachmentResponse,
      createdAt: saved.createdAt.toISOString(),
    };

    const updatedConv = formatConversationForClient(updatedConvRecord);

    apiCache.invalidateConversationMessages(tenant.organizationId, conv.id);
    apiCache.invalidateOrgConversations(tenant.organizationId);

    emitToOrganization(tenant.organizationId, 'message:created', {
      conversationId: conv.id,
      message: formattedMsg,
    });
    emitToOrganization(tenant.organizationId, 'conversation:updated', updatedConv);

    return reply.status(201).send({ message: formattedMsg, conversation: updatedConv });
  });
}
