import type { FastifyInstance } from 'fastify';
import {
  ConversationEventType,
  ConversationStatus,
  MessageDirection,
  MessageSenderType,
  MessageVisibility,
} from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../../shared/database/prisma.js';
import { authenticate, getTenantContext } from '../../shared/http/authenticate.js';
import { AppError } from '../../shared/http/errors.js';
import { formatTicketNumber } from '../../shared/formatters/ticket.js';
import { emitToOrganization } from '../../realtime/socket.js';
import { serializeConversationForClient } from '../whatsapp/whatsapp.sync.js';

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
        where: { organizationId: tenant.organizationId, isActive: true },
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

    const rows = await prisma.conversation.findMany({
      where,
      orderBy,
      take: 100,
      select: { id: true },
    });

    const serialized = (
      await Promise.all(rows.map((r) => serializeConversationForClient(r.id)))
    ).filter((item): item is NonNullable<typeof item> => item !== null);

    return reply.send({ conversations: serialized });
  });

  // GET /api/v1/conversations/:id
  app.get('/:id', async (request, reply) => {
    const tenant = getTenantContext(request);
    const { id } = request.params as { id: string };

    const exists = await prisma.conversation.findFirst({
      where: { id, organizationId: tenant.organizationId },
      select: { id: true },
    });
    if (!exists) {
      throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'Conversa não encontrada.');
    }

    const conversation = await serializeConversationForClient(exists.id);
    return reply.send({ conversation });
  });

  // POST /api/v1/conversations/:id/read — zera unreadCount
  app.post('/:id/read', async (request, reply) => {
    const tenant = getTenantContext(request);
    const { id } = request.params as { id: string };

    await prisma.conversation.updateMany({
      where: { id, organizationId: tenant.organizationId },
      data: { unreadCount: 0 },
    });

    return reply.send({ ok: true });
  });

  // PATCH /api/v1/conversations/:id/assign — Transferir chamado (departamento + atendente + comentário)
  app.patch('/:id/assign', async (request, reply) => {
    const tenant = getTenantContext(request);
    const { id } = request.params as { id: string };
    const input = assignConversationSchema.parse(request.body);

    const existing = await prisma.conversation.findFirst({
      where: { id, organizationId: tenant.organizationId },
      include: { contact: { select: { name: true } } },
    });
    if (!existing) {
      throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'Conversa não encontrada.');
    }

    let departmentId = input.departmentId ?? existing.departmentId;
    let departmentName = input.departmentName ?? null;
    if (input.departmentId) {
      const dept = await prisma.department.findFirst({
        where: { id: input.departmentId, organizationId: tenant.organizationId },
        select: { id: true, name: true },
      });
      if (!dept) throw new AppError(404, 'DEPARTMENT_NOT_FOUND', 'Departamento não encontrado.');
      departmentId = dept.id;
      departmentName = dept.name;
    } else if (input.departmentName) {
      const dept = await prisma.department.findFirst({
        where: { name: input.departmentName, organizationId: tenant.organizationId },
        select: { id: true, name: true },
      });
      if (!dept) throw new AppError(404, 'DEPARTMENT_NOT_FOUND', 'Departamento não encontrado.');
      departmentId = dept.id;
      departmentName = dept.name;
    }

    let assigneeName = 'Fila do departamento';
    if (input.assigneeId) {
      const targetUser = await prisma.user.findFirst({
        where: { id: input.assigneeId, organizationId: tenant.organizationId, isActive: true },
        select: { id: true, name: true },
      });
      if (!targetUser) {
        throw new AppError(404, 'AGENT_NOT_FOUND', 'Atendente não encontrado nesta organização.');
      }
      assigneeName = targetUser.name;
    }

    const actor = await prisma.user.findFirst({
      where: { id: tenant.userId, organizationId: tenant.organizationId },
      select: { name: true },
    });

    const ticketNumber = formatTicketNumber(existing.createdAt, existing.protocolNumber);

    await prisma.$transaction(async (tx) => {
      await tx.conversation.update({
        where: { id: existing.id },
        data: {
          departmentId,
          assigneeId: input.assigneeId === undefined ? existing.assigneeId : input.assigneeId,
          lastMessageAt: new Date(),
        },
      });

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
            senderName: `${actor?.name ?? 'Atendente'} (Transferência)`,
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
    });

    const updated = await serializeConversationForClient(existing.id);
    if (updated) {
      emitToOrganization(tenant.organizationId, 'conversation:updated', updated);
    }

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
    });
    if (!existing) {
      throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'Conversa não encontrada.');
    }

    const now = new Date();
    const resolutionSeconds =
      status === 'RESOLVED'
        ? Math.max(1, Math.round((now.getTime() - existing.createdAt.getTime()) / 1000))
        : null;

    await prisma.$transaction(async (tx) => {
      await tx.conversation.update({
        where: { id: existing.id },
        data: {
          status: status === 'RESOLVED' ? ConversationStatus.RESOLVED : ConversationStatus.OPEN,
          resolvedAt: status === 'RESOLVED' ? now : null,
          resolutionSeconds,
        },
      });

      await tx.conversationEvent.create({
        data: {
          conversationId: existing.id,
          actorType: MessageSenderType.AGENT,
          actorUserId: tenant.userId,
          eventType:
            status === 'RESOLVED' ? ConversationEventType.RESOLVED : ConversationEventType.REOPENED,
        },
      });
    });

    const updated = await serializeConversationForClient(existing.id);
    if (updated) {
      emitToOrganization(tenant.organizationId, 'conversation:updated', updated);
    }

    return reply.send({ conversation: updated });
  });
}
