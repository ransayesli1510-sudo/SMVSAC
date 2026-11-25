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
  departmentId: z.string().uuid('Setor inválido.').optional().nullable().or(z.literal('')),
  departmentName: z.string().trim().max(120).optional().nullable(),
});

export const updateUserSchema = z.object({
  name: z.string().trim().min(2, 'O nome deve ter pelo menos 2 caracteres.').max(120).optional(),
  email: z.string().trim().email('Informe um e-mail válido.').optional(),
  role: z.enum(['ADMIN', 'USER']).optional(),
  departmentId: z.string().uuid('Setor inválido.').optional().nullable().or(z.literal('')),
  departmentName: z.string().trim().max(120).optional().nullable(),
});

export const resetUserPasswordSchema = z.object({
  password: strongPasswordSchema,
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

const USER_ROW_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  availability: true,
  isActive: true,
  lastSeenAt: true,
  createdAt: true,
  departments: {
    orderBy: { createdAt: 'asc' as const },
    include: {
      department: {
        select: { id: true, name: true },
      },
    },
  },
} as const;

async function resolveDepartmentId(
  organizationId: string,
  departmentId?: string | null,
  departmentName?: string | null
): Promise<string | null> {
  const cleanId = typeof departmentId === 'string' ? departmentId.trim() : '';
  if (cleanId) {
    const foundById = await prisma.department.findFirst({
      where: { id: cleanId, organizationId },
      select: { id: true },
    });
    if (!foundById) {
      throw new AppError(400, 'INVALID_DEPARTMENT', 'O setor informado não foi encontrado nesta organização.');
    }
    return foundById.id;
  }

  const cleanName = typeof departmentName === 'string' ? departmentName.trim() : '';
  if (!cleanName) return null;

  const existing = await prisma.department.findFirst({
    where: {
      organizationId,
      name: { equals: cleanName, mode: 'insensitive' },
    },
    select: { id: true },
  });
  if (existing) return existing.id;

  const created = await prisma.department.upsert({
    where: { organizationId_name: { organizationId, name: cleanName } },
    update: { isActive: true },
    create: { organizationId, name: cleanName },
    select: { id: true },
  });
  return created.id;
}

async function getWhatsAppConnectionsByOwner(
  organizationId: string
): Promise<Map<string, Array<{ id: string; name: string; identifier: string; status: ConnectionStatus }>>> {
  const whatsappConns = await prisma.connection.findMany({
    where: {
      organizationId,
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
  });

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

  return connectionsByOwner;
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
    departments?: Array<{ department: { id: string; name: string } }>;
  },
  connectionsByOwner: Map<string, Array<{ id: string; name: string; identifier: string; status: ConnectionStatus }>>
) {
  const isPrimaryAdmin = user.email.toLowerCase() === PRIMARY_ADMIN_EMAIL;
  const ownedConns = connectionsByOwner.get(user.id) ?? [];
  const departments = (user.departments ?? []).map((du) => du.department);
  const primaryDepartment = departments[0] ?? null;

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: toProfileCode(user.role),
    dbRole: user.role,
    profileLabel: toProfileLabel(user.role),
    departmentId: primaryDepartment?.id ?? null,
    department: primaryDepartment?.name ?? null,
    departments,
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

    const [users, connectionsByOwner] = await Promise.all([
      prisma.user.findMany({
        where: { organizationId: tenant.organizationId },
        orderBy: [{ createdAt: 'asc' }],
        select: USER_ROW_SELECT,
      }),
      getWhatsAppConnectionsByOwner(tenant.organizationId),
    ]);

    return reply.send({
      users: users.map((u) => serializeUserRow(u, connectionsByOwner)),
    });
  });

  // POST /api/v1/users — insere novo usuário (Administrador ou User) com alocação opcional de setor
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

    const resolvedDepartmentId = await resolveDepartmentId(
      tenant.organizationId,
      input.departmentId,
      input.departmentName
    );

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
        ...(resolvedDepartmentId
          ? {
              departments: {
                create: { departmentId: resolvedDepartmentId },
              },
            }
          : {}),
      },
      select: USER_ROW_SELECT,
    });

    const serialized = serializeUserRow(created, new Map());
    const sectorSuffix = serialized.department ? ` • Setor: ${serialized.department}` : '';

    return reply.status(201).send({
      user: serialized,
      message: `Usuário "${created.name}" (${toProfileLabel(created.role)}${sectorSuffix}) criado com sucesso.`,
    });
  });

  // PATCH /api/v1/users/:id — edita dados do usuário (nome, e-mail, setor e perfil)
  app.patch('/:id', async (request, reply) => {
    const tenant = getTenantContext(request);
    const { id } = request.params as { id: string };
    const input = updateUserSchema.parse(request.body);

    const target = await prisma.user.findFirst({
      where: { id, organizationId: tenant.organizationId },
      select: { id: true, name: true, email: true, role: true },
    });

    if (!target) {
      throw new AppError(404, 'USER_NOT_FOUND', 'Usuário não encontrado nesta organização.');
    }

    const isPrimaryAdmin = target.email.toLowerCase() === PRIMARY_ADMIN_EMAIL;
    const isSelf = target.id === tenant.userId;

    if (input.role !== undefined) {
      if (isPrimaryAdmin && input.role !== 'ADMIN') {
        throw new AppError(
          403,
          'PRIMARY_ADMIN_PROTECTED',
          `O administrador principal (${PRIMARY_ADMIN_EMAIL}) não pode perder o perfil de Administrador.`
        );
      }
      if (isSelf && input.role !== 'ADMIN') {
        throw new AppError(
          400,
          'CANNOT_DEMOTE_SELF',
          'Você não pode rebaixar seu próprio perfil de Administrador.'
        );
      }
    }

    let nextEmail: string | undefined;
    if (input.email !== undefined) {
      const normalizedEmail = input.email.toLowerCase();
      if (normalizedEmail !== target.email.toLowerCase()) {
        if (isPrimaryAdmin) {
          throw new AppError(
            403,
            'PRIMARY_ADMIN_PROTECTED',
            `O e-mail do administrador principal (${PRIMARY_ADMIN_EMAIL}) não pode ser alterado.`
          );
        }
        const emailTaken = await prisma.user.findUnique({
          where: { email: normalizedEmail },
          select: { id: true },
        });
        if (emailTaken && emailTaken.id !== target.id) {
          throw new AppError(409, 'EMAIL_ALREADY_EXISTS', 'Este e-mail já está em uso por outro usuário.');
        }
        nextEmail = normalizedEmail;
      }
    }

    const shouldUpdateDepartment = input.departmentId !== undefined || input.departmentName !== undefined;
    const resolvedDepartmentId = shouldUpdateDepartment
      ? await resolveDepartmentId(tenant.organizationId, input.departmentId, input.departmentName)
      : undefined;

    const updated = await prisma.$transaction(async (tx) => {
      if (shouldUpdateDepartment) {
        await tx.departmentUser.deleteMany({ where: { userId: target.id } });
        if (resolvedDepartmentId) {
          await tx.departmentUser.create({
            data: {
              userId: target.id,
              departmentId: resolvedDepartmentId,
            },
          });
        }
      }

      return tx.user.update({
        where: { id: target.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(nextEmail !== undefined ? { email: nextEmail } : {}),
          ...(input.role !== undefined ? { role: toPrismaUserRole(input.role) } : {}),
        },
        select: USER_ROW_SELECT,
      });
    });

    invalidateAuthUserCache(tenant.organizationId, target.id);
    const connectionsByOwner = await getWhatsAppConnectionsByOwner(tenant.organizationId);

    return reply.send({
      user: serializeUserRow(updated, connectionsByOwner),
      message: `Usuário "${updated.name}" atualizado com sucesso.`,
    });
  });

  // PATCH /api/v1/users/:id/password — administrador redefine a senha do usuário
  app.patch('/:id/password', async (request, reply) => {
    const tenant = getTenantContext(request);
    const { id } = request.params as { id: string };
    const { password } = resetUserPasswordSchema.parse(request.body);

    const target = await prisma.user.findFirst({
      where: { id, organizationId: tenant.organizationId },
      select: { id: true, name: true, email: true },
    });

    if (!target) {
      throw new AppError(404, 'USER_NOT_FOUND', 'Usuário não encontrado nesta organização.');
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: target.id },
        data: { passwordHash },
      }),
      prisma.passwordReset.updateMany({
        where: { userId: target.id, usedAt: null },
        data: { usedAt: new Date() },
      }),
    ]);

    invalidateAuthUserCache(tenant.organizationId, target.id);

    return reply.send({
      updated: true,
      userId: target.id,
      message: `Senha de "${target.name}" redefinida com sucesso.`,
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
      select: USER_ROW_SELECT,
    });

    invalidateAuthUserCache(tenant.organizationId, target.id);
    const connectionsByOwner = await getWhatsAppConnectionsByOwner(tenant.organizationId);

    return reply.send({
      user: serializeUserRow(updated, connectionsByOwner),
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
