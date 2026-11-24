/**
 * Formata o protocolo padrão SMV Sac: Chamado #AAAAMMDD-NNN (ex.: Chamado #20261123-001)
 */
export function formatTicketNumber(createdAt: Date, protocolNumber: number): string {
  const y = createdAt.getFullYear();
  const m = String(createdAt.getMonth() + 1).padStart(2, '0');
  const d = String(createdAt.getDate()).padStart(2, '0');
  return `Chamado #${y}${m}${d}-${String(protocolNumber).padStart(3, '0')}`;
}

/**
 * Retorna true se o JID for um identificador interno LID do WhatsApp (@lid),
 * que NÃO representa um número de telefone real.
 */
export function isLidJid(jid: string | null | undefined): boolean {
  return Boolean(jid && jid.toLowerCase().endsWith('@lid'));
}

/**
 * Retorna true se o JID for de grupo do WhatsApp (@g.us).
 */
export function isGroupJid(jid: string | null | undefined): boolean {
  return Boolean(jid && jid.toLowerCase().endsWith('@g.us'));
}

/**
 * Retorna true se o telefone/string parecer um falso número de 15 dígitos iniciado em +1
 * (gerado por identidades antigas @lid do WhatsApp).
 */
export function isSuspiciousLidPhone(value: string | null | undefined): boolean {
  if (!value) return false;
  const digits = value.replace(/\D/g, '');
  return digits.length === 15 && digits.startsWith('1');
}

/**
 * Converte um JID telefônico do WhatsApp (ex.: 5584987219800:12@s.whatsapp.net)
 * em telefone legível (+55 (84) 98721-9800).
 * Nunca formata @lid, @g.us ou números falsos de 15 dígitos iniciados em 1.
 */
export function formatPhoneFromJid(jid: string | null | undefined): string {
  if (!jid || isLidJid(jid) || isGroupJid(jid)) return '';
  const base = jid.split('@')[0]?.split(':')[0] ?? '';
  const digits = base.replace(/\D/g, '');
  if (!digits || digits.length < 8 || digits.length > 15) return '';
  if (digits.length === 15 && digits.startsWith('1')) return '';

  // Formatação brasileira (+55 (DD) 9XXXX-XXXX ou +55 (DD) XXXX-XXXX)
  if (digits.startsWith('55') && digits.length === 13) {
    return `+55 (${digits.slice(2, 4)}) ${digits.slice(4, 9)}-${digits.slice(9)}`;
  }
  if (digits.startsWith('55') && digits.length === 12) {
    return `+55 (${digits.slice(2, 4)}) ${digits.slice(4, 8)}-${digits.slice(8)}`;
  }
  return `+${digits}`;
}

export function extractDigitsFromJid(jid: string | null | undefined): string | null {
  if (!jid || isGroupJid(jid) || isLidJid(jid)) return null;
  const base = jid.split('@')[0]?.split(':')[0] ?? '';
  const digits = base.replace(/\D/g, '');
  if (!digits || digits.length < 8 || digits.length > 15) return null;
  if (digits.length === 15 && digits.startsWith('1')) return null;
  return `+${digits}`;
}

export function getInitials(name: string | null | undefined): string {
  const clean = (name ?? '').trim();
  if (!clean) return 'CT';
  const parts = clean.split(/\s+/);
  const first = parts[0]?.[0] ?? 'C';
  const second = parts[1]?.[0] ?? parts[0]?.[1] ?? 'T';
  return `${first}${second}`.toUpperCase();
}
