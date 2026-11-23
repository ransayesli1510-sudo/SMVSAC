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
 * Converte um JID do WhatsApp (ex.: 5584987219800:12@s.whatsapp.net) em telefone legível (+55 84 98721-9800).
 */
export function formatPhoneFromJid(jid: string | null | undefined): string {
  if (!jid) return '';
  const base = jid.split('@')[0]?.split(':')[0] ?? '';
  const digits = base.replace(/\D/g, '');
  if (!digits) return base;

  // Formatação brasileira (+55 DD 9XXXX-XXXX ou +55 DD XXXX-XXXX)
  if (digits.startsWith('55') && digits.length === 13) {
    return `+55 (${digits.slice(2, 4)}) ${digits.slice(4, 9)}-${digits.slice(9)}`;
  }
  if (digits.startsWith('55') && digits.length === 12) {
    return `+55 (${digits.slice(2, 4)}) ${digits.slice(4, 8)}-${digits.slice(8)}`;
  }
  return `+${digits}`;
}

export function extractDigitsFromJid(jid: string | null | undefined): string | null {
  if (!jid || jid.endsWith('@g.us')) return null;
  const base = jid.split('@')[0]?.split(':')[0] ?? '';
  const digits = base.replace(/\D/g, '');
  return digits ? `+${digits}` : null;
}

export function getInitials(name: string | null | undefined): string {
  const clean = (name ?? '').trim();
  if (!clean) return 'CT';
  const parts = clean.split(/\s+/);
  const first = parts[0]?.[0] ?? 'C';
  const second = parts[1]?.[0] ?? parts[0]?.[1] ?? 'T';
  return `${first}${second}`.toUpperCase();
}
