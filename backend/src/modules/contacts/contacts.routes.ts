import type { FastifyInstance } from 'fastify';
import { ConversationStatus } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../../shared/database/prisma.js';
import { apiCache, type CachedOrgContact } from '../../shared/cache/api-cache.js';
import { authenticate, getTenantContext } from '../../shared/http/authenticate.js';
import { AppError } from '../../shared/http/errors.js';
import {
  formatPhoneFromJid,
  getInitials,
  isSuspiciousLidPhone,
} from '../../shared/formatters/ticket.js';
import {
  CONVERSATION_CLIENT_INCLUDE,
  formatConversationForClient,
} from '../whatsapp/whatsapp.sync.js';

const createContactSchema = z.object({
  name: z.string().trim().min(2, 'Informe o nome do contato.').max(120),
  phone: z.string().trim().max(40).optional(),
  email: z.string().trim().email().optional().or(z.literal('')),
  connectionId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  startConversation: z.boolean().optional().default(true),
});

const CONTACT_LIST_SELECT = {
  id: true,
  name: true,
  roleTitle: true,
  phoneE164: true,
  email: true,
  avatarUrl: true,
  identities: {
    take: 1,
    select: {
      connectionId: true,
      connection: { select: { name: true } },
    },
  },
  conversations: {
    orderBy: { lastMessageAt: 'desc' as const },
    take: 1,
    select: {
      id: true,
      connectionId: true,
      connection: { select: { name: true } },
      department: { select: { name: true } },
    },
  },
};

type ContactRowForCache = {
  id: string;
  name: string;
  roleTitle: string | null;
  phoneE164: string | null;
  email: string | null;
  avatarUrl: string | null;
  identities: Array<{ connectionId: string; connection: { name: string } }>;
  conversations: Array<{
    id: string;
    connectionId: string;
    connection: { name: string };
    department: { name: string } | null;
  }>;
};

function toCachedOrgContact(c: ContactRowForCache): CachedOrgContact {
  const lastConv = c.conversations[0];
  const firstIdentity = c.identities[0];
  const displayName = isSuspiciousLidPhone(c.name) ? 'Contato WhatsApp' : c.name;
  const cleanPhoneE164 =
    c.phoneE164 && !isSuspiciousLidPhone(c.phoneE164) ? c.phoneE164 : null;
  const phoneDigits = (cleanPhoneE164 ?? '').replace(/\D/g, '');
  const phoneNoDdi =
    phoneDigits.startsWith('55') && phoneDigits.length >= 10
      ? phoneDigits.slice(2)
      : phoneDigits;
  const phoneDisplay = cleanPhoneE164
    ? formatPhoneFromJid(`${phoneDigits}@s.whatsapp.net`) || cleanPhoneE164
    : displayName;

  return {
    id: c.id,
    name: displayName,
    initials: getInitials(displayName),
    role: c.roleTitle ?? 'Contato',
    phone: phoneDisplay,
    phoneE164: cleanPhoneE164,
    email: c.email ?? '-',
    avatarUrl: c.avatarUrl ?? null,
    connection: lastConv?.connection?.name ?? firstIdentity?.connection?.name ?? '-',
    connectionId: lastConv?.connectionId ?? firstIdentity?.connectionId ?? null,
    department: lastConv?.department?.name ?? 'Suporte',
    conversationId: lastConv?.id ?? null,
    _nameLower: displayName.toLowerCase(),
    _phoneDigits: phoneDigits,
    _phoneNoDdi: phoneNoDdi,
    _emailLower: (c.email ?? '').toLowerCase(),
  };
}

function toPublicContact(c: CachedOrgContact) {
  return {
    id: c.id,
    name: c.name,
    initials: c.initials,
    role: c.role,
    phone: c.phone,
    phoneE164: c.phoneE164,
    email: c.email,
    avatarUrl: c.avatarUrl,
    connection: c.connection,
    connectionId: c.connectionId,
    department: c.department,
    conversationId: c.conversationId,
  };
}

function filterCachedContacts(
  all: CachedOrgContact[],
  rawQuery: string,
  limit: number
): CachedOrgContact[] {
  const qLower = rawQuery.trim().toLowerCase();
  if (!qLower) return all.slice(0, limit);

  const qDigits = rawQuery.replace(/\D/g, '');
  const qDigitsNoDdi =
    qDigits.startsWith('55') && qDigits.length > 2 ? qDigits.slice(2) : qDigits;

  const prefixMatches: CachedOrgContact[] = [];
  const otherMatches: CachedOrgContact[] = [];

  for (const c of all) {
    const nameStarts = c._nameLower.startsWith(qLower);
    const nameMatch = nameStarts || c._nameLower.includes(qLower);
    const emailMatch = c._emailLower.length > 0 && c._emailLower.includes(qLower);
    const phoneMatch =
      qDigits.length >= 2 &&
      (c._phoneDigits.includes(qDigits) ||
        c._phoneNoDdi.includes(qDigits) ||
        (qDigitsNoDdi.length >= 2 && c._phoneNoDdi.includes(qDigitsNoDdi)));

    if (nameMatch || emailMatch || phoneMatch) {
      if (nameStarts) prefixMatches.push(c);
      else otherMatches.push(c);
    }
  }

  return [...prefixMatches, ...otherMatches].slice(0, limit);
}

const warmingOrgContacts = new Set<string>();

async function warmOrgContactsCache(organizationId: string): Promise<CachedOrgContact[]> {
  if (warmingOrgContacts.has(organizationId)) {
    return apiCache.getOrgContacts(organizationId) ?? [];
  }
  warmingOrgContacts.add(organizationId);
  try {
    const rows = await prisma.contact.findMany({
      where: { organizationId },
      orderBy: [{ name: 'asc' }],
      take: 3000,
      select: CONTACT_LIST_SELECT,
    });
    const cached = rows.map(toCachedOrgContact);
    apiCache.setOrgContacts(organizationId, cached);
    return cached;
  } finally {
    warmingOrgContacts.delete(organizationId);
  }
}

export async function contactsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/v1/contacts?q=... (ou ?search=...) — busca instantânea (<100ms) com suporte a DDI 55 e cache em memória
  app.get('/', async (request, reply) => {
    const tenant = getTenantContext(request);
    const queryObj = request.query as { q?: string; search?: string; limit?: string };
    const rawQuery = (queryObj.q ?? queryObj.search ?? '').trim();
    const parsedLimit = Number(queryObj.limit);
    const limit =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(500, Math.floor(parsedLimit))
        : rawQuery
          ? 50
          : 200;

    // 1. Fast-path: índice da agenda em memória da organização (<2ms)
    const cachedAll = apiCache.getOrgContacts(tenant.organizationId);
    if (cachedAll) {
      const matched = filterCachedContacts(cachedAll, rawQuery, limit);
      return reply.send({
        contacts: matched.map(toPublicContact),
        total: cachedAll.length,
      });
    }

    // 2. Cache miss sem busca: carrega toda a agenda da organização no cache e retorna
    if (!rawQuery) {
      const loaded = await warmOrgContactsCache(tenant.organizationId);
      return reply.send({
        contacts: loaded.slice(0, limit).map(toPublicContact),
        total: loaded.length,
      });
    }

    // 3. Cache miss com busca: consulta indexada (ILIKE / pg_trgm) com e sem DDI 55 + aquece cache em segundo plano
    const digits = rawQuery.replace(/\D/g, '');
    const digitsNoDdi = digits.startsWith('55') && digits.length > 2 ? digits.slice(2) : digits;

    const orFilters: Array<Record<string, unknown>> = [
      { name: { contains: rawQuery, mode: 'insensitive' } },
      { email: { contains: rawQuery, mode: 'insensitive' } },
      { phoneE164: { contains: rawQuery, mode: 'insensitive' } },
    ];

    if (digits.length >= 2) {
      orFilters.push({ phoneE164: { contains: digits, mode: 'insensitive' } });
      if (digitsNoDdi.length >= 2 && digitsNoDdi !== digits) {
        orFilters.push({ phoneE164: { contains: digitsNoDdi, mode: 'insensitive' } });
      }
      if (!digits.startsWith('55') && digits.length >= 8 && digits.length <= 11) {
        orFilters.push({ phoneE164: { contains: `55${digits}`, mode: 'insensitive' } });
      }
    }

    const rows = await prisma.contact.findMany({
      where: {
        organizationId: tenant.organizationId,
        OR: orFilters,
      },
      orderBy: [{ name: 'asc' }],
      take: limit,
      select: CONTACT_LIST_SELECT,
    });

    // Aquece o cache completo em segundo plano para que as próximas teclas respondam em <2ms
    void warmOrgContactsCache(tenant.organizationId).catch(() => {});

    return reply.send({
      contacts: rows.map((r) => toPublicContact(toCachedOrgContact(r))),
      total: rows.length,
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
            .upsert({
              where: {
                connectionId_externalContactId: {
                  connectionId: conn.id,
                  externalContactId: `${digits}@s.whatsapp.net`,
                },
              },
              update: {},
              create: {
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
          include: CONVERSATION_CLIENT_INCLUDE,
        });
        conversation = formatConversationForClient(createdConv);
      }
    }

    apiCache.invalidateOrgContacts(tenant.organizationId);
    apiCache.invalidateOrgConversations(tenant.organizationId);

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

    apiCache.invalidateOrgContacts(tenant.organizationId);
    apiCache.invalidateOrgConversations(tenant.organizationId);

    return reply.send({ contact: updated });
  });
}
