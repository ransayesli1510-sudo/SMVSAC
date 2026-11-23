import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import {
  AgentAvailability,
  LgpdSubjectType,
  MessageDirection,
  MessageVisibility,
  UserRole,
} from '@prisma/client';

import { prisma } from '../../shared/database/prisma.js';
import { storageService } from '../../shared/storage/supabase-storage.js';
import { AppError } from '../../shared/http/errors.js';
import type { TenantContext } from '../../shared/http/authenticate.js';
import type {
  AnonymizeInput,
  RecordConsentInput,
  RevokeConsentInput,
} from './lgpd.schemas.js';

export interface RequestAuditMeta {
  ipAddress: string | null;
  userAgent: string | null;
}

function assertManagerRole(tenant: TenantContext): void {
  if (tenant.role !== UserRole.ADMIN && tenant.role !== UserRole.SUPERVISOR) {
    throw new AppError(
      403,
      'FORBIDDEN',
      'Apenas administradores ou supervisores podem executar ações LGPD sobre contatos.'
    );
  }
}

async function resolveConsentSubject(
  tenant: TenantContext,
  subjectType: 'USER' | 'CONTACT',
  subjectId?: string
): Promise<{ subjectType: LgpdSubjectType; subjectId: string }> {
  if (subjectType === 'USER') {
    return {
      subjectType: LgpdSubjectType.USER,
      subjectId: tenant.userId,
    };
  }

  assertManagerRole(tenant);
  if (!subjectId) {
    throw new AppError(400, 'SUBJECT_ID_REQUIRED', 'Informe o subjectId do contato.');
  }

  const contact = await prisma.contact.findFirst({
    where: {
      id: subjectId,
      organizationId: tenant.organizationId,
    },
    select: { id: true },
  });

  if (!contact) {
    throw new AppError(404, 'CONTACT_NOT_FOUND', 'Contato não encontrado nesta organização.');
  }

  return {
    subjectType: LgpdSubjectType.CONTACT,
    subjectId: contact.id,
  };
}

export const lgpdService = {
  /**
   * Registro estritamente imutável (append-only) de consentimento na tabela `lgpd_consents`.
   * Nunca sobrescreve registros anteriores para preservar a trilha legal de auditoria.
   */
  async recordConsent(
    tenant: TenantContext,
    input: RecordConsentInput,
    meta: RequestAuditMeta
  ) {
    const subject = await resolveConsentSubject(tenant, input.subjectType, input.subjectId);

    const created = await prisma.lgpdConsent.create({
      data: {
        organizationId: tenant.organizationId,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        termVersion: input.termVersion,
        acceptedRequired: input.acceptedRequired,
        acceptedMarketing: input.acceptedMarketing,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
    });

    return {
      consent: created,
    };
  },

  /**
   * Revogação append-only (Art. 18, IX da LGPD): registra novo evento com `revokedAt`
   * sem alterar nem apagar os registros históricos anteriores.
   */
  async revokeConsent(
    tenant: TenantContext,
    input: RevokeConsentInput,
    meta: RequestAuditMeta
  ) {
    const subject = await resolveConsentSubject(tenant, input.subjectType, input.subjectId);

    const revoked = await prisma.lgpdConsent.create({
      data: {
        organizationId: tenant.organizationId,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        termVersion: input.termVersion,
        acceptedRequired: false,
        acceptedMarketing: false,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        revokedAt: new Date(),
      },
    });

    return {
      message: 'Consentimento revogado e registrado na trilha imutável da LGPD.',
      consent: revoked,
    };
  },

  /**
   * Lista todo o histórico de consentimentos do usuário autenticado (isolado por organization_id).
   */
  async listMyConsents(tenant: TenantContext) {
    const history = await prisma.lgpdConsent.findMany({
      where: {
        organizationId: tenant.organizationId,
        subjectType: LgpdSubjectType.USER,
        subjectId: tenant.userId,
      },
      orderBy: { acceptedAt: 'desc' },
    });

    const latest = history[0] ?? null;

    return {
      currentStatus: latest
        ? {
            accepted: latest.acceptedRequired && latest.revokedAt === null,
            termVersion: latest.termVersion,
            acceptedMarketing: latest.acceptedMarketing,
            acceptedAt: latest.acceptedAt,
            revokedAt: latest.revokedAt,
          }
        : {
            accepted: false,
            termVersion: null,
            acceptedMarketing: false,
            acceptedAt: null,
            revokedAt: null,
          },
      history,
    };
  },

  /**
   * Consulta e exportação portável de dados pessoais (Art. 18, I, II e V da LGPD).
   * - Sem `contactId`: exporta os dados do próprio usuário autenticado.
   * - Com `contactId` (ADMIN/SUPERVISOR): exporta os dados do contato da mesma organização.
   */
  async exportData(tenant: TenantContext, contactId?: string) {
    if (contactId) {
      assertManagerRole(tenant);

      const contact = await prisma.contact.findFirst({
        where: {
          id: contactId,
          organizationId: tenant.organizationId,
        },
        include: {
          identities: {
            select: {
              id: true,
              connectionId: true,
              externalContactId: true,
              createdAt: true,
            },
          },
          conversations: {
            where: { organizationId: tenant.organizationId },
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              protocolNumber: true,
              status: true,
              csatScore: true,
              csatComment: true,
              createdAt: true,
              resolvedAt: true,
              connection: { select: { id: true, name: true, channel: true } },
              department: { select: { id: true, name: true } },
              messages: {
                where: { visibility: MessageVisibility.PUBLIC },
                orderBy: { createdAt: 'asc' },
                select: {
                  id: true,
                  direction: true,
                  senderType: true,
                  senderName: true,
                  content: true,
                  contentType: true,
                  createdAt: true,
                  attachments: {
                    select: {
                      id: true,
                      fileName: true,
                      mimeType: true,
                      sizeBytes: true,
                      createdAt: true,
                    },
                  },
                },
              },
            },
          },
        },
      });

      if (!contact) {
        throw new AppError(404, 'CONTACT_NOT_FOUND', 'Contato não encontrado nesta organização.');
      }

      const consents = await prisma.lgpdConsent.findMany({
        where: {
          organizationId: tenant.organizationId,
          subjectType: LgpdSubjectType.CONTACT,
          subjectId: contact.id,
        },
        orderBy: { acceptedAt: 'desc' },
      });

      return {
        exportedAt: new Date().toISOString(),
        legalBasis: 'LGPD — Lei nº 13.709/2018 (Art. 18, incisos I, II e V)',
        organizationId: tenant.organizationId,
        subjectType: LgpdSubjectType.CONTACT,
        data: {
          profile: {
            id: contact.id,
            name: contact.name,
            company: contact.company,
            roleTitle: contact.roleTitle,
            phoneE164: contact.phoneE164,
            email: contact.email,
            avatarUrl: contact.avatarUrl,
            customAttributes: contact.customAttributes,
            createdAt: contact.createdAt,
            updatedAt: contact.updatedAt,
          },
          identities: contact.identities,
          lgpdConsents: consents,
          conversations: contact.conversations,
        },
      };
    }

    // Exportação dos dados do próprio usuário autenticado
    const user = await prisma.user.findFirst({
      where: {
        id: tenant.userId,
        organizationId: tenant.organizationId,
      },
      select: {
        id: true,
        organizationId: true,
        name: true,
        email: true,
        role: true,
        availability: true,
        avatarUrl: true,
        isActive: true,
        lastSeenAt: true,
        createdAt: true,
        updatedAt: true,
        organization: { select: { id: true, name: true, slug: true } },
        departments: { include: { department: { select: { id: true, name: true } } } },
      },
    });

    if (!user) {
      throw new AppError(404, 'USER_NOT_FOUND', 'Usuário não encontrado nesta organização.');
    }

    const [consents, sentMessagesCount, recentEvents] = await Promise.all([
      prisma.lgpdConsent.findMany({
        where: {
          organizationId: tenant.organizationId,
          subjectType: LgpdSubjectType.USER,
          subjectId: tenant.userId,
        },
        orderBy: { acceptedAt: 'desc' },
      }),
      prisma.message.count({
        where: {
          senderUserId: tenant.userId,
          conversation: { organizationId: tenant.organizationId },
        },
      }),
      prisma.conversationEvent.findMany({
        where: {
          actorUserId: tenant.userId,
          conversation: { organizationId: tenant.organizationId },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true,
          conversationId: true,
          eventType: true,
          createdAt: true,
        },
      }),
    ]);

    return {
      exportedAt: new Date().toISOString(),
      legalBasis: 'LGPD — Lei nº 13.709/2018 (Art. 18, incisos I, II e V)',
      organizationId: tenant.organizationId,
      subjectType: LgpdSubjectType.USER,
      data: {
        profile: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          availability: user.availability,
          avatarUrl: user.avatarUrl,
          isActive: user.isActive,
          lastSeenAt: user.lastSeenAt,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
          organization: user.organization,
          departments: user.departments.map((d) => d.department),
        },
        lgpdConsents: consents,
        activitySummary: {
          sentMessagesCount,
          recentEvents,
        },
      },
    };
  },

  /**
   * Anonimização irreversível de dados pessoais (Art. 18, incisos IV e VI da LGPD).
   * Preserva integridade referencial para métricas e auditoria sem manter PII.
   */
  async anonymize(
    tenant: TenantContext,
    input: AnonymizeInput,
    meta: RequestAuditMeta
  ) {
    const now = new Date();
    const anonSuffix = crypto.randomBytes(6).toString('hex');

    if (input.target === 'self') {
      const user = await prisma.user.findFirst({
        where: {
          id: tenant.userId,
          organizationId: tenant.organizationId,
          isActive: true,
        },
        select: {
          id: true,
          passwordHash: true,
          avatarBucket: true,
          avatarPath: true,
        },
      });

      if (!user) {
        throw new AppError(404, 'USER_NOT_FOUND', 'Usuário ativo não encontrado nesta organização.');
      }

      const validPassword = await bcrypt.compare(input.currentPassword, user.passwordHash);
      if (!validPassword) {
        throw new AppError(401, 'INVALID_PASSWORD', 'Senha atual incorreta.');
      }

      if (user.avatarBucket && user.avatarPath) {
        try {
          await storageService.removeObject(user.avatarBucket, user.avatarPath);
        } catch (err) {
          console.warn('[LGPD] Não foi possível remover avatar do Supabase Storage:', err);
        }
      }

      await prisma.$transaction(async (tx) => {
        await tx.user.updateMany({
          where: {
            id: tenant.userId,
            organizationId: tenant.organizationId,
          },
          data: {
            name: 'Usuário Anonimizado',
            email: `anon-${anonSuffix}@anonymized.lgpd.local`,
            passwordHash: `!ANONYMIZED_${crypto.randomBytes(16).toString('hex')}!`,
            avatarBucket: null,
            avatarPath: null,
            avatarUrl: null,
            availability: AgentAvailability.OFFLINE,
            isActive: false,
          },
        });

        await tx.passwordReset.deleteMany({ where: { userId: tenant.userId } });
        await tx.departmentUser.deleteMany({ where: { userId: tenant.userId } });

        await tx.lgpdConsent.create({
          data: {
            organizationId: tenant.organizationId,
            subjectType: LgpdSubjectType.USER,
            subjectId: tenant.userId,
            termVersion: 'anonymization-art18',
            acceptedRequired: false,
            acceptedMarketing: false,
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
            revokedAt: now,
          },
        });
      });

      return {
        anonymized: true,
        target: 'self' as const,
        subjectId: tenant.userId,
        anonymizedAt: now.toISOString(),
        message: 'Seus dados pessoais foram anonimizados irreversivelmente conforme o Art. 18 da LGPD.',
      };
    }

    // Anonimização de contato (apenas ADMIN ou SUPERVISOR da mesma organização)
    assertManagerRole(tenant);

    const contact = await prisma.contact.findFirst({
      where: {
        id: input.contactId,
        organizationId: tenant.organizationId,
      },
      include: {
        identities: { select: { id: true } },
      },
    });

    if (!contact) {
      throw new AppError(404, 'CONTACT_NOT_FOUND', 'Contato não encontrado nesta organização.');
    }

    if (contact.avatarBucket && contact.avatarPath) {
      try {
        await storageService.removeObject(contact.avatarBucket, contact.avatarPath);
      } catch (err) {
        console.warn('[LGPD] Não foi possível remover avatar do contato no Supabase Storage:', err);
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.contact.updateMany({
        where: {
          id: contact.id,
          organizationId: tenant.organizationId,
        },
        data: {
          name: 'Contato Anonimizado',
          company: null,
          roleTitle: null,
          phoneE164: null,
          email: null,
          avatarBucket: null,
          avatarPath: null,
          avatarUrl: null,
          customAttributes: {},
        },
      });

      for (const identity of contact.identities) {
        const hashedExternal = crypto
          .createHash('sha256')
          .update(`${identity.id}:${anonSuffix}`)
          .digest('hex');

        await tx.contactIdentity.update({
          where: { id: identity.id },
          data: {
            externalContactId: `anon:${hashedExternal.slice(0, 32)}`,
            metadata: {},
          },
        });
      }

      // Remove o nome pessoal do remetente nas mensagens recebidas desse contato
      await tx.message.updateMany({
        where: {
          direction: MessageDirection.INCOMING,
          conversation: {
            organizationId: tenant.organizationId,
            contactId: contact.id,
          },
        },
        data: {
          senderName: 'Contato Anonimizado',
        },
      });

      await tx.lgpdConsent.create({
        data: {
          organizationId: tenant.organizationId,
          subjectType: LgpdSubjectType.CONTACT,
          subjectId: contact.id,
          termVersion: 'anonymization-art18',
          acceptedRequired: false,
          acceptedMarketing: false,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          revokedAt: now,
        },
      });
    });

    return {
      anonymized: true,
      target: 'contact' as const,
      subjectId: contact.id,
      anonymizedAt: now.toISOString(),
      message: 'Dados pessoais do contato anonimizados irreversivelmente conforme o Art. 18 da LGPD.',
    };
  },
};
