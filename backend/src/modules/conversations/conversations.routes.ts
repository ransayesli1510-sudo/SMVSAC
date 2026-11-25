import type { FastifyInstance } from 'fastify';
import {
  ChannelType,
  ConnectionStatus,
  ConversationEventType,
  ConversationStatus,
  MessageDirection,
  MessageSenderType,
  MessageVisibility,
  UserApprovalStatus,
} from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../../shared/database/prisma.js';
import { apiCache } from '../../shared/cache/api-cache.js';
import { authenticate, getTenantContext } from '../../shared/http/authenticate.js';
import { AppError } from '../../shared/http/errors.js';
import { formatTicketNumber } from '../../shared/formatters/ticket.js';
import { emitToOrganization } from '../../realtime/socket.js';
import { whatsappManager } from '../whatsapp/whatsapp.manager.js';
import {
  CONVERSATION_CLIENT_INCLUDE,
  enqueueMissingAvatarsForOrganization,
  formatConversationForClient,
} from '../whatsapp/whatsapp.sync.js';

const listConversationsQuerySchema = z.object({
  tab: z.enum(['mine', 'queue', 'all']).default('all'),
  status: z.enum(['open', 'resolved', 'all']).default('open'),
  q: z.string().trim().optional(),
  sort: z
    .enum(['last_message_desc', 'oldest_first', 'newest_first', 'longest_wait', 'shortest_wait'])
    .default('last_message_desc'),
});

const assignConversationSchema = z.object({
  departmentId: z.string().uuid('Selecione um departamento válido.').optional(),
  departmentName: z.string().trim().min(1).optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  comment: z.string().trim().max(1000).optional(),
});

const updateStatusSchema = z.object({
  status: z.enum(['OPEN', 'RESOLVED']),
});

const createConversationSchema = z.object({
  contactId: z.string().uuid('Selecione um contato válido.'),
  connectionId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
});

export async function conversationsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/v1/conversations/meta — departamentos, agentes da organização e etiquetas
  app.get('/meta', async (request, reply) => {
    const tenant = getTenantContext(request);

    const [departments, agents, labels, cannedResponses] = await Promise.all([
      prisma.department.findMany({
        where: { organizationId: tenant.organizationId, isActive: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      }),
      prisma.user.findMany({
        where: {
          organizationId: tenant.organizationId,
          isActive: true,
          approvalStatus: UserApprovalStatus.APPROVED,
        },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, email: true, role: true, availability: true },
      }),
      prisma.label.findMany({
        where: { organizationId: tenant.organizationId },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, color: true },
      }),
      prisma.cannedResponse.findMany({
        where: { organizationId: tenant.organizationId },
        orderBy: { shortcode: 'asc' },
        select: { id: true, shortcode: true, title: true, content: true },
      }),
    ]);

    return reply.send({ departments, agents, labels, cannedResponses });
  });

  // GET /api/v1/conversations
  app.get('/', async (request, reply) => {
    const tenant = getTenantContext(request);
    const query = listConversationsQuerySchema.parse(request.query);

    // Enfileira em segundo plano (com throttle) os contatos/grupos ainda sem avatarUrl
    const activeSession = whatsappManager.getActiveSessionForOrganization(tenant.organizationId);
    if (activeSession) {
      void enqueueMissingAvatarsForOrganization({
        organizationId: tenant.organizationId,
        connectionId: activeSession.connectionId,
        sock: activeSession.socket,
        lidToPn: activeSession.lidToPn,
        knownNames: activeSession.knownNames,
      });
    }

    const cacheParams = {
      tab: query.tab,
      status: query.status,
      sort: query.sort,
      q: query.q,
      userId: tenant.userId,
    };

    const cached = apiCache.getConversations(tenant.organizationId, cacheParams);
    if (cached) {
      const withPresence = cached.map((conv) => {
        const row = conv as { id: string } & Record<string, unknown>;
        return {
          ...row,
          presence: whatsappManager.getConversationPresence(row.id),
        };
      });
      return reply.send({ conversations: withPresence });
    }

    const where: Record<string, unknown> = {
      organizationId: tenant.organizationId,
    };

    if (query.status === 'open') {
      where.status = { in: [ConversationStatus.OPEN, ConversationStatus.PENDING] };
    } else if (query.status === 'resolved') {
      where.status = ConversationStatus.RESOLVED;
    }

    if (query.tab === 'mine') {
      where.assigneeId = tenant.userId;
    } else if (query.tab === 'queue') {
      where.assigneeId = null;
    }

    if (query.q) {
      where.OR = [
        { contact: { name: { contains: query.q, mode: 'insensitive' } } },
        { contact: { phoneE164: { contains: query.q, mode: 'insensitive' } } },
        { connection: { name: { contains: query.q, mode: 'insensitive' } } },
      ];
    }

    const orderBy =
      query.sort === 'oldest_first'
        ? { createdAt: 'asc' as const }
        : query.sort === 'newest_first'
          ? { createdAt: 'desc' as const }
          : query.sort === 'longest_wait'
            ? { lastMessageAt: 'asc' as const }
            : { lastMessageAt: 'desc' as const };

    // Consulta única com include seletivo (elimina N+1 e alimenta o cache em memória)
    const rows = await prisma.conversation.findMany({
      where,
      orderBy,
      take: 100,
      include: CONVERSATION_CLIENT_INCLUDE,
    });

    const serialized = rows.map(formatConversationForClient);
    apiCache.setConversations(tenant.organizationId, cacheParams, serialized);

    const withPresence = serialized.map((conv) => ({
      ...conv,
      presence: whatsappManager.getConversationPresence(conv.id),
    }));

    return reply.send({ conversations: withPresence });
  });

  // POST /api/v1/conversations — abre conversa existente (OPEN/PENDING) ou cria novo chamado para o contato
  app.post('/', async (request, reply) => {
    const tenant = getTenantContext(request);
    const input = createConversationSchema.parse(request.body);

    const contact = await prisma.contact.findFirst({
      where: { id: input.contactId, organizationId: tenant.organizationId },
      select: {
        id: true,
        name: true,
        phoneE164: true,
        identities: {
          select: {
            connectionId: true,
            externalContactId: true,
            connection: {
              select: { id: true, status: true, channel: true, defaultDepartmentId: true },
            },
          },
        },
      },
    });

    if (!contact) {
      throw new AppError(404, 'CONTACT_NOT_FOUND', 'Contato não encontrado nesta organização.');
    }

    // 1. Se já existir conversa OPEN ou PENDING para este contato (e conexão, se informada), retorna imediatamente
    const existingConv = await prisma.conversation.findFirst({
      where: {
        organizationId: tenant.organizationId,
        contactId: contact.id,
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
        status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING] },
      },
      orderBy: { lastMessageAt: 'desc' },
      include: CONVERSATION_CLIENT_INCLUDE,
    });

    if (existingConv) {
      return reply.status(200).send({
        conversation: formatConversationForClient(existingConv),
        created: false,
      });
    }

    // 2. Resolve a conexão ideal (explícita -> identidade do contato -> WhatsApp ativa -> qualquer ativa)
    let connection: { id: string; defaultDepartmentId: string | null } | null = null;

    if (input.connectionId) {
      connection = await prisma.connection.findFirst({
        where: { id: input.connectionId, organizationId: tenant.organizationId },
        select: { id: true, defaultDepartmentId: true },
      });
      if (!connection) {
        throw new AppError(404, 'CONNECTION_NOT_FOUND', 'Conexão não encontrada.');
      }
    } else {
      const preferredIdentity =
        contact.identities.find(
          (i) => i.connection.channel === ChannelType.WHATSAPP && i.connection.status === ConnectionStatus.ACTIVE
        ) ?? contact.identities[0];

      if (preferredIdentity) {
        connection = {
          id: preferredIdentity.connection.id,
          defaultDepartmentId: preferredIdentity.connection.defaultDepartmentId,
        };
      } else {
        connection =
          (await prisma.connection.findFirst({
            where: {
              organizationId: tenant.organizationId,
              channel: ChannelType.WHATSAPP,
              status: ConnectionStatus.ACTIVE,
            },
            orderBy: { updatedAt: 'desc' },
            select: { id: true, defaultDepartmentId: true },
          })) ??
          (await prisma.connection.findFirst({
            where: { organizationId: tenant.organizationId },
            orderBy: { createdAt: 'desc' },
            select: { id: true, defaultDepartmentId: true },
          }));
      }
    }

    if (!connection) {
      throw new AppError(
        400,
        'NO_CONNECTION_AVAILABLE',
        'Conecte um canal (ex.: WhatsApp) antes de iniciar uma nova conversa.'
      );
    }

    // Garante vínculo contact_identities caso o contato tenha phoneE164 mas ainda não tenha identidade nesta conexão
    const hasIdentityForConn = contact.identities.some((i) => i.connectionId === connection!.id);
    if (!hasIdentityForConn && contact.phoneE164) {
      const digits = contact.phoneE164.replace(/\D/g, '');
      if (digits.length >= 8 && digits.length <= 15 && !(digits.length === 15 && digits.startsWith('1'))) {
        await prisma.contactIdentity
          .upsert({
            where: {
              connectionId_externalContactId: {
                connectionId: connection.id,
                externalContactId: `${digits}@s.whatsapp.net`,
              },
            },
            update: {},
            create: {
              contactId: contact.id,
              connectionId: connection.id,
              externalContactId: `${digits}@s.whatsapp.net`,
            },
          })
          .catch(() => {});
      }
    }

    let departmentId = input.departmentId ?? connection.defaultDepartmentId;
    if (input.departmentId) {
      const dept = await prisma.department.findFirst({
        where: { id: input.departmentId, organizationId: tenant.organizationId },
        select: { id: true },
      });
      if (!dept) {
        throw new AppError(404, 'DEPARTMENT_NOT_FOUND', 'Departamento não encontrado.');
      }
      departmentId = dept.id;
    }

    const createdConv = await prisma.conversation.create({
      data: {
        organizationId: tenant.organizationId,
        connectionId: connection.id,
        contactId: contact.id,
        departmentId,
        assigneeId: tenant.userId,
        status: ConversationStatus.OPEN,
        lastMessageAt: new Date(),
      },
      include: CONVERSATION_CLIENT_INCLUDE,
    });

    const formatted = formatConversationForClient(createdConv);
    apiCache.invalidateOrgConversations(tenant.organizationId);
    apiCache.invalidateOrgContacts(tenant.organizationId);
    emitToOrganization(tenant.organizationId, 'conversation:updated', formatted);

    return reply.status(201).send({
      conversation: formatted,
      created: true,
    });
  });

  // GET /api/v1/conversations/:id
  app.get('/:id', async (request, reply) => {
    const tenant = getTenantContext(request);
    const { id } = request.params as { id: string };

    const row = await prisma.conversation.findFirst({
      where: { id, organizationId: tenant.organizationId },
      include: CONVERSATION_CLIENT_INCLUDE,
    });
    if (!row) {
      throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'Conversa não encontrada.');
    }

    return reply.send({ conversation: formatConversationForClient(row) });
  });

  // POST /api/v1/conversations/:id/read — zera unreadCount e inscreve presença do contato no WhatsApp
  app.post('/:id/read', async (request, reply) => {
    const tenant = getTenantContext(request);
    const { id } = request.params as { id: string };

    await prisma.conversation.updateMany({
      where: { id, organizationId: tenant.organizationId },
      data: { unreadCount: 0 },
    });

    apiCache.invalidateOrgConversations(tenant.organizationId);
    void whatsappManager.subscribePresenceForConversation(tenant.organizationId, id);

    return reply.send({
      ok: true,
      presence: whatsappManager.getConversationPresence(id),
    });
  });

  // POST /api/v1/conversations/:id/presence/subscribe — assina eventos de presença (digitando/gravando) no Baileys
  app.post('/:id/presence/subscribe', async (request, reply) => {
    const tenant = getTenantContext(request);
    const { id } = request.params as { id: string };

    void whatsappManager.subscribePresenceForConversation(tenant.organizationId, id);

    return reply.send({
      ok: true,
      presence: whatsappManager.getConversationPresence(id),
    });
  });

  // PATCH /api/v1/conversations/:id/assign — Transferir chamado (departamento + atendente + comentário)
  app.patch('/:id/assign', async (request, reply) => {
    const tenant = getTenantContext(request);
    const { id } = request.params as { id: string };
    const input = assignConversationSchema.parse(request.body);

    const [existing, dept, targetUser] = await Promise.all([
      prisma.conversation.findFirst({
        where: { id, organizationId: tenant.organizationId },
        select: {
          id: true,
          createdAt: true,
          protocolNumber: true,
          departmentId: true,
          assigneeId: true,
        },
      }),
      input.departmentId
        ? prisma.department.findFirst({
          where: { id: input.departmentId, organizationId: tenant.organizationId },
          select: { id: true, name: true },
        })
        : input.departmentName
          ? prisma.department.findFirst({
            where: { name: input.departmentName, organizationId: tenant.organizationId },
            select: { id: true, name: true },
          })
          : Promise.resolve(null),
      input.assigneeId
        ? prisma.user.findFirst({
          where: { id: input.assigneeId, organizationId: tenant.organizationId, isActive: true },
          select: { id: true, name: true },
        })
        : Promise.resolve(null),
    ]);

    if (!existing) {
      throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'Conversa não encontrada.');
    }
    if ((input.departmentId || input.departmentName) && !dept) {
      throw new AppError(404, 'DEPARTMENT_NOT_FOUND', 'Departamento não encontrado.');
    }
    if (input.assigneeId && !targetUser) {
      throw new AppError(404, 'AGENT_NOT_FOUND', 'Atendente não encontrado nesta organização.');
    }

    const departmentId = dept ? dept.id : existing.departmentId;
    const departmentName = dept ? dept.name : null;
    const assigneeName = targetUser ? targetUser.name : 'Fila do departamento';
    const actorName = tenant.name ?? 'Atendente';
    const ticketNumber = formatTicketNumber(existing.createdAt, existing.protocolNumber);

    const updatedRecord = await prisma.$transaction(async (tx) => {
      await tx.conversationEvent.create({
        data: {
          conversationId: existing.id,
          actorType: MessageSenderType.AGENT,
          actorUserId: tenant.userId,
          eventType: input.assigneeId
            ? ConversationEventType.TRANSFERRED_AGENT
            : ConversationEventType.TRANSFERRED_DEPARTMENT,
          payload: {
            departmentId,
            departmentName,
            assigneeId: input.assigneeId ?? null,
            assigneeName,
          },
        },
      });

      if (input.comment) {
        const note = await tx.message.create({
          data: {
            conversationId: existing.id,
            direction: MessageDirection.OUTGOING,
            visibility: MessageVisibility.PRIVATE_NOTE,
            senderType: MessageSenderType.AGENT,
            senderUserId: tenant.userId,
            senderName: `${actorName} (Transferência)`,
            content: input.comment,
          },
        });

        emitToOrganization(tenant.organizationId, 'message:created', {
          conversationId: existing.id,
          message: {
            id: note.id,
            conversationId: existing.id,
            type: 'private',
            sender: note.senderName,
            text: note.content,
            createdAt: note.createdAt.toISOString(),
          },
        });
      }

      return tx.conversation.update({
        where: { id: existing.id },
        data: {
          departmentId,
          assigneeId: input.assigneeId === undefined ? existing.assigneeId : input.assigneeId,
          lastMessageAt: new Date(),
        },
        include: CONVERSATION_CLIENT_INCLUDE,
      });
    });

    const updated = formatConversationForClient(updatedRecord);
    apiCache.invalidateOrgConversations(tenant.organizationId);
    if (input.comment) {
      apiCache.invalidateConversationMessages(tenant.organizationId, existing.id);
    }
    emitToOrganization(tenant.organizationId, 'conversation:updated', updated);

    return reply.send({
      ticketNumber,
      conversation: updated,
    });
  });

  // PATCH /api/v1/conversations/:id/status — finalizar ou reabrir chamado
  app.patch('/:id/status', async (request, reply) => {
    const tenant = getTenantContext(request);
    const { id } = request.params as { id: string };
    const { status } = updateStatusSchema.parse(request.body);

    const existing = await prisma.conversation.findFirst({
      where: { id, organizationId: tenant.organizationId },
      select: { id: true, createdAt: true },
    });
    if (!existing) {
      throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'Conversa não encontrada.');
    }

    const now = new Date();
    const resolutionSeconds =
      status === 'RESOLVED'
        ? Math.max(1, Math.round((now.getTime() - existing.createdAt.getTime()) / 1000))
        : null;

    const updatedRecord = await prisma.$transaction(async (tx) => {
      await tx.conversationEvent.create({
        data: {
          conversationId: existing.id,
          actorType: MessageSenderType.AGENT,
          actorUserId: tenant.userId,
          eventType:
            status === 'RESOLVED' ? ConversationEventType.RESOLVED : ConversationEventType.REOPENED,
        },
      });

      return tx.conversation.update({
        where: { id: existing.id },
        data: {
          status: status === 'RESOLVED' ? ConversationStatus.RESOLVED : ConversationStatus.OPEN,
          resolvedAt: status === 'RESOLVED' ? now : null,
          resolutionSeconds,
        },
        include: CONVERSATION_CLIENT_INCLUDE,
      });
    });

    const updated = formatConversationForClient(updatedRecord);
    apiCache.invalidateOrgConversations(tenant.organizationId);
    emitToOrganization(tenant.organizationId, 'conversation:updated', updated);

    return reply.send({ conversation: updated });
  });
}
