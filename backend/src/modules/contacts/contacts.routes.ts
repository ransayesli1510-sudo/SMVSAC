import type { FastifyInstance } from 'fastify';
import { ConversationStatus } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../../shared/database/prisma.js';
import { authenticate, getTenantContext } from '../../shared/http/authenticate.js';
import { AppError } from '../../shared/http/errors.js';
import { getInitials } from '../../shared/formatters/ticket.js';
import { serializeConversationForClient } from '../whatsapp/whatsapp.sync.js';

const createContactSchema = z.object({
  name: z.string().trim().min(2, 'Informe o nome do contato.').max(120),
  phone: z.string().trim().max(40).optional(),
  email: z.string().trim().email().optional().or(z.literal('')),
  connectionId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  startConversation: z.boolean().optional().default(true),
});

export async function contactsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/v1/contacts
  app.get('/', async (request, reply) => {
    const tenant = getTenantContext(request);
    const { q } = request.query as { q?: string };

    const contacts = await prisma.contact.findMany({
      where: {
        organizationId: tenant.organizationId,
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { phoneE164: { contains: q, mode: 'insensitive' } },
                { email: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        conversations: {
          orderBy: { lastMessageAt: 'desc' },
          take: 1,
          include: {
            connection: { select: { name: true } },
            department: { select: { name: true } },
          },
        },
      },
    });

    return reply.send({
      contacts: contacts.map((c) => {
        const lastConv = c.conversations[0];
        return {
          id: c.id,
          name: c.name,
          initials: getInitials(c.name),
          role: c.roleTitle ?? 'Contato',
          phone: c.phoneE164 ?? 'Não informado',
          email: c.email ?? '-',
          connection: lastConv?.connection?.name ?? '-',
          department: lastConv?.department?.name ?? 'Suporte',
          conversationId: lastConv?.id ?? null,
        };
      }),
    });
  });

  // POST /api/v1/contacts
  app.post('/', async (request, reply) => {
    const tenant = getTenantContext(request);
    const input = createContactSchema.parse(request.body);

    const digits = (input.phone || '').replace(/\D/g, '');
    const phoneE164 = digits ? `+${digits}` : null;

    const contact = await prisma.contact.create({
      data: {
        organizationId: tenant.organizationId,
        name: input.name,
        phoneE164,
        email: input.email || null,
        roleTitle: 'Contato',
      },
    });

    let conversation = null;
    if (input.startConversation) {
      const conn = input.connectionId
        ? await prisma.connection.findFirst({
            where: { id: input.connectionId, organizationId: tenant.organizationId },
          })
        : await prisma.connection.findFirst({
            where: { organizationId: tenant.organizationId },
            orderBy: { createdAt: 'desc' },
          });

      if (conn) {
        if (digits) {
          await prisma.contactIdentity
            .create({
              data: {
                contactId: contact.id,
                connectionId: conn.id,
                externalContactId: `${digits}@s.whatsapp.net`,
              },
            })
            .catch(() => {});
        }

        const createdConv = await prisma.conversation.create({
          data: {
            organizationId: tenant.organizationId,
            connectionId: conn.id,
            contactId: contact.id,
            departmentId: input.departmentId ?? conn.defaultDepartmentId,
            assigneeId: tenant.userId,
            status: ConversationStatus.OPEN,
          },
        });
        conversation = await serializeConversationForClient(createdConv.id);
      }
    }

    return reply.status(201).send({ contact, conversation });
  });

  // PATCH /api/v1/contacts/:id
  app.patch('/:id', async (request, reply) => {
    const tenant = getTenantContext(request);
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; phone?: string; email?: string };

    const existing = await prisma.contact.findFirst({
      where: { id, organizationId: tenant.organizationId },
    });
    if (!existing) {
      throw new AppError(404, 'CONTACT_NOT_FOUND', 'Contato não encontrado.');
    }

    const updated = await prisma.contact.update({
      where: { id: existing.id },
      data: {
        ...(body.name ? { name: body.name.trim() } : {}),
        ...(body.phone !== undefined ? { phoneE164: body.phone.trim() || null } : {}),
        ...(body.email !== undefined ? { email: body.email.trim() || null } : {}),
      },
    });

    return reply.send({ contact: updated });
  });
}
