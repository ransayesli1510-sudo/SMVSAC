import fs from 'node:fs/promises';
import path from 'node:path';
import {
  BufferJSON,
  initAuthCreds,
  proto,
  useMultiFileAuthState,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';

import { env } from '../../config/env.js';
import { prisma } from '../../shared/database/prisma.js';
import { decryptSecret, encryptSecret } from '../../shared/crypto/encryption.js';

interface PersistedAuthPayload {
  version: 1;
  creds: AuthenticationCreds;
  keys: Record<string, Record<string, unknown>>;
}

export interface ManagedBaileysAuthState {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  clearState: () => Promise<void>;
  flush: () => Promise<void>;
}

const KEY_FLUSH_DEBOUNCE_MS = 250;

/**
 * Importa uma sessão legada em disco (.baileys_sessions/<connectionId>) caso exista
 * e o banco ainda não possua credentialsEncrypted, preservando sessões já pareadas.
 */
async function tryImportLegacyFileSession(
  legacyDir: string
): Promise<PersistedAuthPayload | null> {
  try {
    const credsPath = path.join(legacyDir, 'creds.json');
    const credsRaw = await fs.readFile(credsPath, 'utf8');
    const creds = JSON.parse(credsRaw, BufferJSON.reviver) as AuthenticationCreds;
    const keys: Record<string, Record<string, unknown>> = {};

    const files = await fs.readdir(legacyDir);
    for (const file of files) {
      if (!file.endsWith('.json') || file === 'creds.json') continue;
      // Formato padrão do useMultiFileAuthState: `${type}-${id}.json`
      const knownTypes: Array<keyof SignalDataTypeMap> = [
        'app-state-sync-version',
        'app-state-sync-key',
        'sender-key-memory',
        'identity-key',
        'device-list',
        'lid-mapping',
        'sender-key',
        'pre-key',
        'session',
        'tctoken',
      ];
      const matchedType = knownTypes.find((t) => file.startsWith(`${t}-`));
      if (!matchedType) continue;

      const rawId = file.slice(matchedType.length + 1, -'.json'.length);
      const id = rawId.replace(/__/g, '/').replace(/-colon-/g, ':');
      try {
        const content = await fs.readFile(path.join(legacyDir, file), 'utf8');
        const parsed = JSON.parse(content, BufferJSON.reviver);
        if (!keys[matchedType]) keys[matchedType] = {};
        keys[matchedType][id] = parsed;
      } catch {
        // Ignora arquivo corrompido individual
      }
    }

    return { version: 1, creds, keys };
  } catch {
    return null;
  }
}

/**
 * Adapter de AuthState do Baileys persistido no PostgreSQL/Supabase (connections.credentials_encrypted),
 * criptografado com AES-256-GCM via CREDENTIALS_ENCRYPTION_KEY.
 * Permite reiniciar/redeployar o back-end na nuvem sem desconectar nem exigir novo QR Code.
 */
export async function useDatabaseAuthState(params: {
  connectionId: string;
  organizationId: string;
  legacySessionDir?: string;
}): Promise<ManagedBaileysAuthState> {
  const { connectionId, organizationId, legacySessionDir } = params;

  // Fallback opcional para disco somente quando explicitamente configurado via env
  if (env.BAILEYS_AUTH_STORAGE === 'file' && legacySessionDir) {
    await fs.mkdir(legacySessionDir, { recursive: true });
    const fileAuth = await useMultiFileAuthState(legacySessionDir);
    return {
      state: fileAuth.state,
      saveCreds: fileAuth.saveCreds,
      flush: fileAuth.saveCreds,
      clearState: async () => {
        await fs.rm(legacySessionDir, { recursive: true, force: true }).catch(() => {});
      },
    };
  }

  // 1. Carrega estado criptografado do PostgreSQL (Supabase)
  const conn = await prisma.connection.findFirst({
    where: { id: connectionId, organizationId },
    select: { credentialsEncrypted: true },
  });

  let payload: PersistedAuthPayload | null = null;
  let importedFromDisk = false;

  if (conn?.credentialsEncrypted) {
    try {
      const decrypted = decryptSecret(conn.credentialsEncrypted);
      const parsed = JSON.parse(decrypted, BufferJSON.reviver) as Partial<PersistedAuthPayload>;
      if (parsed && parsed.creds) {
        payload = {
          version: 1,
          creds: parsed.creds,
          keys: parsed.keys && typeof parsed.keys === 'object' ? parsed.keys : {},
        };
      }
    } catch (err) {
      console.warn(
        `[WhatsApp AuthState] Não foi possível descriptografar sessão anterior da conexão ${connectionId}, iniciando nova:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  // 2. Migração transparente de sessão local legada (se existir) para o banco
  if (!payload && legacySessionDir) {
    const legacy = await tryImportLegacyFileSession(legacySessionDir);
    if (legacy) {
      payload = legacy;
      importedFromDisk = true;
    }
  }

  if (!payload) {
    payload = {
      version: 1,
      creds: initAuthCreds(),
      keys: {},
    };
  }

  let flushTimer: NodeJS.Timeout | null = null;
  let writeChain: Promise<void> = Promise.resolve();
  let cleared = false;

  const persistNow = (): Promise<void> => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    writeChain = writeChain
      .then(async () => {
        if (cleared) return;
        const serialized = JSON.stringify(payload, BufferJSON.replacer);
        const encrypted = encryptSecret(serialized);
        await prisma.connection.updateMany({
          where: { id: connectionId, organizationId },
          data: { credentialsEncrypted: encrypted },
        });
      })
      .catch((err) => {
        console.error(
          `[WhatsApp AuthState] Falha ao persistir sessão criptografada da conexão ${connectionId}:`,
          err
        );
      });

    return writeChain;
  };

  const schedulePersist = (): void => {
    if (cleared || flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void persistNow();
    }, KEY_FLUSH_DEBOUNCE_MS);
  };

  if (importedFromDisk) {
    await persistNow();
  }

  const state: AuthenticationState = {
    creds: payload.creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(
        type: T,
        ids: string[]
      ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
        const result: { [id: string]: SignalDataTypeMap[T] } = {};
        const bucket = payload!.keys[type];
        if (!bucket) return result;

        for (const id of ids) {
          let value = bucket[id];
          if (value === undefined || value === null) continue;
          if (type === 'app-state-sync-key' && typeof value === 'object') {
            value = proto.Message.AppStateSyncKeyData.fromObject(
              value as Record<string, unknown>
            );
          }
          result[id] = value as SignalDataTypeMap[T];
        }
        return result;
      },

      set: async (data: SignalDataSet): Promise<void> => {
        let changed = false;
        for (const category of Object.keys(data) as Array<keyof SignalDataTypeMap>) {
          const entries = data[category];
          if (!entries) continue;

          if (!payload!.keys[category]) {
            payload!.keys[category] = {};
          }
          const bucket = payload!.keys[category]!;

          for (const [id, value] of Object.entries(entries)) {
            if (value === null || value === undefined) {
              if (id in bucket) {
                delete bucket[id];
                changed = true;
              }
            } else {
              bucket[id] = value;
              changed = true;
            }
          }
        }

        if (changed) {
          schedulePersist();
        }
      },

      clear: async (): Promise<void> => {
        payload!.keys = {};
        await persistNow();
      },
    },
  };

  const saveCreds = async (): Promise<void> => {
    payload!.creds = state.creds;
    await persistNow();
  };

  const clearState = async (): Promise<void> => {
    cleared = true;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    payload!.keys = {};
    await writeChain.catch(() => {});
    await prisma.connection.updateMany({
      where: { id: connectionId, organizationId },
      data: { credentialsEncrypted: null },
    });
    if (legacySessionDir) {
      await fs.rm(legacySessionDir, { recursive: true, force: true }).catch(() => {});
    }
  };

  return {
    state,
    saveCreds,
    clearState,
    flush: persistNow,
  };
}
