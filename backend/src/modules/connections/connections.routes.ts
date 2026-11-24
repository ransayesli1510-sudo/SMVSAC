import type { FastifyInstance } from 'fastify';
import { ChannelType, ConnectionProvider, ConnectionStatus } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../../shared/database/prisma.js';
import { authenticate, getTenantContext } from '../../shared/http/authenticate.js';
import { AppError } from '../../shared/http/errors.js';
import { whatsappManager } from '../whatsapp/whatsapp.manager.js';

const createConnectionSchema = z.object({
  name: z.string().trim().min(2, 'Informe o nome da conexão.').max(120),
  channel: z.enum(['WHATSAPP', 'WEBCHAT', 'INSTAGRAM']).default('WHATSAPP'),
  provider: z.enum(['BAILEYS', 'META_CLOUD', 'EVOLUTION', 'WIDGET']).optional(),
  identifier: z.string().trim().max(120).optional(),
  departmentId: z.string().uuid().optional().nullable(),
  departmentName: z.string().trim().optional(),
  autoStartQr: z.boolean().optional().default(true),
});

const updateConnectionSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  identifier: z.string().trim().max(120).optional(),
  departmentId: z.string().uuid().optional().nullable(),
  departmentName: z.string().trim().optional(),
});

const updateStatusSchema = z.object({
  action: z.enum(['archive', 'activate', 'pause', 'resume', 'disconnect', 'reconnect']),
});

function formatChannelLabel(channel: ChannelType): string {
  if (channel === ChannelType.WHATSAPP) return 'WhatsApp';
  if (channel === ChannelType.WEBCHAT) return 'WebChat';
  return 'Instagram';
}

export async function connectionsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/v1/connections
  app.get('/', async (request, reply) => {
    const tenant = getTenantContext(request);

    const rows = await prisma.connection.findMany({
      where: { organizationId: tenant.organizationId },
      include: {
        defaultDepartment: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const connections = rows.map((c) => {
      const runtime =
        c.channel === ChannelType.WHATSAPP && c.provider === ConnectionProvider.BAILEYS
          ? whatsappManager.getSnapshot(c.id)
          : null;

      let sessionState: 'connected' | 'paused' | 'disconnected' | 'qr' | 'connecting' = 'connected';
      if (c.status === ConnectionStatus.ARCHIVED || c.status === ConnectionStatus.DISCONNECTED) {
        sessionState = 'disconnected';
      }
      if (runtime) {
        if (runtime.status === 'CONNECTED') sessionState = 'connected';
        else if (runtime.status === 'PAUSED') sessionState = 'paused';
        else if (runtime.status === 'QR_PENDING') sessionState = 'qr';
        else if (runtime.status === 'CONNECTING') sessionState = 'connecting';
        else sessionState = 'disconnected';
      }

      return {
        id: c.id,
        name: c.name,
        channel: formatChannelLabel(c.channel),
        channelCode: c.channel,
        provider: c.provider,
        identifier: runtime?.identifier || c.identifier,
        bot: '-',
        departmentId: c.defaultDepartmentId,
        department: c.defaultDepartment?.name ?? 'Suporte',
        status: c.status === ConnectionStatus.ARCHIVED ? 'archived' : 'active',
        dbStatus: c.status,
        sessionState,
        qrDataUrl: runtime?.qrDataUrl ?? null,
        createdAt: c.createdAt.toISOString(),
      };
    });

    return reply.send({ connections });
  });

  // POST /api/v1/connections — cria conexão (se WhatsApp + Baileys, inicia geração real de QR Code!)
  app.post('/', async (request, reply) => {
    const tenant = getTenantContext(request);
    const input = createConnectionSchema.parse(request.body);

    let departmentId = input.departmentId ?? null;
    if (!departmentId && input.departmentName) {
      const dept = await prisma.department.findFirst({
        where: { organizationId: tenant.organizationId, name: input.departmentName },
        select: { id: true },
      });
      departmentId = dept?.id ?? null;
    }

    const provider =
      input.provider ??
      (input.channel === 'WHATSAPP'
        ? ConnectionProvider.BAILEYS
        : input.channel === 'WEBCHAT'
          ? ConnectionProvider.WIDGET
          : ConnectionProvider.META_CLOUD);

    const created = await prisma.connection.create({
      data: {
        organizationId: tenant.organizationId,
        name: input.name,
        channel: input.channel as ChannelType,
        provider,
        identifier:
          input.identifier?.trim() ||
          (input.channel === 'WHATSAPP' ? 'Aguardando leitura do QR Code' : '-'),
        defaultDepartmentId: departmentId,
        status:
          input.channel === 'WHATSAPP' && provider === ConnectionProvider.BAILEYS
            ? ConnectionStatus.DISCONNECTED
            : ConnectionStatus.ACTIVE,
      },
      include: {
        defaultDepartment: { select: { id: true, name: true } },
      },
    });

    if (
      created.channel === ChannelType.WHATSAPP &&
      created.provider === ConnectionProvider.BAILEYS &&
      input.autoStartQr
    ) {
      // Dispara pareamento Baileys imediatamente (emite `whatsapp:qr` via Socket.IO)
      void whatsappManager.startSession(created.id, tenant.organizationId);
    }

    const runtime = whatsappManager.getSnapshot(created.id);

    return reply.status(201).send({
      connection: {
        id: created.id,
        name: created.name,
        channel: formatChannelLabel(created.channel),
        channelCode: created.channel,
        provider: created.provider,
        identifier: created.identifier,
        bot: '-',
        departmentId: created.defaultDepartmentId,
        department: created.defaultDepartment?.name ?? 'Suporte',
        status: 'active',
        sessionState:
          created.channel === ChannelType.WHATSAPP && created.provider === ConnectionProvider.BAILEYS
            ? runtime.status === 'QR_PENDING'
              ? 'qr'
              : 'connecting'
            : 'connected',
        qrDataUrl: runtime.qrDataUrl,
      },
    });
  });

  // POST /api/v1/connections/:id/whatsapp/connect — inicia/gera QR Code para uma conexão WhatsApp
  app.post('/:id/whatsapp/connect', async (request, reply) => {
    const tenant = getTenantContext(request);
    const { id } = request.params as { id: string };

    const conn = await prisma.connection.findFirst({
      where: { id, organizationId: tenant.organizationId, channel: ChannelType.WHATSAPP },
    });

    if (!conn) {
      throw new AppError(404, 'CONNECTION_NOT_FOUND', 'Conexão WhatsApp não encontrada.');
    }

    if (conn.provider !== ConnectionProvider.BAILEYS) {
      await prisma.connection.update({
        where: { id: conn.id },
        data: { provider: ConnectionProvider.BAILEYS },
      });
    }

    await whatsappManager.startSession(conn.id, tenant.organizationId);
    const snapshot = whatsappManager.getSnapshot(conn.id);

    return reply.send({
      connectionId: conn.id,
      ...snapshot,
    });
  });

  // GET /api/v1/connections/:id/whatsapp/qr — consulta estado atual e QR Code (fallback de polling)
  app.get('/:id/whatsapp/qr', async (request, reply) => {
    const tenant = getTenantContext(request);
    const { id } = request.params as { id: string };

    // Fast-path em memória: evita ida ao Supabase durante polling de QR Code
    const snapshot = whatsappManager.getSnapshot(id);
    if (snapshot.organizationId === tenant.organizationId) {
      return reply.send({
        connectionId: id,
        status: snapshot.status,
        qrDataUrl: snapshot.qrDataUrl,
        identifier: snapshot.identifier,
      });
    }

    const conn = await prisma.connection.findFirst({
      where: { id, organizationId: tenant.organizationId },
      select: { id: true, identifier: true, status: true },
    });

    if (!conn) {
      throw new AppError(404, 'CONNECTION_NOT_FOUND', 'Conexão não encontrada.');
    }

    return reply.send({
      connectionId: conn.id,
      status: snapshot.status,
      qrDataUrl: snapshot.qrDataUrl,
      identifier: snapshot.identifier || conn.identifier,
    });
  });

  // PATCH /api/v1/connections/:id — editar nome, identificador ou departamento
  app.patch('/:id', async (request, reply) => {
    const tenant = getTenantContext(request);
    const { id } = request.params as { id: string };
    const input = updateConnectionSchema.parse(request.body);

    const existing = await prisma.connection.findFirst({
      where: { id, organizationId: tenant.organizationId },
    });
    if (!existing) {
      throw new AppError(404, 'CONNECTION_NOT_FOUND', 'Conexão não encontrada.');
    }

    let departmentId = input.departmentId;
    if (departmentId === undefined && input.departmentName) {
      const dept = await prisma.department.findFirst({
        where: { organizationId: tenant.organizationId, name: input.departmentName },
        select: { id: true },
      });
      departmentId = dept?.id ?? null;
    }

    const updated = await prisma.connection.update({
      where: { id: existing.id },
      data: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.identifier !== undefined ? { identifier: input.identifier } : {}),
        ...(departmentId !== undefined ? { defaultDepartmentId: departmentId } : {}),
      },
      include: { defaultDepartment: { select: { id: true, name: true } } },
    });

    return reply.send({
      connection: {
        id: updated.id,
        name: updated.name,
        channel: formatChannelLabel(updated.channel),
        identifier: updated.identifier,
        department: updated.defaultDepartment?.name ?? 'Suporte',
      },
    });
  });

  // PATCH /api/v1/connections/:id/status — arquivar, reativar, pausar, retomar, desconectar, reconectar
  app.patch('/:id/status', async (request, reply) => {
    const tenant = getTenantContext(request);
    const { id } = request.params as { id: string };
    const { action } = updateStatusSchema.parse(request.body);

    const conn = await prisma.connection.findFirst({
      where: { id, organizationId: tenant.organizationId },
    });
    if (!conn) {
      throw new AppError(404, 'CONNECTION_NOT_FOUND', 'Conexão não encontrada.');
    }

    if (action === 'archive') {
      await whatsappManager.disconnectSession(conn.id, tenant.organizationId, false);
      await prisma.connection.update({
        where: { id: conn.id },
        data: { status: ConnectionStatus.ARCHIVED },
      });
    } else if (action === 'activate' || action === 'reconnect') {
      await prisma.connection.update({
        where: { id: conn.id },
        data: { status: ConnectionStatus.ACTIVE },
      });
      if (conn.channel === ChannelType.WHATSAPP && conn.provider === ConnectionProvider.BAILEYS) {
        void whatsappManager.startSession(conn.id, tenant.organizationId);
      }
    } else if (action === 'pause') {
      await whatsappManager.setPaused(conn.id, tenant.organizationId, true);
    } else if (action === 'resume') {
      await whatsappManager.setPaused(conn.id, tenant.organizationId, false);
    } else if (action === 'disconnect') {
      await whatsappManager.disconnectSession(conn.id, tenant.organizationId, true);
    }

    return reply.send({ ok: true, connectionId: conn.id, action });
  });

  // POST /api/v1/connections/:id/sync-contacts — força ressincronização da agenda do WhatsApp
  app.post('/:id/sync-contacts', async (request, reply) => {
    const tenant = getTenantContext(request);
    const { id } = request.params as { id: string };

    const conn = await prisma.connection.findFirst({
      where: { id, organizationId: tenant.organizationId },
      select: { id: true, name: true, channel: true, provider: true },
    });

    if (!conn) {
      throw new AppError(404, 'CONNECTION_NOT_FOUND', 'Conexão não encontrada.');
    }

    if (conn.channel !== ChannelType.WHATSAPP || conn.provider !== ConnectionProvider.BAILEYS) {
      throw new AppError(
        400,
        'SYNC_CONTACTS_UNSUPPORTED',
        'A sincronização de agenda está disponível apenas para conexões WhatsApp conectadas.'
      );
    }

    try {
      const result = await whatsappManager.syncContacts(conn.id, tenant.organizationId);
      return reply.send({
        ok: true,
        connectionId: conn.id,
        connectionName: conn.name,
        ...result,
        message: `${result.totalContacts} contato(s) sincronizado(s) na base.`,
      });
    } catch (err) {
      throw new AppError(
        409,
        'WHATSAPP_NOT_CONNECTED',
        err instanceof Error ? err.message : 'Conexão WhatsApp não está conectada.'
      );
    }
  });

  // POST /api/v1/connections/:id/restart
  app.post('/:id/restart', async (request, reply) => {
    const tenant = getTenantContext(request);
    const { id } = request.params as { id: string };

    const conn = await prisma.connection.findFirst({
      where: { id, organizationId: tenant.organizationId },
    });
    if (!conn) {
      throw new AppError(404, 'CONNECTION_NOT_FOUND', 'Conexão não encontrada.');
    }

    if (conn.channel === ChannelType.WHATSAPP && conn.provider === ConnectionProvider.BAILEYS) {
      await whatsappManager.restartSession(conn.id, tenant.organizationId);
    }

    return reply.send({ ok: true, connectionId: conn.id });
  });

  // DELETE /api/v1/connections/:id
  app.delete('/:id', async (request, reply) => {
    const tenant = getTenantContext(request);
    const { id } = request.params as { id: string };

    const conn = await prisma.connection.findFirst({
      where: { id, organizationId: tenant.organizationId },
      include: { _count: { select: { conversations: true } } },
    });
    if (!conn) {
      throw new AppError(404, 'CONNECTION_NOT_FOUND', 'Conexão não encontrada.');
    }

    await whatsappManager.disconnectSession(conn.id, tenant.organizationId, true);

    if (conn._count.conversations > 0) {
      // Preserva histórico de conversas vinculadas arquivando a conexão
      await prisma.connection.update({
        where: { id: conn.id },
        data: { status: ConnectionStatus.ARCHIVED },
      });
      return reply.send({
        deleted: false,
        archived: true,
        message: 'Conexão desconectada e arquivada para preservar o histórico de conversas.',
      });
    }

    await prisma.connection.delete({ where: { id: conn.id } });
    return reply.send({ deleted: true, connectionId: conn.id });
  });
}
