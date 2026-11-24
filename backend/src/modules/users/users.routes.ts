import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { AgentAvailability, ChannelType, ConnectionStatus, UserRole } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../../shared/database/prisma.js';
import {
  authenticate,
  getTenantContext,
  invalidateAuthUserCache,
  requireRoles,
} from '../../shared/http/authenticate.js';
import { AppError } from '../../shared/http/errors.js';
import { strongPasswordSchema } from '../auth/auth.schemas.js';

export const PRIMARY_ADMIN_EMAIL = 'ransay@supermegavendas.com';
const BCRYPT_ROUNDS = 12;

export const createUserSchema = z.object({
  name: z.string().trim().min(2, 'O nome deve ter pelo menos 2 caracteres.').max(120),
  email: z.string().trim().email('Informe um e-mail válido.'),
  password: strongPasswordSchema,
  role: z.enum(['ADMIN', 'USER']).default('USER'),
});

export const updateUserRoleSchema = z.object({
  role: z.enum(['ADMIN', 'USER']),
});

export function toPrismaUserRole(profile: 'ADMIN' | 'USER'): UserRole {
  return profile === 'ADMIN' ? UserRole.ADMIN : UserRole.AGENT;
}

export function toProfileCode(role: UserRole): 'ADMIN' | 'USER' {
  return role === UserRole.ADMIN ? 'ADMIN' : 'USER';
}

export function toProfileLabel(role: UserRole): 'Administrador' | 'User' {
  return role === UserRole.ADMIN ? 'Administrador' : 'User';
}

function serializeUserRow(
  user: {
    id: string;
    name: string;
    email: string;
    role: UserRole;
    availability: AgentAvailability;
    isActive: boolean;
    lastSeenAt: Date | null;
    createdAt: Date;
  },
  connectionsByOwner: Map<string, Array<{ id: string; name: string; identifier: string; status: ConnectionStatus }>>
) {
  const isPrimaryAdmin = user.email.toLowerCase() === PRIMARY_ADMIN_EMAIL;
  const ownedConns = connectionsByOwner.get(user.id) ?? [];

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: toProfileCode(user.role),
    dbRole: user.role,
    profileLabel: toProfileLabel(user.role),
    availability: user.availability,
    isActive: user.isActive,
    isPrimaryAdmin,
    whatsappConnectionsCount: ownedConns.length,
    whatsappConnections: ownedConns,
    lastSeenAt: user.lastSeenAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}

export async function usersRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requireRoles(UserRole.ADMIN));

  // GET /api/v1/users — lista todos os usuários da organização (apenas Administrador)
  app.get('/', async (request, reply) => {
    const tenant = getTenantContext(request);

    const [users, whatsappConns] = await Promise.all([
      prisma.user.findMany({
        where: { organizationId: tenant.organizationId },
        orderBy: [{ createdAt: 'asc' }],
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          availability: true,
          isActive: true,
          lastSeenAt: true,
          createdAt: true,
        },
      }),
      prisma.connection.findMany({
        where: {
          organizationId: tenant.organizationId,
          channel: ChannelType.WHATSAPP,
          status: { not: ConnectionStatus.ARCHIVED },
        },
        select: {
          id: true,
          name: true,
          identifier: true,
          status: true,
          metadata: true,
        },
      }),
    ]);

    const connectionsByOwner = new Map<
      string,
      Array<{ id: string; name: string; identifier: string; status: ConnectionStatus }>
    >();

    for (const c of whatsappConns) {
      const meta =
        c.metadata && typeof c.metadata === 'object' && !Array.isArray(c.metadata)
          ? (c.metadata as Record<string, unknown>)
          : null;
      const ownerId = typeof meta?.ownerUserId === 'string' ? meta.ownerUserId : null;
      if (!ownerId) continue;
      const list = connectionsByOwner.get(ownerId) ?? [];
      list.push({ id: c.id, name: c.name, identifier: c.identifier, status: c.status });
      connectionsByOwner.set(ownerId, list);
    }

    return reply.send({
      users: users.map((u) => serializeUserRow(u, connectionsByOwner)),
    });
  });

  // POST /api/v1/users — insere novo usuário (Administrador ou User)
  app.post('/', async (request, reply) => {
    const tenant = getTenantContext(request);
    const input = createUserSchema.parse(request.body);
    const normalizedEmail = input.email.toLowerCase();

    const existing = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true },
    });
    if (existing) {
      throw new AppError(409, 'EMAIL_ALREADY_EXISTS', 'Este e-mail já está cadastrado.');
    }

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const created = await prisma.user.create({
      data: {
        organizationId: tenant.organizationId,
        name: input.name,
        email: normalizedEmail,
        passwordHash,
        role: toPrismaUserRole(input.role),
        availability: AgentAvailability.OFFLINE,
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        availability: true,
        isActive: true,
        lastSeenAt: true,
        createdAt: true,
      },
    });

    return reply.status(201).send({
      user: serializeUserRow(created, new Map()),
      message: `Usuário "${created.name}" (${toProfileLabel(created.role)}) criado com sucesso.`,
    });
  });

  // PATCH /api/v1/users/:id/role — alterna perfil entre Administrador e User
  app.patch('/:id/role', async (request, reply) => {
    const tenant = getTenantContext(request);
    const { id } = request.params as { id: string };
    const { role } = updateUserRoleSchema.parse(request.body);

    const target = await prisma.user.findFirst({
      where: { id, organizationId: tenant.organizationId },
      select: { id: true, email: true, role: true },
    });

    if (!target) {
      throw new AppError(404, 'USER_NOT_FOUND', 'Usuário não encontrado nesta organização.');
    }

    if (target.email.toLowerCase() === PRIMARY_ADMIN_EMAIL && role !== 'ADMIN') {
      throw new AppError(
        403,
        'PRIMARY_ADMIN_PROTECTED',
        `O administrador principal (${PRIMARY_ADMIN_EMAIL}) não pode perder o perfil de Administrador.`
      );
    }

    if (target.id === tenant.userId && role !== 'ADMIN') {
      throw new AppError(
        400,
        'CANNOT_DEMOTE_SELF',
        'Você não pode rebaixar seu próprio perfil de Administrador.'
      );
    }

    const updated = await prisma.user.update({
      where: { id: target.id },
      data: { role: toPrismaUserRole(role) },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        availability: true,
        isActive: true,
        lastSeenAt: true,
        createdAt: true,
      },
    });

    invalidateAuthUserCache(tenant.organizationId, target.id);

    return reply.send({
      user: serializeUserRow(updated, new Map()),
      message: `Perfil de "${updated.name}" atualizado para ${toProfileLabel(updated.role)}.`,
    });
  });

  // DELETE /api/v1/users/:id — remove usuário da organização (protege administrador principal e o próprio usuário)
  app.delete('/:id', async (request, reply) => {
    const tenant = getTenantContext(request);
    const { id } = request.params as { id: string };

    const target = await prisma.user.findFirst({
      where: { id, organizationId: tenant.organizationId },
      select: { id: true, name: true, email: true },
    });

    if (!target) {
      throw new AppError(404, 'USER_NOT_FOUND', 'Usuário não encontrado nesta organização.');
    }

    if (target.email.toLowerCase() === PRIMARY_ADMIN_EMAIL) {
      throw new AppError(
        403,
        'PRIMARY_ADMIN_PROTECTED',
        `O administrador principal (${PRIMARY_ADMIN_EMAIL}) não pode ser removido.`
      );
    }

    if (target.id === tenant.userId) {
      throw new AppError(
        400,
        'CANNOT_DELETE_SELF',
        'Você não pode remover a sua própria conta enquanto está logado.'
      );
    }

    await prisma.user.delete({
      where: { id: target.id },
    });

    invalidateAuthUserCache(tenant.organizationId, target.id);

    return reply.send({
      deleted: true,
      userId: target.id,
      message: `Usuário "${target.name}" removido com sucesso.`,
    });
  });
}
