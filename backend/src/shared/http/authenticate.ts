import type { FastifyReply, FastifyRequest } from 'fastify';
import { UserApprovalStatus, type UserRole } from '@prisma/client';
import { prisma } from '../database/prisma.js';
import { AppError } from './errors.js';

export interface AuthJwtPayload {
  sub: string;
  organizationId: string;
  email: string;
  role: UserRole;
  tokenType: 'access' | 'refresh';
}

export interface TenantContext {
  organizationId: string;
  userId: string;
  name?: string;
  email: string;
  role: UserRole;
}

const AUTH_CACHE_TTL_MS = 60_000; // 60 segundos — evita 1 round-trip ao Supabase por requisição
const AUTH_CACHE_MAX_SIZE = 1000;
const authUserCache = new Map<string, { tenant: TenantContext; expiresAt: number }>();

export function invalidateAuthUserCache(organizationId?: string, userId?: string): void {
  if (!organizationId || !userId) {
    authUserCache.clear();
    return;
  }
  authUserCache.delete(`${organizationId}:${userId}`);
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthJwtPayload;
    user: AuthJwtPayload;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    tenant?: TenantContext;
  }
}

/**
 * Middleware de autenticação:
 * 1. Valida o Bearer JWT (access token) assinado com JWT_SECRET.
 * 2. Garante que o token é do tipo 'access' (bloqueia uso de refresh token em rotas protegidas).
 * 3. Confirma no banco (isolado por organizationId) que o usuário segue ativo (evita uso pós-anonimização/desativação).
 * 4. Injeta `request.tenant` para isolar todas as consultas subsequentes por `organization_id`.
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    return reply.status(401).send({
      error: 'UNAUTHORIZED',
      message: 'Token de autenticação inválido ou expirado.',
    });
  }

  const payload = request.user;
  if (!payload || payload.tokenType !== 'access' || !payload.sub || !payload.organizationId) {
    return reply.status(401).send({
      error: 'INVALID_ACCESS_TOKEN',
      message: 'Tipo de token inválido para acesso à API.',
    });
  }

  const cacheKey = `${payload.organizationId}:${payload.sub}`;
  const now = Date.now();
  const cached = authUserCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    request.tenant = cached.tenant;
    return;
  }

  const activeUser = await prisma.user.findFirst({
    where: {
      id: payload.sub,
      organizationId: payload.organizationId,
      isActive: true,
      approvalStatus: UserApprovalStatus.APPROVED,
    },
    select: {
      id: true,
      organizationId: true,
      name: true,
      email: true,
      role: true,
    },
  });

  if (!activeUser) {
    authUserCache.delete(cacheKey);
    return reply.status(401).send({
      error: 'ACCOUNT_INACTIVE',
      message: 'Usuário inativo, revogado ou não pertence à organização informada.',
    });
  }

  const tenant: TenantContext = {
    organizationId: activeUser.organizationId,
    userId: activeUser.id,
    name: activeUser.name,
    email: activeUser.email,
    role: activeUser.role,
  };

  if (authUserCache.size >= AUTH_CACHE_MAX_SIZE) {
    authUserCache.clear();
  }
  authUserCache.set(cacheKey, { tenant, expiresAt: now + AUTH_CACHE_TTL_MS });

  request.tenant = tenant;
}

/**
 * Middleware de controle de acesso por papel (RBAC).
 */
export function requireRoles(...allowedRoles: UserRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const tenant = request.tenant;
    if (!tenant) {
      return reply.status(401).send({
        error: 'UNAUTHORIZED',
        message: 'Autenticação obrigatória.',
      });
    }

    if (!allowedRoles.includes(tenant.role)) {
      return reply.status(403).send({
        error: 'FORBIDDEN',
        message: 'Permissão insuficiente para executar esta operação.',
      });
    }
  };
}

/**
 * Extrai o contexto multi-tenant obrigatório da requisição autenticada.
 */
export function getTenantContext(request: FastifyRequest): TenantContext {
  if (!request.tenant) {
    throw new AppError(401, 'UNAUTHORIZED', 'Contexto autenticado da organização ausente.');
  }
  return request.tenant;
}
