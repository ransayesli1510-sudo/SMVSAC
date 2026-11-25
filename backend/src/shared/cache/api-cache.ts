/**
 * Cache em memória multi-tenant (TTL curto + invalidação por eventos/mutações)
 * para responder GET /conversations, GET /messages e GET /contacts em <50ms.
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface CachedOrgContact {
  id: string;
  name: string;
  initials: string;
  role: string;
  phone: string;
  phoneE164: string | null;
  email: string;
  avatarUrl: string | null;
  connection: string;
  connectionId: string | null;
  department: string;
  conversationId: string | null;
  // Campos pré-normalizados para busca instantânea em memória (<2ms)
  _nameLower: string;
  _phoneDigits: string;
  _phoneNoDdi: string;
  _emailLower: string;
}

const DEFAULT_TTL_MS = 30_000; // 30 segundos (invalidado imediatamente em qualquer mutação/evento)
const CONTACTS_TTL_MS = 60_000; // 60 segundos para o índice da agenda em memória
const MAX_ENTRIES = 500;

class ApiMemoryCache {
  private readonly conversationsList = new Map<string, CacheEntry<unknown[]>>();
  private readonly conversationMessages = new Map<string, CacheEntry<unknown[]>>();
  private readonly orgContacts = new Map<string, CacheEntry<CachedOrgContact[]>>();

  private buildConvKey(
    organizationId: string,
    params: { tab: string; status: string; sort: string; q?: string; userId?: string; connectedKey?: string }
  ): string {
    const scopeUser = params.tab === 'mine' ? params.userId ?? '' : '';
    return `${organizationId}|${params.tab}|${params.status}|${params.sort}|${(params.q ?? '').toLowerCase()}|${scopeUser}|${params.connectedKey ?? ''}`;
  }

  private buildMsgKey(organizationId: string, conversationId: string): string {
    return `${organizationId}:${conversationId}`;
  }

  getConversations<T = unknown>(
    organizationId: string,
    params: { tab: string; status: string; sort: string; q?: string; userId?: string; connectedKey?: string }
  ): T[] | null {
    const key = this.buildConvKey(organizationId, params);
    const entry = this.conversationsList.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.conversationsList.delete(key);
      return null;
    }
    return entry.value as T[];
  }

  setConversations<T = unknown>(
    organizationId: string,
    params: { tab: string; status: string; sort: string; q?: string; userId?: string; connectedKey?: string },
    value: T[],
    ttlMs = DEFAULT_TTL_MS
  ): void {
    if (this.conversationsList.size >= MAX_ENTRIES) {
      this.conversationsList.clear();
    }
    const key = this.buildConvKey(organizationId, params);
    this.conversationsList.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  invalidateOrgConversations(organizationId: string): void {
    const prefix = `${organizationId}|`;
    for (const key of this.conversationsList.keys()) {
      if (key.startsWith(prefix)) {
        this.conversationsList.delete(key);
      }
    }
  }

  invalidateOrgMessages(organizationId: string): void {
    const prefix = `${organizationId}:`;
    for (const key of this.conversationMessages.keys()) {
      if (key.startsWith(prefix)) {
        this.conversationMessages.delete(key);
      }
    }
  }

  getOrgContacts(organizationId: string): CachedOrgContact[] | null {
    const entry = this.orgContacts.get(organizationId);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.orgContacts.delete(organizationId);
      return null;
    }
    return entry.value;
  }

  setOrgContacts(
    organizationId: string,
    contacts: CachedOrgContact[],
    ttlMs = CONTACTS_TTL_MS
  ): void {
    if (this.orgContacts.size >= 100) {
      this.orgContacts.clear();
    }
    this.orgContacts.set(organizationId, { value: contacts, expiresAt: Date.now() + ttlMs });
  }

  invalidateOrgContacts(organizationId: string): void {
    this.orgContacts.delete(organizationId);
  }

  patchContactAvatar(organizationId: string, contactId: string, avatarUrl: string): void {
    const prefix = `${organizationId}|`;
    for (const [key, entry] of this.conversationsList.entries()) {
      if (!key.startsWith(prefix)) continue;
      if (Array.isArray(entry.value)) {
        for (const item of entry.value as Array<{ contact?: { id?: string; avatarUrl?: string | null } }>) {
          if (item?.contact?.id === contactId) {
            item.contact.avatarUrl = avatarUrl;
          }
        }
      }
    }

    const contactsEntry = this.orgContacts.get(organizationId);
    if (contactsEntry) {
      for (const c of contactsEntry.value) {
        if (c.id === contactId) {
          c.avatarUrl = avatarUrl;
        }
      }
    }
  }

  getMessages<T = unknown>(organizationId: string, conversationId: string): T[] | null {
    const key = this.buildMsgKey(organizationId, conversationId);
    const entry = this.conversationMessages.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.conversationMessages.delete(key);
      return null;
    }
    return entry.value as T[];
  }

  setMessages<T = unknown>(
    organizationId: string,
    conversationId: string,
    value: T[],
    ttlMs = DEFAULT_TTL_MS
  ): void {
    if (this.conversationMessages.size >= MAX_ENTRIES) {
      this.conversationMessages.clear();
    }
    const key = this.buildMsgKey(organizationId, conversationId);
    this.conversationMessages.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  invalidateConversationMessages(organizationId: string, conversationId: string): void {
    this.conversationMessages.delete(this.buildMsgKey(organizationId, conversationId));
  }

  invalidateOrgAll(organizationId: string): void {
    this.invalidateOrgConversations(organizationId);
    this.invalidateOrgContacts(organizationId);
    const msgPrefix = `${organizationId}:`;
    for (const key of this.conversationMessages.keys()) {
      if (key.startsWith(msgPrefix)) {
        this.conversationMessages.delete(key);
      }
    }
  }
}

export const apiCache = new ApiMemoryCache();
