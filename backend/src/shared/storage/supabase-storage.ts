import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import crypto from 'node:crypto';
import path from 'node:path';
import { env } from '../../config/env.js';

if (!globalThis.WebSocket) {
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = WebSocket;
}

export const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
  realtime: {
    transport: WebSocket as unknown as typeof globalThis.WebSocket,
  },
});

export interface UploadAttachmentParams {
  organizationId: string;
  conversationId: string;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}

export interface UploadResult {
  bucket: string;
  storagePath: string;
  publicUrl: string | null;
}

export const storageService = {
  /**
   * Faz upload de um anexo de mensagem para o bucket privado/público no Supabase Storage.
   * Caminho padronizado por tenant: {organizationId}/{conversationId}/{uuid}{ext}
   */
  async uploadAttachment(params: UploadAttachmentParams): Promise<UploadResult> {
    const ext = path.extname(params.fileName) || '';
    const storagePath = `${params.organizationId}/${params.conversationId}/${crypto.randomUUID()}${ext}`;
    const bucket = env.SUPABASE_STORAGE_BUCKET_ATTACHMENTS;

    const { error } = await supabaseAdmin.storage.from(bucket).upload(storagePath, params.buffer, {
      contentType: params.mimeType,
      upsert: false,
    });

    if (error) {
      throw new Error(`Falha ao enviar anexo ao Supabase Storage: ${error.message}`);
    }

    return {
      bucket,
      storagePath,
      publicUrl: null, // Recomenda-se bucket privado + URL assinada temporária
    };
  },

  /**
   * Faz upload de avatar (usuário ou contato) para o bucket de avatares.
   */
  async uploadAvatar(params: {
    organizationId: string;
    entityType: 'users' | 'contacts';
    entityId: string;
    fileName: string;
    mimeType: string;
    buffer: Buffer;
  }): Promise<UploadResult> {
    const ext = path.extname(params.fileName) || '.png';
    const storagePath = `${params.organizationId}/${params.entityType}/${params.entityId}${ext}`;
    const bucket = env.SUPABASE_STORAGE_BUCKET_AVATARS;

    const { error } = await supabaseAdmin.storage.from(bucket).upload(storagePath, params.buffer, {
      contentType: params.mimeType,
      upsert: true,
    });

    if (error) {
      throw new Error(`Falha ao enviar avatar ao Supabase Storage: ${error.message}`);
    }

    const { data } = supabaseAdmin.storage.from(bucket).getPublicUrl(storagePath);

    return {
      bucket,
      storagePath,
      publicUrl: data.publicUrl,
    };
  },

  /**
   * Gera URL assinada temporária (ideal para anexos privados e conformidade LGPD).
   */
  async getSignedUrl(bucket: string, storagePath: string, expiresInSeconds = 3600): Promise<string> {
    const { data, error } = await supabaseAdmin.storage
      .from(bucket)
      .createSignedUrl(storagePath, expiresInSeconds);

    if (error || !data?.signedUrl) {
      throw new Error(`Falha ao gerar Signed URL no Supabase Storage: ${error?.message ?? 'desconhecido'}`);
    }

    return data.signedUrl;
  },

  async removeObject(bucket: string, storagePath: string): Promise<void> {
    const { error } = await supabaseAdmin.storage.from(bucket).remove([storagePath]);
    if (error) {
      throw new Error(`Falha ao remover arquivo no Supabase Storage: ${error.message}`);
    }
  },
};
