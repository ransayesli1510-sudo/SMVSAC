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
import { authenticate, getTenantContext } from '../../shared/http/authenticate.js';
import { AppError } from '../../shared/http/errors.js';
import { storageService } from '../../shared/storage/supabase-storage.js';
import { emitToOrganization } from '../../realtime/socket.js';
import { whatsappManager } from '../whatsapp/whatsapp.manager.js';
import { serializeConversationForClient } from '../whatsapp/whatsapp.sync.js';

const sendTextMessageSchema = z.object({
  content: z.string().trim().min(1, 'Digite uma mensagem para enviar.').max(4096),
  visibility: z.enum(['PUBLIC', 'PRIVATE_NOTE']).default('PUBLIC'),
});

export async function messagesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/v1/messages/conversation/:conversationId
  app.get('/conversation/:conversationId', async (request, reply) => {
    const tenant = getTenantContext(request);
    const { conversationId } = request.params as { conversationId: string };

    const conv = await prisma.conversation.findFirst({
      where: { id: conversationId, organizationId: tenant.organizationId },
      select: { id: true },
    });
    if (!conv) {
      throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'Conversa não encontrada.');
    }

    const rows = await prisma.message.findMany({
      where: { conversationId: conv.id },
      orderBy: { createdAt: 'asc' },
      take: 200,
      include: {
        attachments: true,
        quotedMessage: {
          select: { id: true, senderName: true, content: true },
        },
      },
    });

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
          let url = firstAtt.publicUrl;
          if (!url) {
            try {
              url = await storageService.getSignedUrl(firstAtt.storageBucket, firstAtt.storagePath, 3600);
            } catch {
              url = null;
            }
          }
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

    return reply.send({ messages });
  });

  // POST /api/v1/messages/conversation/:conversationId — envia texto ou anexo (multipart) e despacha pelo WhatsApp real
  app.post('/conversation/:conversationId', async (request, reply) => {
    const tenant = getTenantContext(request);
    const { conversationId } = request.params as { conversationId: string };

    const conv = await prisma.conversation.findFirst({
      where: { id: conversationId, organizationId: tenant.organizationId },
      include: {
        connection: true,
        contact: {
          include: {
            identities: {
              where: { connectionId: undefined },
            },
          },
        },
      },
    });
    if (!conv) {
      throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'Conversa não encontrada.');
    }

    const senderUser = await prisma.user.findFirst({
      where: { id: tenant.userId, organizationId: tenant.organizationId },
      select: { id: true, name: true },
    });

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

    // Resolve o JID do WhatsApp para envio real quando a mensagem é pública
    let externalId: string | null = null;
    let deliveryStatus: MessageDeliveryStatus = MessageDeliveryStatus.SENT;

    if (
      visibility === MessageVisibility.PUBLIC &&
      conv.connection.channel === ChannelType.WHATSAPP &&
      conv.connection.provider === ConnectionProvider.BAILEYS
    ) {
      const identity = await prisma.contactIdentity.findFirst({
        where: { contactId: conv.contactId, connectionId: conv.connectionId },
        select: { externalContactId: true },
      });

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
    const saved = await prisma.message.create({
      data: {
        conversationId: conv.id,
        externalId,
        direction: MessageDirection.OUTGOING,
        visibility,
        senderType: MessageSenderType.AGENT,
        senderUserId: tenant.userId,
        senderName: senderUser?.name ?? 'Atendente',
        content,
        contentType,
        deliveryStatus,
        createdAt: now,
      },
    });

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

        let signedUrl: string | null = null;
        try {
          signedUrl = await storageService.getSignedUrl(uploaded.bucket, uploaded.storagePath, 3600);
        } catch {
          signedUrl = null;
        }

        const att = await prisma.messageAttachment.create({
          data: {
            messageId: saved.id,
            storageBucket: uploaded.bucket,
            storagePath: uploaded.storagePath,
            publicUrl: uploaded.publicUrl,
            fileName: filePayload.fileName,
            mimeType: filePayload.mimeType,
            sizeBytes: filePayload.buffer.length,
          },
        });

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

    await prisma.conversation.update({
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

    emitToOrganization(tenant.organizationId, 'message:created', {
      conversationId: conv.id,
      message: formattedMsg,
    });

    const updatedConv = await serializeConversationForClient(conv.id);
    if (updatedConv) {
      emitToOrganization(tenant.organizationId, 'conversation:updated', updatedConv);
    }

    return reply.status(201).send({ message: formattedMsg, conversation: updatedConv });
  });
}
