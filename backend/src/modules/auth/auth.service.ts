import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { AgentAvailability, LgpdSubjectType, UserApprovalStatus, UserRole } from '@prisma/client';

import { env } from '../../config/env.js';
import { prisma } from '../../shared/database/prisma.js';
import { AppError } from '../../shared/http/errors.js';
import type { AuthJwtPayload, TenantContext } from '../../shared/http/authenticate.js';
import {
  INVALID_DOMAIN_MESSAGE,
  isAllowedCorporateEmail,
  type ForgotPasswordInput,
  type LoginInput,
  type RegisterInput,
  type ResetPasswordInput,
  type UpdateAvailabilityInput,
} from './auth.schemas.js';

const BCRYPT_ROUNDS = 12;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 hora
const PRIMARY_ADMIN_EMAIL = 'ransay@supermegavendas.com';

function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function issueTokenPair(
  app: FastifyInstance,
  user: { id: string; organizationId: string; email: string; role: UserRole }
): { accessToken: string; refreshToken: string } {
  const basePayload = {
    sub: user.id,
    organizationId: user.organizationId,
    email: user.email,
    role: user.role,
  };

  const accessToken = app.jwt.sign(
    { ...basePayload, tokenType: 'access' } satisfies AuthJwtPayload,
    { expiresIn: env.JWT_EXPIRES_IN }
  );

  const refreshToken = app.jwt.sign(
    { ...basePayload, tokenType: 'refresh' } satisfies AuthJwtPayload,
    {
      expiresIn: env.JWT_REFRESH_EXPIRES_IN,
      key: env.JWT_REFRESH_SECRET,
    }
  );

  return { accessToken, refreshToken };
}

async function getLatestUserLgpdStatus(organizationId: string, userId: string) {
  const latest = await prisma.lgpdConsent.findFirst({
    where: {
      organizationId,
      subjectType: LgpdSubjectType.USER,
      subjectId: userId,
    },
    orderBy: { acceptedAt: 'desc' },
  });

  if (!latest) {
    return {
      accepted: false,
      termVersion: null,
      acceptedMarketing: false,
      acceptedAt: null,
      revokedAt: null,
    };
  }

  return {
    accepted: latest.acceptedRequired && latest.revokedAt === null,
    termVersion: latest.termVersion,
    acceptedMarketing: latest.acceptedMarketing,
    acceptedAt: latest.acceptedAt,
    revokedAt: latest.revokedAt,
  };
}

function serializeUserProfile(user: {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  role: UserRole;
  approvalStatus: UserApprovalStatus;
  availability: AgentAvailability;
  avatarUrl: string | null;
  lastSeenAt: Date | null;
  createdAt: Date;
  organization: { id: string; name: string; slug: string; plan: string };
  departments: Array<{ department: { id: string; name: string } }>;
}) {
  return {
    id: user.id,
    organizationId: user.organizationId,
    name: user.name,
    email: user.email,
    role: user.role,
    approvalStatus: user.approvalStatus,
    profile: user.role === UserRole.ADMIN ? 'ADMIN' : 'USER',
    profileLabel: user.role === UserRole.ADMIN ? 'Administrador' : 'User',
    availability: user.availability,
    avatarUrl: user.avatarUrl,
    lastSeenAt: user.lastSeenAt,
    createdAt: user.createdAt,
    organization: user.organization,
    departments: user.departments.map((d) => d.department),
  };
}

export const authService = {
  async login(app: FastifyInstance, input: LoginInput) {
    const normalizedEmail = input.email.toLowerCase();

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: {
        organization: { select: { id: true, name: true, slug: true, plan: true } },
        departments: { include: { department: { select: { id: true, name: true } } } },
      },
    });

    if (!user) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'E-mail ou senha inválidos.');
    }

    const passwordValid = await bcrypt.compare(input.password, user.passwordHash);
    if (!passwordValid) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'E-mail ou senha inválidos.');
    }

    if (user.approvalStatus === UserApprovalStatus.PENDING) {
      throw new AppError(
        403,
        'PENDING_APPROVAL',
        'Seu cadastro está aguardando aprovação de um administrador.'
      );
    }

    if (!user.isActive) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'E-mail ou senha inválidos.');
    }

    const ensurePrimaryAdminRole =
      user.email.toLowerCase() === PRIMARY_ADMIN_EMAIL && user.role !== UserRole.ADMIN;

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        lastSeenAt: new Date(),
        availability: user.availability === AgentAvailability.OFFLINE ? AgentAvailability.ONLINE : user.availability,
        ...(ensurePrimaryAdminRole ? { role: UserRole.ADMIN } : {}),
      },
      include: {
        organization: { select: { id: true, name: true, slug: true, plan: true } },
        departments: { include: { department: { select: { id: true, name: true } } } },
      },
    });

    const tokens = issueTokenPair(app, updated);
    const lgpd = await getLatestUserLgpdStatus(updated.organizationId, updated.id);

    return {
      ...tokens,
      tokenType: 'Bearer' as const,
      expiresIn: env.JWT_EXPIRES_IN,
      user: serializeUserProfile(updated),
      lgpd,
    };
  },

  async register(input: RegisterInput) {
    const normalizedEmail = input.email.trim().toLowerCase();

    if (!isAllowedCorporateEmail(normalizedEmail)) {
      throw new AppError(400, 'INVALID_EMAIL_DOMAIN', INVALID_DOMAIN_MESSAGE);
    }

    const existing = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, approvalStatus: true },
    });
    if (existing) {
      if (existing.approvalStatus === UserApprovalStatus.PENDING) {
        throw new AppError(
          409,
          'REGISTRATION_ALREADY_PENDING',
          'Já existe uma solicitação de cadastro pendente para este e-mail. Aguarde a aprovação de um administrador.'
        );
      }
      throw new AppError(409, 'EMAIL_ALREADY_EXISTS', 'Este e-mail já está cadastrado.');
    }

    const slug = input.organizationSlug ?? 'super-megavendas';
    const organization = await prisma.organization.findUnique({
      where: { slug },
      select: { id: true, name: true, slug: true, plan: true },
    });

    if (!organization) {
      throw new AppError(404, 'ORGANIZATION_NOT_FOUND', `Organização "${slug}" não encontrada.`);
    }

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

    const createdUser = await prisma.user.create({
      data: {
        organizationId: organization.id,
        name: input.name,
        email: normalizedEmail,
        passwordHash,
        role: UserRole.AGENT,
        approvalStatus: UserApprovalStatus.PENDING,
        isActive: false,
        availability: AgentAvailability.OFFLINE,
        lastSeenAt: null,
      },
      include: {
        organization: { select: { id: true, name: true, slug: true, plan: true } },
        departments: { include: { department: { select: { id: true, name: true } } } },
      },
    });

    return {
      pendingApproval: true as const,
      user: serializeUserProfile(createdUser),
      message:
        'Solicitação de cadastro enviada com sucesso! Seu acesso será liberado assim que um administrador aprovar sua conta.',
    };
  },

  async refresh(app: FastifyInstance, rawRefreshToken: string | undefined) {
    if (!rawRefreshToken) {
      throw new AppError(401, 'REFRESH_TOKEN_MISSING', 'Refresh token não informado.');
    }

    let decoded: AuthJwtPayload;
    try {
      decoded = app.jwt.verify<AuthJwtPayload>(rawRefreshToken, {
        key: env.JWT_REFRESH_SECRET,
      });
    } catch {
      throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token inválido ou expirado.');
    }

    if (decoded.tokenType !== 'refresh' || !decoded.sub || !decoded.organizationId) {
      throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Tipo de token inválido para renovação.');
    }

    const user = await prisma.user.findFirst({
      where: {
        id: decoded.sub,
        organizationId: decoded.organizationId,
        isActive: true,
        approvalStatus: UserApprovalStatus.APPROVED,
      },
      include: {
        organization: { select: { id: true, name: true, slug: true, plan: true } },
        departments: { include: { department: { select: { id: true, name: true } } } },
      },
    });

    if (!user) {
      throw new AppError(401, 'ACCOUNT_INACTIVE', 'Conta inativa ou não encontrada.');
    }

    const tokens = issueTokenPair(app, user);
    const lgpd = await getLatestUserLgpdStatus(user.organizationId, user.id);

    return {
      ...tokens,
      tokenType: 'Bearer' as const,
      expiresIn: env.JWT_EXPIRES_IN,
      user: serializeUserProfile(user),
      lgpd,
    };
  },

  async logout(tenant?: TenantContext) {
    if (tenant) {
      await prisma.user.updateMany({
        where: {
          id: tenant.userId,
          organizationId: tenant.organizationId,
          isActive: true,
        },
        data: {
          availability: AgentAvailability.OFFLINE,
          lastSeenAt: new Date(),
        },
      });
    }
  },

  async getMe(tenant: TenantContext) {
    const user = await prisma.user.findFirst({
      where: {
        id: tenant.userId,
        organizationId: tenant.organizationId,
        isActive: true,
      },
      include: {
        organization: { select: { id: true, name: true, slug: true, plan: true } },
        departments: { include: { department: { select: { id: true, name: true } } } },
      },
    });

    if (!user) {
      throw new AppError(404, 'USER_NOT_FOUND', 'Usuário não encontrado na organização.');
    }

    const lgpd = await getLatestUserLgpdStatus(tenant.organizationId, user.id);

    return {
      user: serializeUserProfile(user),
      lgpd,
    };
  },

  async updateAvailability(tenant: TenantContext, input: UpdateAvailabilityInput) {
    const result = await prisma.user.updateMany({
      where: {
        id: tenant.userId,
        organizationId: tenant.organizationId,
        isActive: true,
      },
      data: {
        availability: input.availability,
        lastSeenAt: new Date(),
      },
    });

    if (result.count === 0) {
      throw new AppError(404, 'USER_NOT_FOUND', 'Usuário não encontrado na organização.');
    }

    return {
      userId: tenant.userId,
      organizationId: tenant.organizationId,
      availability: input.availability,
    };
  },

  async forgotPassword(input: ForgotPasswordInput) {
    const normalizedEmail = input.email.toLowerCase();
    const user = await prisma.user.findFirst({
      where: {
        email: normalizedEmail,
        isActive: true,
      },
      select: { id: true, email: true, organizationId: true },
    });

    const genericResponse = {
      message: 'Se o e-mail estiver cadastrado, enviaremos as instruções de recuperação de senha.',
    };

    if (!user) {
      return genericResponse;
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);

    await prisma.$transaction(async (tx) => {
      // Invalida tokens anteriores ainda não utilizados deste usuário
      await tx.passwordReset.updateMany({
        where: {
          userId: user.id,
          usedAt: null,
        },
        data: {
          usedAt: new Date(),
        },
      });

      await tx.passwordReset.create({
        data: {
          userId: user.id,
          tokenHash,
          expiresAt,
        },
      });
    });

    // Em desenvolvimento, retorna o token para facilitar testes locais sem SMTP configurado
    if (env.NODE_ENV === 'development') {
      return {
        ...genericResponse,
        devResetToken: rawToken,
        expiresAt: expiresAt.toISOString(),
      };
    }

    return genericResponse;
  },

  async resetPassword(input: ResetPasswordInput) {
    const tokenHash = hashToken(input.token);
    const now = new Date();

    const resetRecord = await prisma.passwordReset.findUnique({
      where: { tokenHash },
      include: {
        user: {
          select: { id: true, organizationId: true, isActive: true },
        },
      },
    });

    if (
      !resetRecord ||
      resetRecord.usedAt !== null ||
      resetRecord.expiresAt <= now ||
      !resetRecord.user.isActive
    ) {
      throw new AppError(
        400,
        'INVALID_OR_EXPIRED_RESET_TOKEN',
        'Token de recuperação inválido, expirado ou já utilizado.'
      );
    }

    const newPasswordHash = await bcrypt.hash(input.newPassword, BCRYPT_ROUNDS);

    await prisma.$transaction(async (tx) => {
      await tx.user.updateMany({
        where: {
          id: resetRecord.user.id,
          organizationId: resetRecord.user.organizationId,
          isActive: true,
        },
        data: {
          passwordHash: newPasswordHash,
        },
      });

      await tx.passwordReset.update({
        where: { id: resetRecord.id },
        data: { usedAt: now },
      });
    });

    return {
      message: 'Senha redefinida com sucesso. Você já pode fazer login com a nova senha.',
    };
  },
};
