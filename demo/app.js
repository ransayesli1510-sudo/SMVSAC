/* ==========================================================================
   SMV SAC — LÓGICA INTERATIVA (ESTILO DIGISAC • PRETO & AMARELO)
   ========================================================================== */

(function () {
  const DATA = window.SMV_SAC_DATA;
  const API = window.SMV_API;

  // Garante usuários extras da rede no mesmo domínio para transferências
  const EXTRA_DOMAIN_AGENTS = [
    { id: 'ozaniele', name: 'Ozaniele' },
    { id: 'gabriel', name: 'Gabriel' },
  ];
  EXTRA_DOMAIN_AGENTS.forEach((ag) => {
    if (!DATA.agents.some((a) => a.id === ag.id)) DATA.agents.push(ag);
  });

  function formatDateCompact(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}${m}${d}`;
  }

  let ticketSequence = 0;
  function generateTicketNumber() {
    ticketSequence += 1;
    return `Chamado #${formatDateCompact()}-${String(ticketSequence).padStart(3, '0')}`;
  }

  const state = {
    authenticated: false,
    apiConnected: false,
    socketConnected: false,
    lgpdAccepted: false,
    pendingUser: null,
    waQrConnectionId: null,
    waQrPollTimer: null,
    waQrPollInFlight: false,
    fallbackPollTimer: null,
    currentUser: {
      id: null,
      name: 'Ransay',
      email: 'ransay@supermegavendas.com',
      roleCode: 'ADMIN',
      role: 'Administrador',
      subdomain: 'supermegavendas',
    },
    usersList: [],
    usersSearch: '',
    usersRoleFilter: 'all',
    usersDeptFilter: 'all',
    usersApprovalFilter: 'all',
    openUserMenuId: null,
    editingUserId: null,
    resetPwdUserId: null,
    approvingUserId: null,
    rejectingUserId: null,
    deletingUserId: null,
    theme: localStorage.getItem('smv_sac_theme') || 'dark',
    view: 'conversations', // conversations | connections | contacts | reports | ai
    tab: 'mine', // mine | queue | all
    statusFilter: 'open', // open | resolved | all
    convSort: 'last_message_desc', // last_message_desc | oldest_first | newest_first | longest_wait | shortest_wait
    convSidebarCollapsed: false,
    searchQuery: '',
    inChatSearch: '',
    contacts: [],
    contactsTotal: 0,
    contactSearchResults: [],
    contactSearchLoading: false,
    contactSearchReqSeq: 0,
    convSearchDebounceTimer: null,
    newConvResults: [],
    newConvLoading: false,
    newConvReqSeq: 0,
    newConvDebounceTimer: null,
    contactsTabDebounceTimer: null,
    selectedConvId: DATA.conversations[0].id,
    conversationPresences: {},
    privateMode: false,
    connTab: 'active', // active | archived
    connSubView: 'list', // list | add
    connSearch: '',
    connChannel: 'all',
    openConnMenuId: null,
    editingConnId: null,
    viewingConnId: null,
    deletingConnId: null,
    upgradingChannel: null,
    contactsFiltersOpen: false,
    contactsConnFilter: 'all',
    contactsDeptFilter: 'all',
    contactsLabelFilter: 'all',
    contactModalSource: 'conversations',
    notifFilter: 'all', // all | ticket | alert
    notifSoundEnabled: true,
    manualTab: 'start',
    emojiCat: 'faces',
    composerActionType: null,
    selectedQuickSticker: '🚀',
    notifications: [
      {
        id: 'ntf_1',
        category: 'ticket',
        title: 'Novo chamado na Fila',
        message: 'Mariana Albuquerque iniciou atendimento via WebChat (Vendas).',
        time: 'há 2 min',
        unread: true,
        convId: 4,
      },
      {
        id: 'ntf_2',
        category: 'ticket',
        title: 'Novo chamado na Fila',
        message: 'Thiago Ferreira solicitou 2ª via de fatura / PIX via WhatsApp (Financeiro).',
        time: 'há 8 min',
        unread: true,
        convId: 5,
      },
      {
        id: 'ntf_3',
        category: 'ticket',
        title: 'Nova mensagem recebida',
        message: 'SMV REMOTO - DÃO SILVEIRA: "Acessos liberados no Flow?"',
        time: 'há 18 min',
        unread: true,
        convId: 3,
      },
      {
        id: 'ntf_4',
        category: 'alert',
        title: 'Alerta de SLA na Fila',
        message: 'Há 2 chamados aguardando atribuição há mais de 10 minutos.',
        time: 'há 22 min',
        unread: true,
        viewTarget: 'conversations',
        tabTarget: 'queue',
      },
    ],
    connQuotas: {
      WhatsApp: 5,
      WebChat: 1,
      Telegram: 1,
      'WhatsApp Business API': 0,
      Instagram: 0,
      'Facebook Messenger': 0,
      Email: 0,
      SMS: 0,
      'Reclame Aqui': 0,
    },
    reportPeriod: '7d',
    agentStatusIndex: 0,
    conversations: JSON.parse(JSON.stringify(DATA.conversations)).map((c, idx) => {
      const base = Date.now();
      const createdOffsetsMin = [180, 120, 95, 25, 45];
      const msgOffsetsMin = [2, 13, 108, 9, 25];
      const waitOffsetsMin = [4, 15, 92, 19, 34];
      return {
        ...c,
        ticketNumber: c.ticketNumber || generateTicketNumber(),
        createdTs: base - (createdOffsetsMin[idx] ?? 60) * 60000,
        lastMessageTs: base - (msgOffsetsMin[idx] ?? 10) * 60000,
        waitMinutes: waitOffsetsMin[idx] ?? 15,
      };
    }),
    connections: JSON.parse(JSON.stringify(DATA.connections)).map((c) => ({
      ...c,
      sessionState: c.status === 'archived' ? 'disconnected' : 'connected',
      events: [
        {
          title: c.status === 'archived' ? 'Conexão arquivada' : 'Sessão conectada com sucesso',
          actor: 'Sistema SMV Sac',
          time: 'Hoje às 08:30',
          tone: c.status === 'archived' ? 'warning' : 'success',
        },
        {
          title: 'Webhook e sincronização verificados (200 OK)',
          actor: 'Sistema SMV Sac',
          time: 'Hoje às 08:29',
          tone: 'info',
        },
        {
          title: `Conexão ${c.channel} cadastrada no departamento ${c.department}`,
          actor: 'Ransay (Admin)',
          time: 'Ontem às 17:15',
          tone: 'info',
        },
      ],
    })),
  };

  const PRIMARY_ADMIN_EMAIL = 'ransay@supermegavendas.com';

  function normalizeUserProfile(rawRole, email = '') {
    const cleanEmail = String(email || '').trim().toLowerCase();
    const upper = String(rawRole || '').trim().toUpperCase();
    const isAdmin =
      cleanEmail === PRIMARY_ADMIN_EMAIL ||
      upper === 'ADMIN' ||
      upper === 'ADMINISTRADOR';
    return {
      roleCode: isAdmin ? 'ADMIN' : 'USER',
      roleLabel: isAdmin ? 'Administrador' : 'User',
    };
  }

  function isCurrentUserAdmin() {
    return (
      state.currentUser?.roleCode === 'ADMIN' ||
      String(state.currentUser?.email || '').toLowerCase() === PRIMARY_ADMIN_EMAIL
    );
  }

  function evaluatePasswordStrength(pwd) {
    const value = String(pwd || '');
    const checks = {
      length: value.length >= 8,
      upper: /[A-Z]/.test(value),
      lower: /[a-z]/.test(value),
      number: /[0-9]/.test(value),
      special: /[^A-Za-z0-9\s]/.test(value),
    };
    const valid = Object.values(checks).every(Boolean);
    return { checks, valid };
  }

  function updatePasswordRulesUI(containerSelector, pwd, showInvalidState = false) {
    const value = String(pwd || '');
    const { checks } = evaluatePasswordStrength(value);
    const hasInput = value.length > 0;
    $$(`${containerSelector} .pwd-rule`).forEach((item) => {
      const rule = item.dataset.rule;
      const ok = Boolean(checks[rule]);
      item.classList.toggle('valid', ok);
      item.classList.toggle('invalid', !ok && (showInvalidState || hasInput));
      const icon = item.querySelector('.pwd-rule-icon');
      if (icon) {
        icon.textContent = ok ? '✓' : showInvalidState || hasInput ? '✕' : '•';
      }
    });
  }

  function syncRoleVisibilityUI() {
    const isAdmin = isCurrentUserAdmin();
    $('#btnNavUsers')?.classList.toggle('hidden', !isAdmin);
    $('#btnProfileUsers')?.classList.toggle('hidden', !isAdmin);
    const badge = $('#profileRoleBadge');
    if (badge) {
      badge.textContent = isAdmin ? 'Administrador' : 'User';
      badge.classList.toggle('admin', isAdmin);
      badge.classList.toggle('user', !isAdmin);
    }
  }

  const AGENT_STATUSES = [
    { key: 'online', label: 'Online' },
    { key: 'busy', label: 'Ocupado' },
    { key: 'offline', label: 'Offline' },
  ];

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function nowTime() {
    return new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toast(msg) {
    const stack = $('#toastStack');
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    stack.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.2s';
      setTimeout(() => el.remove(), 220);
    }, 2600);
  }

  function getSelectedConv() {
    return state.conversations.find((c) => c.id === state.selectedConvId) || state.conversations[0];
  }

  function channelBadgeClass(ch) {
    if (ch === 'WhatsApp') return 'wa';
    if (ch === 'WebChat') return 'web';
    return 'ig';
  }

  function channelMiniGlyph(ch) {
    if (ch === 'WhatsApp') return 'W';
    if (ch === 'WebChat') return '💬';
    return 'I';
  }

  // ========================================================================
  // CENTRAL DE NOTIFICAÇÕES (ALERTAS E CHAMADOS) + MANUAL DE USO
  // ========================================================================
  const MANUAL_SECTIONS = {
    start: `
      <div class="manual-block">
        <h4>1. Acesso e Conformidade LGPD</h4>
        <p>Entre com seu e-mail corporativo e senha na tela inicial. No primeiro acesso, confirme o aceite do <strong>Termo de Privacidade (LGPD)</strong> para liberar o painel.</p>
      </div>
      <div class="manual-block">
        <h4>2. Barra Superior de Navegação</h4>
        <ul>
          <li><strong>Conversas:</strong> gestão dos atendimentos abertos, fila e histórico.</li>
          <li><strong>Conexões:</strong> canais conectados (WhatsApp, Webchat, Telegram, Instagram e outros).</li>
          <li><strong>Contatos:</strong> base de clientes com importação/exportação CSV e filtros avançados.</li>
          <li><strong>Relatórios:</strong> indicadores de desempenho, atendimentos por conexão e exportação CSV.</li>
          <li><strong>Notificações (🔔) e Tema (☀️/🌙):</strong> alertas de novos chamados e alternância entre modo escuro e claro.</li>
        </ul>
      </div>
      <div class="manual-block">
        <h4>3. Status de Disponibilidade do Atendente</h4>
        <p>Clique no seu avatar no canto superior direito para alternar entre <strong>Online</strong>, <strong>Ocupado</strong> e <strong>Offline</strong>.</p>
      </div>
    `,
    conversations: `
      <div class="manual-block">
        <h4>Abas Minhas, Fila e Todas</h4>
        <p>Acompanhe seus atendimentos ativos em <strong>Minhas</strong>, puxe clientes aguardando na <strong>Fila</strong> ou consulte o panorama completo em <strong>Todas</strong>.</p>
      </div>
      <div class="manual-block">
        <h4>Botões + e ⋮ no Topo de Conversas</h4>
        <ul>
          <li><strong>+ (Adicionar):</strong> crie rapidamente um novo contato individual ou um novo grupo de atendimento.</li>
          <li><strong>⋮ (Ordenar por):</strong> ordene por <em>Mensagem mais recente</em>, <em>Mais antigos</em>, <em>Mais recentes</em>, <em>Maior</em> ou <em>Menor tempo de espera</em>.</li>
        </ul>
      </div>
      <div class="manual-block">
        <h4>Envio de Mensagens, Notas Internas e Respostas Rápidas</h4>
        <ul>
          <li>Digite <strong><code>/</code></strong> no campo de texto (ou clique no <strong>+</strong> do composer) para inserir respostas prontas (<code>/ola</code>, <code>/acesso</code>, <code>/pix</code>, <code>/encerrar</code>).</li>
          <li>Clique no cadeado 🔒 para ativar o modo <strong>Nota interna</strong> (visível apenas para a equipe).</li>
          <li>Use o ícone de <strong>clipe (📎)</strong> para anexar documentos, imagens, áudios, contatos, enquetes, Pix, eventos ou figurinhas, e o ícone <strong>😊</strong> para inserir emojis.</li>
        </ul>
      </div>
    `,
    connections: `
      <div class="manual-block">
        <h4>Gerenciar Conexões Ativas e Arquivadas</h4>
        <p>Nos <strong>três pontinhos (⋮)</strong> de cada card você pode <strong>Visualizar</strong>, consultar o <strong>Histórico de eventos</strong>, <strong>Editar</strong>, <strong>Arquivar</strong>, <strong>Reiniciar</strong>, <strong>Pausar</strong>, <strong>Desconectar</strong> ou <strong>Excluir</strong> a conexão.</p>
      </div>
      <div class="manual-block">
        <h4>Adicionar Novas Conexões</h4>
        <p>Clique em <strong>+ Adicionar</strong> para abrir o catálogo de canais (WhatsApp, Webchat, Telegram, WhatsApp Business API, Instagram, Facebook Messenger, Email, SMS e Reclame Aqui) e acompanhar o limite contratado de cada canal.</p>
      </div>
    `,
    contacts: `
      <div class="manual-block">
        <h4>Importação, Exportação e Cadastro</h4>
        <ul>
          <li><strong>+ Importar contatos ▾:</strong> importe um arquivo <code>.csv</code> (<code>Nome,Telefone,Email</code>), baixe a planilha modelo ou exporte sua base filtrada.</li>
          <li><strong>Novo contato:</strong> cadastre manualmente um contato vinculado a uma conexão e departamento.</li>
          <li><strong>Exibir Filtros:</strong> combine busca textual com filtros por Conexão, Departamento e Tag.</li>
        </ul>
      </div>
    `,
    shortcuts: `
      <div class="manual-block">
        <h4>Atalhos de Teclado</h4>
        <div class="manual-kbd-row"><span>Abrir Busca Rápida (Command Bar)</span><kbd>Ctrl + K</kbd></div>
        <div class="manual-kbd-row"><span>Abrir Respostas Rápidas no chat</span><kbd>/</kbd></div>
        <div class="manual-kbd-row"><span>Enviar mensagem</span><kbd>Enter</kbd></div>
        <div class="manual-kbd-row"><span>Quebrar linha na mensagem</span><kbd>Shift + Enter</kbd></div>
        <div class="manual-kbd-row"><span>Fechar modais e menus abertos</span><kbd>Esc</kbd></div>
      </div>
    `,
  };

  function playNotificationChime() {
    if (!state.notifSoundEnabled) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1174.66, ctx.currentTime + 0.09);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.23);
    } catch {
      // Áudio bloqueado antes de interação do usuário
    }
  }

  function renderNotifications() {
    const unreadCount = state.notifications.filter((n) => n.unread).length;
    const badge = $('#notifUnreadBadge');
    badge.textContent = unreadCount > 99 ? '99+' : unreadCount;
    badge.classList.toggle('hidden', unreadCount === 0);

    const headerCount = $('#notifHeaderCount');
    headerCount.textContent = unreadCount === 1 ? '1 nova' : `${unreadCount} novas`;

    $$('.notif-tab').forEach((t) =>
      t.classList.toggle('active', t.dataset.notifFilter === state.notifFilter)
    );

    const list = state.notifications.filter(
      (n) => state.notifFilter === 'all' || n.category === state.notifFilter
    );

    const container = $('#notificationsList');
    if (list.length === 0) {
      container.innerHTML = `<div style="padding:30px 16px;text-align:center;color:var(--text-muted);font-size:12.5px;">Nenhuma notificação nesta categoria.</div>`;
      return;
    }

    container.innerHTML = list
      .map((n) => {
        const icon = n.category === 'alert' ? '⚠️' : '🎫';
        return `
          <button type="button" class="notif-item ${n.unread ? 'unread' : ''}" data-notif-id="${n.id}">
            <span class="notif-icon ${escapeHtml(n.category)}">${icon}</span>
            <div class="notif-content">
              <div class="notif-title-row">
                <span class="notif-title">${escapeHtml(n.title)}</span>
                <span class="notif-time">${escapeHtml(n.time)}</span>
              </div>
              <div class="notif-msg">${escapeHtml(n.message)}</div>
            </div>
            ${n.unread ? '<span class="notif-unread-dot" aria-label="Não lida"></span>' : ''}
          </button>
        `;
      })
      .join('');

    $$('[data-notif-id]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const item = state.notifications.find((x) => x.id === btn.dataset.notifId);
        if (!item) return;
        item.unread = false;
        renderNotifications();
        $('#notificationsPanel').classList.add('hidden');
        $('#btnNotifications').setAttribute('aria-expanded', 'false');

        if (item.convId) {
          state.selectedConvId = item.convId;
          state.tab = 'all';
          state.statusFilter = 'open';
          setView('conversations');
        } else if (item.viewTarget) {
          if (item.tabTarget) state.tab = item.tabTarget;
          setView(item.viewTarget);
        }
      };
    });
  }

  function pushNotification({ category = 'ticket', title, message, convId = null, viewTarget = null, tabTarget = null, silent = false }) {
    state.notifications.unshift({
      id: 'ntf_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
      category,
      title,
      message,
      time: `às ${nowTime()}`,
      unread: true,
      convId,
      viewTarget,
      tabTarget,
    });
    renderNotifications();
    if (!silent) playNotificationChime();
  }

  function openManualModal(tab = 'start') {
    state.manualTab = tab;
    $$('.manual-tab').forEach((t) =>
      t.classList.toggle('active', t.dataset.manualTab === tab)
    );
    $('#manualContent').innerHTML = MANUAL_SECTIONS[tab] || MANUAL_SECTIONS.start;
    $('#manualModal').classList.remove('hidden');
  }

  // ========================================================================
  // INTEGRAÇÃO BACK-END REAL + SOCKET.IO + WHATSAPP QR CODE (BAILEYS)
  // ========================================================================
  function formatIsoTime(iso) {
    if (!iso) return nowTime();
    try {
      return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    } catch {
      return nowTime();
    }
  }

  function mapBackendConversation(c) {
    const createdMs = c.createdAt ? new Date(c.createdAt).getTime() : Date.now();
    const lastMs = c.lastMessageAt ? new Date(c.lastMessageAt).getTime() : createdMs;
    const waitMinutes = Math.max(0, Math.round((Date.now() - lastMs) / 60000));
    const existing = state.conversations.find((x) => x.id === c.id);

    return {
      id: c.id,
      isRemote: true,
      ticketNumber: c.ticketNumber,
      status: c.status === 'resolved' ? 'resolved' : 'open',
      assignee: c.assigneeId || 'queue',
      connectionId: c.connectionId,
      connection: c.connection,
      channel: c.channel || 'WhatsApp',
      departmentId: c.departmentId,
      department: c.department || 'Suporte',
      unread: c.unread || 0,
      updatedAt: formatIsoTime(c.lastMessageAt),
      createdTs: createdMs,
      lastMessageTs: lastMs,
      waitMinutes,
      labels: Array.isArray(c.labels) ? c.labels : [],
      contact: {
        ...c.contact,
        avatarUrl: c.contact?.avatarUrl || existing?.contact?.avatarUrl || null,
      },
      messages:
        existing?.messages?.length
          ? existing.messages
          : c.lastMessage
            ? [
              {
                id: c.lastMessage.id,
                type: c.lastMessage.type,
                sender: c.lastMessage.type === 'incoming' ? c.contact.name : 'Você',
                text: c.lastMessage.text,
                time: formatIsoTime(c.lastMessage.createdAt),
              },
            ]
            : [],
      _messagesLoaded: Boolean(existing?._messagesLoaded),
      _messagesFetchedAt: existing?._messagesFetchedAt || 0,
    };
  }

  function mapBackendMessage(m) {
    let attachment = null;
    if (m.attachment) {
      const mime = m.attachment.mimeType || '';
      if (mime.startsWith('image/') && m.attachment.url) {
        attachment = { kind: 'image', url: m.attachment.url, name: m.attachment.fileName };
      } else if (mime.startsWith('audio/')) {
        attachment = { kind: 'audio', name: m.attachment.fileName, duration: '' };
      } else {
        attachment = {
          kind: 'document',
          name: m.attachment.fileName,
          size: m.attachment.sizeBytes ? `${Math.round(m.attachment.sizeBytes / 1024)} KB` : 'Anexo',
        };
      }
    }
    return {
      id: m.id,
      externalId: m.externalId || null,
      type: m.type || 'incoming',
      sender: m.sender || 'Contato',
      text: m.text || '',
      quote: m.quote || null,
      attachment,
      deliveryStatus: m.deliveryStatus || 'SENT',
      time: formatIsoTime(m.createdAt),
    };
  }

  async function loadBackendConnections() {
    if (!state.apiConnected || !API) return;
    try {
      const prevStates = new Map(state.connections.map((c) => [c.id, c.sessionState]));
      const { connections } = await API.getConnections();
      if (Array.isArray(connections)) {
        let anyBecameConnected = false;
        const newlyDisconnectedIds = [];

        state.connections = connections.map((c) => {
          const prev = state.connections.find((x) => x.id === c.id);
          const prevState = prevStates.get(c.id);
          if (prevState && prevState !== 'connected' && c.sessionState === 'connected') {
            anyBecameConnected = true;
          } else if (prevState === 'connected' && c.sessionState === 'disconnected') {
            newlyDisconnectedIds.push(c.id);
          }
          return {
            ...c,
            isRemote: true,
            events: prev?.events || [
              {
                title:
                  c.sessionState === 'connected'
                    ? 'Sessão conectada com sucesso'
                    : c.sessionState === 'qr'
                      ? 'Aguardando leitura do QR Code'
                      : 'Conexão registrada no SMV Sac',
                actor: 'Sistema SMV Sac',
                time: formatIsoTime(c.createdAt),
                tone: c.sessionState === 'connected' ? 'success' : 'info',
              },
            ],
          };
        });
        if (state.view === 'connections') renderConnections();

        if (newlyDisconnectedIds.length > 0) {
          newlyDisconnectedIds.forEach((connId) => clearConversationsUIForConnection(connId, false));
          void loadBackendConversations(false);
        }
        if (anyBecameConnected) {
          void loadBackendConversations(true);
        }
      }
    } catch (err) {
      console.warn('[API] Falha ao carregar conexões:', err);
    }
  }

  const presenceSafetyTimers = new Map();
  const presenceSubscribedAt = new Map();
  const FRONTEND_PRESENCE_SAFETY_MS = 16000;
  const FRONTEND_PRESENCE_SUB_THROTTLE_MS = 25000;

  function formatPresenceLabel(status) {
    if (status === 'recording') return 'gravando áudio...';
    if (status === 'typing') return 'digitando...';
    return '';
  }

  function getConversationPreviewText(c) {
    if (!c || !Array.isArray(c.messages) || c.messages.length === 0) return '';
    const last = [...c.messages].reverse().find((m) => m.type !== 'activity') || c.messages[c.messages.length - 1];
    if (!last) return '';
    const prefix = last.type === 'outgoing' ? '✓✓ ' : last.type === 'private' ? '🔒 ' : '';
    const attLabel = last.attachment
      ? {
          document: `📄 ${last.attachment.name || 'Documento'}`,
          image: '🖼️ Foto',
          audio: `🎧 ${last.attachment.name || 'Áudio'}`,
          contact: `👤 ${last.attachment.contactName || 'Contato'}`,
          poll: `📊 Enquete: ${last.attachment.question || ''}`,
          pix: `💠 Pix ${last.attachment.amount || ''}`,
          event: `📅 ${last.attachment.title || 'Evento'}`,
          sticker: 'Figurinha',
        }[last.attachment.kind] || '📎 Anexo'
      : '';
    return `${prefix}${last.text || attLabel}`;
  }

  function renderActiveChatPresence(conv) {
    const el = $('#chatHeaderPresence');
    if (!el) return;
    if (!conv) {
      el.classList.add('hidden');
      el.innerHTML = '';
      return;
    }
    const status = state.conversationPresences[conv.id] || null;
    const label = formatPresenceLabel(status);
    if (!label) {
      el.classList.add('hidden');
      el.innerHTML = '';
      return;
    }
    el.innerHTML = `<span class="presence-pulse-dot" aria-hidden="true"></span><span>${escapeHtml(label)}</span>`;
    el.classList.remove('hidden');
  }

  function updateConversationPresenceDOM(convId) {
    const status = state.conversationPresences[convId] || null;
    const label = formatPresenceLabel(status);

    // Atualiza prévia na lista lateral de conversas sem reconstruir toda a lista
    const conv = state.conversations.find((c) => String(c.id) === String(convId));
    const rowPreview = document.querySelector(`.conv-row[data-conv-id="${CSS.escape(String(convId))}"] .conv-row-preview`);
    if (rowPreview) {
      if (label) {
        rowPreview.textContent = label;
        rowPreview.classList.add('is-presence');
      } else {
        rowPreview.textContent = getConversationPreviewText(conv);
        rowPreview.classList.remove('is-presence');
      }
    }

    // Atualiza cabeçalho da conversa ativa se for a conversa selecionada
    if (String(state.selectedConvId) === String(convId)) {
      renderActiveChatPresence(conv);
    }
  }

  function setConversationPresence(convId, status, timeoutMs = FRONTEND_PRESENCE_SAFETY_MS) {
    if (!convId) return;
    const key = String(convId);
    const prevTimer = presenceSafetyTimers.get(key);
    if (prevTimer) {
      clearTimeout(prevTimer);
      presenceSafetyTimers.delete(key);
    }

    const normalized = status === 'typing' || status === 'recording' ? status : null;
    const prevStatus = state.conversationPresences[key] || null;

    if (normalized) {
      state.conversationPresences[key] = normalized;
      const timer = setTimeout(() => {
        presenceSafetyTimers.delete(key);
        if (state.conversationPresences[key]) {
          delete state.conversationPresences[key];
          updateConversationPresenceDOM(key);
        }
      }, Math.max(3000, timeoutMs));
      presenceSafetyTimers.set(key, timer);
    } else {
      delete state.conversationPresences[key];
    }

    if (prevStatus !== normalized) {
      updateConversationPresenceDOM(key);
    }
  }

  function clearAllConversationPresences() {
    presenceSafetyTimers.forEach((timer) => clearTimeout(timer));
    presenceSafetyTimers.clear();
    presenceSubscribedAt.clear();
    state.conversationPresences = {};
    renderActiveChatPresence(null);
  }

  function ensurePresenceSubscribed(conv) {
    if (!conv || !conv.isRemote || !state.apiConnected || !API?.subscribeConversationPresence) return;
    const key = String(conv.id);
    const now = Date.now();
    const lastSub = presenceSubscribedAt.get(key) || 0;
    if (now - lastSub < FRONTEND_PRESENCE_SUB_THROTTLE_MS) return;
    presenceSubscribedAt.set(key, now);

    void API.subscribeConversationPresence(conv.id)
      .then((res) => {
        if (res && Object.prototype.hasOwnProperty.call(res, 'presence')) {
          setConversationPresence(conv.id, res.presence || null);
        }
      })
      .catch(() => {});
  }

  function clearConversationsUIForConnection(connectionId = null, syncFromApi = true) {
    const removedIds = new Set();
    if (connectionId) {
      state.conversations = state.conversations.filter((c) => {
        const matchesConn = c.connectionId === connectionId;
        if (matchesConn) removedIds.add(String(c.id));
        return !matchesConn;
      });
    } else {
      state.conversations.forEach((c) => removedIds.add(String(c.id)));
      state.conversations = [];
    }

    // Se nenhuma conexão está conectada, garante lista 100% zerada
    const hasAnyConnected = state.connections.some(
      (c) => c.status !== 'archived' && c.sessionState === 'connected'
    );
    if (!hasAnyConnected) {
      state.conversations.forEach((c) => removedIds.add(String(c.id)));
      state.conversations = [];
    }

    removedIds.forEach((convId) => setConversationPresence(convId, null));

    const selectedStillExists =
      state.selectedConvId !== null &&
      state.conversations.some((c) => String(c.id) === String(state.selectedConvId));

    if (!selectedStillExists || state.conversations.length === 0) {
      state.selectedConvId = null;
      $('#detailsDrawer')?.classList.add('hidden');
      $('#chatInlineSearch')?.classList.add('hidden');
    }

    renderConversations();

    if (syncFromApi && state.apiConnected) {
      void loadBackendConversations(false);
    }
  }

  async function loadBackendConversations(selectFirst = false) {
    if (!state.apiConnected || !API) return;
    try {
      const { conversations } = await API.getConversations({ status: 'all', tab: 'all' });
      if (Array.isArray(conversations) && conversations.length > 0) {
        state.conversations = conversations.map(mapBackendConversation);
        conversations.forEach((c) => {
          if (c.presence === 'typing' || c.presence === 'recording') {
            setConversationPresence(c.id, c.presence);
          } else if (state.conversationPresences[c.id]) {
            setConversationPresence(c.id, null);
          }
        });
        if (selectFirst || !state.conversations.some((c) => c.id === state.selectedConvId)) {
          state.selectedConvId = state.conversations[0].id;
        }
        renderConversations();
        if (state.selectedConvId) {
          void loadMessagesForConversation(state.selectedConvId);
        }
      } else if (Array.isArray(conversations)) {
        // Sem conexões conectadas ou sem conversas: limpa tudo imediatamente e zera contadores/badges
        clearAllConversationPresences();
        state.conversations = [];
        state.selectedConvId = null;
        $('#detailsDrawer')?.classList.add('hidden');
        $('#chatInlineSearch')?.classList.add('hidden');
        renderConversations();
      }
    } catch (err) {
      console.warn('[API] Falha ao carregar conversas:', err);
    }
  }

  const inflightMessageFetches = new Set();

  async function loadMessagesForConversation(conversationId, { silent = false } = {}) {
    if (!state.apiConnected || !API || !conversationId || typeof conversationId !== 'string') return;
    const conv = state.conversations.find((c) => c.id === conversationId);
    if (!conv || !conv.isRemote) return;
    if (inflightMessageFetches.has(conversationId)) return;
    inflightMessageFetches.add(conversationId);
    try {
      const data = await API.getMessages(conversationId);
      const messages = data?.messages;
      if (data && Object.prototype.hasOwnProperty.call(data, 'presence')) {
        setConversationPresence(conversationId, data.presence || null);
      }
      if (Array.isArray(messages)) {
        const mapped = messages.map(mapBackendMessage);
        const prevSig = `${conv.messages.length}:${conv.messages[conv.messages.length - 1]?.id || ''}:${conv.messages[conv.messages.length - 1]?.deliveryStatus || ''}`;
        const nextSig = `${mapped.length}:${mapped[mapped.length - 1]?.id || ''}:${mapped[mapped.length - 1]?.deliveryStatus || ''}`;
        conv.messages = mapped;
        conv._messagesLoaded = true;
        conv._messagesFetchedAt = Date.now();
        if (state.selectedConvId === conversationId && (!silent || prevSig !== nextSig)) {
          renderActiveChat();
        }
      }
    } catch (err) {
      console.warn('[API] Falha ao carregar mensagens:', err);
    } finally {
      inflightMessageFetches.delete(conversationId);
    }
  }

  function updateContactsCountBadge() {
    const badge = $('#contactsTotalBadge');
    if (!badge) return;
    const total = state.apiConnected ? state.contactsTotal || state.contacts.length : state.conversations.length;
    badge.textContent = total;
    badge.classList.toggle('hidden', total === 0);
  }

  async function loadBackendContacts(query = '', limit = 200) {
    if (!state.apiConnected || !API) return [];
    try {
      const data = await API.getContacts({ q: query.trim(), limit });
      const list = Array.isArray(data.contacts) ? data.contacts : [];
      if (!query.trim()) {
        state.contacts = list;
        state.contactsTotal = typeof data.total === 'number' ? data.total : list.length;
      } else {
        state.contacts = list;
      }
      updateContactsCountBadge();
      if (state.view === 'contacts') renderContacts();
      return list;
    } catch (err) {
      console.warn('[API] Falha ao carregar contatos:', err);
      return [];
    }
  }

  async function searchAgendaContactsForSidebar(rawQuery) {
    const q = (rawQuery || '').trim();
    const seq = ++state.contactSearchReqSeq;

    if (!q) {
      state.contactSearchResults = [];
      state.contactSearchLoading = false;
      renderConversations();
      return;
    }

    if (!state.apiConnected || !API) {
      const ql = q.toLowerCase();
      const qd = q.replace(/\D/g, '');
      state.contactSearchResults = state.conversations
        .map((c) => ({
          id: c.contact.id || String(c.id),
          name: c.contact.name,
          initials: c.contact.initials,
          phone: c.contact.phone,
          email: c.contact.email,
          avatarUrl: c.contact.avatarUrl || null,
          connection: c.connection,
          department: c.department,
          conversationId: c.id,
        }))
        .filter((c) => {
          const pd = (c.phone || '').replace(/\D/g, '');
          return (
            c.name.toLowerCase().includes(ql) ||
            (c.email || '').toLowerCase().includes(ql) ||
            (qd.length >= 2 && pd.includes(qd))
          );
        });
      state.contactSearchLoading = false;
      renderConversations();
      return;
    }

    state.contactSearchLoading = true;
    renderConversations();

    try {
      const data = await API.getContacts({ q, limit: 30 });
      if (seq !== state.contactSearchReqSeq) return;
      state.contactSearchResults = Array.isArray(data.contacts) ? data.contacts : [];
    } catch (err) {
      if (seq !== state.contactSearchReqSeq) return;
      console.warn('[API] Falha ao pesquisar agenda:', err);
      state.contactSearchResults = [];
    } finally {
      if (seq === state.contactSearchReqSeq) {
        state.contactSearchLoading = false;
        renderConversations();
      }
    }
  }

  async function openConversationForContact(contact) {
    if (!contact) return;

    if (!API?.getToken()) {
      forceRedirectToLogin('Sua sessão expirou. Faça login novamente para continuar.');
      return;
    }

    try {
      const res = await API.openOrCreateConversation({
        contactId: contact.id,
        ...(contact.connectionId ? { connectionId: contact.connectionId } : {}),
      });
      if (!res?.conversation) {
        toast('Não foi possível abrir a conversa para este contato.');
        return;
      }

      const mapped = mapBackendConversation(res.conversation);
      const existingIdx = state.conversations.findIndex((c) => c.id === mapped.id);
      if (existingIdx >= 0) {
        mapped.messages = state.conversations[existingIdx].messages;
        mapped._messagesLoaded = state.conversations[existingIdx]._messagesLoaded;
        mapped._messagesFetchedAt = state.conversations[existingIdx]._messagesFetchedAt;
        state.conversations[existingIdx] = mapped;
      } else {
        state.conversations.unshift(mapped);
      }

      // Limpa busca para exibir o chat na lista e abre imediatamente na área central
      state.searchQuery = '';
      const searchInput = $('#convSearchInput');
      if (searchInput) searchInput.value = '';
      state.contactSearchResults = [];
      state.contactSearchLoading = false;
      state.tab = 'all';
      state.statusFilter = mapped.status === 'resolved' ? 'all' : 'open';
      state.selectedConvId = mapped.id;
      mapped.unread = 0;

      closeNewConversationModal();
      setView('conversations');

      // Carrega histórico em segundo plano e foca o cursor no campo de digitar mensagem
      void loadMessagesForConversation(mapped.id, { silent: Boolean(mapped._messagesLoaded) });
      setTimeout(() => $('#composerInput')?.focus(), 35);

      if (res.created) {
        toast(`Nova conversa iniciada (${mapped.ticketNumber}) com ${mapped.contact.name}!`);
      }
    } catch (err) {
      toast(`Erro ao abrir conversa: ${err.message}`);
    }
  }

  async function syncWhatsAppContacts(connectionId = null) {
    if (!state.apiConnected || !API) {
      toast('Conecte-se ao servidor back-end para sincronizar a agenda do WhatsApp.');
      return;
    }

    const targetConn = connectionId
      ? state.connections.find((c) => c.id === connectionId)
      : state.connections.find(
          (c) => c.channel === 'WhatsApp' && c.status === 'active' && c.sessionState === 'connected'
        ) || state.connections.find((c) => c.channel === 'WhatsApp' && c.status === 'active');

    if (!targetConn) {
      toast('Nenhuma conexão WhatsApp conectada encontrada. Conecte um WhatsApp via QR Code primeiro.');
      return;
    }

    const syncBtn = $('#btnContactsSyncWa');
    if (syncBtn) syncBtn.disabled = true;
    toast(`🔄 Sincronizando agenda de contatos de "${targetConn.name}"...`);

    try {
      const res = await API.syncConnectionContacts(targetConn.id);
      pushConnectionEvent(
        targetConn,
        `Agenda sincronizada (${res.totalContacts ?? 0} contatos na base)`,
        'success'
      );
      await loadBackendContacts($('#contactsSearchInput')?.value || '', 200);
      if (state.view === 'connections') renderConnections();
      toast(`✅ Agenda sincronizada! ${res.totalContacts ?? 0} contato(s) disponíveis para busca.`);
    } catch (err) {
      toast(`❌ Erro ao sincronizar contatos: ${err.message}`);
    } finally {
      if (syncBtn) syncBtn.disabled = false;
    }
  }

  function closeNewConversationModal() {
    const modal = $('#newConversationModal');
    if (modal) modal.classList.add('hidden');
  }

  function renderNewConvResults() {
    const listEl = $('#newConvResultsList');
    if (!listEl) return;

    if (state.newConvLoading) {
      listEl.innerHTML = `<div class="conv-section-empty">Buscando contatos na agenda...</div>`;
      return;
    }

    if (state.newConvResults.length === 0) {
      listEl.innerHTML = `<div class="conv-section-empty">Nenhum contato encontrado na agenda. Tente outro nome/telefone ou cadastre um novo contato abaixo.</div>`;
      return;
    }

    listEl.innerHTML = state.newConvResults
      .map(
        (c) => `
          <button type="button" class="new-conv-item" data-new-conv-contact="${escapeHtml(c.id)}">
            <div class="avatar md">${renderAvatarInner(c)}</div>
            <div class="new-conv-item-info">
              <div class="new-conv-item-name">${escapeHtml(c.name)}</div>
              <div class="new-conv-item-meta">${escapeHtml(c.phone || 'WhatsApp')}${c.connection && c.connection !== '-' ? ' • ' + escapeHtml(c.connection) : ''}</div>
            </div>
            <span class="agenda-action-chip">${c.conversationId ? 'Abrir chat' : 'Iniciar conversa'}</span>
          </button>
        `
      )
      .join('');

    $$('[data-new-conv-contact]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const contact = state.newConvResults.find((x) => String(x.id) === String(btn.dataset.newConvContact));
        if (contact) void openConversationForContact(contact);
      });
    });
  }

  async function searchContactsForNewConvModal(rawQuery = '') {
    const q = (rawQuery || '').trim();
    const seq = ++state.newConvReqSeq;

    if (!state.apiConnected || !API) {
      const ql = q.toLowerCase();
      state.newConvResults = state.conversations
        .map((c) => ({
          id: c.contact.id || String(c.id),
          name: c.contact.name,
          initials: c.contact.initials,
          phone: c.contact.phone,
          avatarUrl: c.contact.avatarUrl || null,
          connection: c.connection,
          conversationId: c.id,
        }))
        .filter((c) => !ql || c.name.toLowerCase().includes(ql) || (c.phone || '').toLowerCase().includes(ql));
      state.newConvLoading = false;
      renderNewConvResults();
      return;
    }

    state.newConvLoading = true;
    renderNewConvResults();

    try {
      const data = await API.getContacts({ q, limit: 40 });
      if (seq !== state.newConvReqSeq) return;
      state.newConvResults = Array.isArray(data.contacts) ? data.contacts : [];
    } catch {
      if (seq !== state.newConvReqSeq) return;
      state.newConvResults = [];
    } finally {
      if (seq === state.newConvReqSeq) {
        state.newConvLoading = false;
        renderNewConvResults();
      }
    }
  }

  function openNewConversationModal() {
    const modal = $('#newConversationModal');
    if (!modal) return;
    const inp = $('#newConvSearchInput');
    if (inp) inp.value = '';
    modal.classList.remove('hidden');
    void searchContactsForNewConvModal('');
    setTimeout(() => inp?.focus(), 25);
  }

  function stopWaQrPolling() {
    if (state.waQrPollTimer) {
      clearInterval(state.waQrPollTimer);
      state.waQrPollTimer = null;
    }
    state.waQrPollInFlight = false;
  }

  function stopFallbackSyncPolling() {
    if (state.fallbackPollTimer) {
      clearInterval(state.fallbackPollTimer);
      state.fallbackPollTimer = null;
    }
  }

  function startFallbackSyncPolling() {
    // Polling só roda como fallback quando o Socket.IO desconectar
    if (state.socketConnected || !state.apiConnected || !state.authenticated) {
      stopFallbackSyncPolling();
      return;
    }
    if (state.fallbackPollTimer) return;
    state.fallbackPollTimer = setInterval(() => {
      if (state.socketConnected || !state.apiConnected || !state.authenticated) {
        stopFallbackSyncPolling();
        return;
      }
      void loadBackendConnections();
      void loadBackendConversations(false);
      if (state.selectedConvId) {
        void loadMessagesForConversation(state.selectedConvId);
      }
    }, 8000);
  }

  function closeWaQrModal() {
    stopWaQrPolling();
    state.waQrConnectionId = null;
    $('#whatsappQrModal').classList.add('hidden');
  }

  function updateWaQrModalState({ status, qrDataUrl, identifier }) {
    const loader = $('#waQrLoader');
    const img = $('#waQrImage');
    const connectedBox = $('#waQrConnectedBox');
    const statusPill = $('#waQrStatusPill');
    const statusText = $('#waQrStatusText');

    statusPill.classList.remove('connected');

    if (status === 'CONNECTED') {
      stopWaQrPolling();
      const completedConnectionId = state.waQrConnectionId;
      state.waQrConnectionId = null;
      loader.classList.add('hidden');
      img.classList.add('hidden');
      connectedBox.classList.remove('hidden');
      $('#waQrConnectedPhone').textContent = identifier
        ? `${identifier} • Sincronizando conversas...`
        : 'Sincronizando conversas...';
      statusPill.classList.add('connected');
      statusText.textContent = `Conectado (${identifier || 'WhatsApp'})!`;

      if (completedConnectionId) {
        void loadBackendConnections();
        setTimeout(() => {
          void loadBackendConversations(true);
          closeWaQrModal();
          state.connSubView = 'list';
          setView('conversations');
          toast(`✅ WhatsApp conectado (${identifier || 'Ativo'})! Conversas sincronizando em tempo real.`);
        }, 1500);
      }
      return;
    }

    connectedBox.classList.add('hidden');

    if (qrDataUrl) {
      loader.classList.add('hidden');
      img.src = qrDataUrl;
      img.classList.remove('hidden');
      statusText.textContent = 'QR Code pronto! Aponte a câmera do WhatsApp para conectar.';
    } else {
      img.classList.add('hidden');
      loader.classList.remove('hidden');
      statusText.textContent = 'Gerando QR Code com os servidores do WhatsApp...';
    }
  }

  function startWaQrPolling(connectionId) {
    stopWaQrPolling();
    state.waQrPollTimer = setInterval(async () => {
      if (!state.apiConnected || !state.waQrConnectionId || state.waQrConnectionId !== connectionId) {
        stopWaQrPolling();
        return;
      }
      const target = state.connections.find((c) => c.id === connectionId);
      if (target?.sessionState === 'connected') {
        stopWaQrPolling();
        return;
      }
      if (state.waQrPollInFlight) return;
      state.waQrPollInFlight = true;
      try {
        const snap = await API.getWhatsAppQr(connectionId);
        if (snap?.status === 'CONNECTED') {
          stopWaQrPolling();
        }
        updateWaQrModalState(snap);
      } catch {
        // Aguarda próximo ciclo
      } finally {
        state.waQrPollInFlight = false;
      }
    }, 2500);
  }

  function isNetworkOfflineError(err) {
    return Boolean(
      err &&
        (err.isNetworkError ||
          err.status === 0 ||
          /failed to fetch|networkerror|load failed/i.test(String(err.message || '')))
    );
  }

  function formatApiErrorMessage(err, fallback) {
    if (isNetworkOfflineError(err)) {
      return `Servidor da API indisponível (${API?.BASE_URL || 'back-end'}). Verifique se o servidor está online.`;
    }
    return err?.message || fallback;
  }

  async function openWhatsAppQrModal(existingConn = null) {
    if (!API?.getToken()) {
      forceRedirectToLogin('Sua sessão expirou. Faça login novamente para parear o WhatsApp via QR Code.');
      return;
    }

    state.apiConnected = true;
    $('#whatsappQrModal').classList.remove('hidden');

    if (existingConn) {
      state.waQrConnectionId = existingConn.id;
      $('#waQrTitle').textContent = `Conectar WhatsApp — ${existingConn.name}`;
      $('#waQrSetupStep').classList.add('hidden');
      $('#waQrScanStep').classList.remove('hidden');
      updateWaQrModalState({ status: 'CONNECTING', qrDataUrl: null, identifier: existingConn.identifier });
      try {
        const snap = await API.connectWhatsApp(existingConn.id);
        updateWaQrModalState(snap);
        startWaQrPolling(existingConn.id);
      } catch (err) {
        toast(`❌ ${formatApiErrorMessage(err, 'Erro ao gerar QR Code.')}`);
      }
    } else {
      state.waQrConnectionId = null;
      $('#waQrTitle').textContent = 'Conectar WhatsApp via QR Code';
      $('#waConnNameInput').value = '';
      $('#waConnDeptSelect').value = 'Suporte';
      $('#waQrSetupStep').classList.remove('hidden');
      $('#waQrScanStep').classList.add('hidden');
      setTimeout(() => $('#waConnNameInput').focus(), 20);
    }
  }

  async function bootstrapBackendSession() {
    if (!state.apiConnected || !API) return;

    try {
      const meta = await API.getConversationsMeta();
      if (Array.isArray(meta.departments) && meta.departments.length > 0) {
        DATA.departments = meta.departments.map((d) => d.name);
        state.backendDepartments = meta.departments;
      }
      if (Array.isArray(meta.agents) && meta.agents.length > 0) {
        DATA.agents = [
          { id: 'queue', name: 'Na Fila (Sem atendente)' },
          ...meta.agents.map((a) => ({
            id: a.id,
            name: a.id === DATA.currentAgent.id ? `${a.name} (${a.role === 'ADMIN' ? 'Admin' : 'Você'})` : a.name,
          })),
        ];
      }
      if (Array.isArray(meta.cannedResponses) && meta.cannedResponses.length > 0) {
        DATA.cannedResponses = meta.cannedResponses.map((c) => ({
          code: c.shortcode,
          title: c.title,
          content: c.content,
        }));
      }
    } catch (err) {
      console.warn('[API] Falha ao carregar metadados:', err);
    }

    await Promise.all([
      loadBackendConnections(),
      loadBackendConversations(true),
      loadBackendContacts('', 200),
    ]);

    // Conecta Socket.IO autenticado para receber QR Code, status e mensagens em tempo real!
    API.connectSocket({
      onConnect() {
        state.socketConnected = true;
        stopFallbackSyncPolling();
      },
      onDisconnect() {
        state.socketConnected = false;
        startFallbackSyncPolling();
      },
      onWhatsAppQr(payload) {
        const target = state.connections.find((c) => c.id === payload.connectionId);
        if (target) {
          target.sessionState = 'qr';
          target.qrDataUrl = payload.qrDataUrl;
          if (state.view === 'connections') renderConnections();
        }
        if (state.waQrConnectionId === payload.connectionId) {
          updateWaQrModalState(payload);
        }
      },
      onWhatsAppStatus(payload) {
        const target = state.connections.find((c) => c.id === payload.connectionId);
        const normalizedStatus = String(payload.status || '').toUpperCase();
        const isDisconnected =
          normalizedStatus === 'DISCONNECTED' ||
          normalizedStatus === 'LOGGED_OUT' ||
          payload.reason === 'logged_out';

        if (target) {
          if (normalizedStatus === 'CONNECTED') {
            stopWaQrPolling();
            target.sessionState = 'connected';
            target.status = 'active';
            if (payload.identifier) target.identifier = payload.identifier;
            pushConnectionEvent(target, `WhatsApp conectado (${target.identifier})`, 'success');
          } else if (normalizedStatus === 'PAUSED') {
            target.sessionState = 'paused';
          } else if (normalizedStatus === 'CONNECTING') {
            target.sessionState = 'restarting';
          } else if (isDisconnected) {
            target.sessionState = 'disconnected';
            pushConnectionEvent(target, 'WhatsApp desconectado', 'danger');
          }
          if (state.view === 'connections') renderConnections();
        }

        if (isDisconnected) {
          clearConversationsUIForConnection(payload.connectionId, true);
        } else if (normalizedStatus === 'CONNECTED') {
          void loadBackendConversations(true);
        }

        if (state.waQrConnectionId === payload.connectionId) {
          updateWaQrModalState(payload);
        }
      },
      onConnectionDeleted(payload) {
        if (!payload?.connectionId) return;
        const idx = state.connections.findIndex((c) => c.id === payload.connectionId);
        if (idx !== -1) {
          state.connections.splice(idx, 1);
          if (state.view === 'connections') renderConnections();
        }
        clearConversationsUIForConnection(payload.connectionId, true);
      },
      onHistorySynced(payload) {
        void loadBackendConversations(false);
        if (payload?.syncedMessages > 0) {
          toast(`📥 ${payload.syncedMessages} mensagens sincronizadas do WhatsApp!`);
        }
      },
      onContactAvatarUpdated(payload) {
        if (!payload?.avatarUrl) return;
        let touched = false;
        let activeMatched = false;
        state.conversations.forEach((c) => {
          if (
            (payload.contactId && c.contact?.id === payload.contactId) ||
            (payload.conversationId && c.id === payload.conversationId)
          ) {
            c.contact.avatarUrl = payload.avatarUrl;
            touched = true;
            if (c.id === state.selectedConvId) activeMatched = true;
          }
        });
        state.contacts.forEach((ct) => {
          if (payload.contactId && ct.id === payload.contactId) {
            ct.avatarUrl = payload.avatarUrl;
          }
        });
        if (!touched) return;

        // Atualiza imediatamente a lista lateral e o cabeçalho + drawer da conversa aberta
        if (state.view === 'conversations') {
          state.conversations.forEach((c) => {
            if (
              (payload.contactId && c.contact?.id === payload.contactId) ||
              (payload.conversationId && c.id === payload.conversationId)
            ) {
              const rowAvatar = document.querySelector(`.conv-row[data-conv-id="${c.id}"] .avatar`);
              if (rowAvatar) {
                rowAvatar.innerHTML = `${renderAvatarInner(c.contact)}<span class="ch-dot ${channelBadgeClass(c.channel)}" title="${escapeHtml(c.channel)}">${channelMiniGlyph(c.channel)}</span>`;
              }
            }
          });
          if (activeMatched) {
            const activeConv = getSelectedConv();
            if (activeConv) {
              $('#chatAvatar').innerHTML = `${renderAvatarInner(activeConv.contact)}<span class="ch-dot ${channelBadgeClass(activeConv.channel)}">${channelMiniGlyph(activeConv.channel)}</span>`;
              renderDrawer(activeConv);
            }
          }
        } else if (state.view === 'contacts') {
          renderContacts();
        }
      },
      onContactsSynced(payload) {
        if (typeof payload?.totalContacts === 'number') {
          state.contactsTotal = payload.totalContacts;
          updateContactsCountBadge();
        }
        if (state.view === 'contacts') {
          void loadBackendContacts($('#contactsSearchInput')?.value || '', 200);
        } else {
          void loadBackendContacts('', 200);
        }
        if (state.searchQuery.trim()) {
          void searchAgendaContactsForSidebar(state.searchQuery);
        }
      },
      onConversationUpdated(convPayload) {
        const mapped = mapBackendConversation(convPayload);
        const idx = state.conversations.findIndex((c) => c.id === mapped.id);
        if (idx >= 0) {
          mapped.messages = state.conversations[idx].messages;
          mapped._messagesLoaded = state.conversations[idx]._messagesLoaded;
          state.conversations[idx] = mapped;
        } else {
          state.conversations.unshift(mapped);
          if (!state.selectedConvId) state.selectedConvId = mapped.id;
        }
        if (state.view === 'conversations') renderConversations();
        else updateGlobalCounts();
      },
      onConversationPresence(payload) {
        if (!payload?.conversationId) return;
        const timeoutMs =
          typeof payload.expiresInMs === 'number' && payload.expiresInMs > 0
            ? payload.expiresInMs + 1000
            : FRONTEND_PRESENCE_SAFETY_MS;
        setConversationPresence(payload.conversationId, payload.status || null, timeoutMs);
      },
      onMessageCreated(payload) {
        const conv = state.conversations.find((c) => c.id === payload.conversationId);
        const mappedMsg = mapBackendMessage(payload.message);
        if (mappedMsg.type === 'incoming' && payload.conversationId) {
          setConversationPresence(payload.conversationId, null);
        }
        if (conv) {
          const alreadyExists = conv.messages.some(
            (m) => m.id === mappedMsg.id || (mappedMsg.externalId && m.externalId === mappedMsg.externalId)
          );
          if (!alreadyExists) {
            conv.messages.push(mappedMsg);
          }
          conv.updatedAt = mappedMsg.time;
          conv.lastMessageTs = Date.now();
          if (mappedMsg.type === 'incoming') {
            if (state.selectedConvId !== conv.id || state.view !== 'conversations') {
              conv.unread = (conv.unread || 0) + 1;
            }
            pushNotification({
              category: 'ticket',
              title: `${conv.ticketNumber || 'Nova mensagem'} • ${conv.contact.name}`,
              message: mappedMsg.text.slice(0, 90),
              convId: conv.id,
            });
          }
          if (state.view === 'conversations') renderConversations();
          else updateGlobalCounts();
        } else {
          void loadBackendConversations(false);
        }
      },
      onMessageStatus(payload) {
        const conv = state.conversations.find((c) => c.id === payload.conversationId);
        if (!conv) return;
        const msg = conv.messages.find((m) => m.id === payload.messageId);
        if (msg) {
          msg.deliveryStatus = payload.deliveryStatus;
          if (state.selectedConvId === conv.id) renderActiveChat();
        }
      },
    });
  }

  // ========================================================================
  // NAVEGAÇÃO TOPBAR
  // ========================================================================
  function setView(viewName) {
    if (viewName === 'users' && !isCurrentUserAdmin()) {
      toast('Acesso restrito ao perfil Administrador.');
      viewName = 'conversations';
    }
    state.view = viewName;
    $$('.view-panel').forEach((p) => p.classList.remove('active'));
    const panel = $(`#view-${viewName}`);
    if (panel) panel.classList.add('active');

    $$('.top-icon-btn[data-view]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === viewName);
    });

    if (viewName === 'conversations') renderConversations();
    if (viewName === 'connections') {
      state.connSubView = 'list';
      renderConnections();
    }
    if (viewName === 'contacts') {
      renderContacts();
      if (state.apiConnected) {
        void loadBackendContacts($('#contactsSearchInput')?.value || '', 200);
      }
    }
    if (viewName === 'reports') renderReports();
    if (viewName === 'users') {
      renderUsers();
      if (state.apiConnected) {
        void loadBackendUsers();
      }
    }
  }

  function updateGlobalCounts() {
    const totalUnread = state.conversations
      .filter((c) => c.status === 'open')
      .reduce((acc, c) => acc + (c.unread || 0), 0);
    const topBadge = $('#topUnreadBadge');
    topBadge.textContent = totalUnread;
    topBadge.classList.toggle('hidden', totalUnread === 0);

    const pool = state.conversations.filter((c) => state.statusFilter === 'all' || c.status === state.statusFilter);
    $('#countMine').textContent = pool.filter((c) => c.assignee === DATA.currentAgent.id).length;
    $('#countQueue').textContent = pool.filter((c) => c.assignee === 'queue').length;
  }

  // ========================================================================
  // VIEW 1: CONVERSAS
  // ========================================================================
  function getFilteredConversations() {
    const filtered = state.conversations.filter((c) => {
      if (state.statusFilter !== 'all' && c.status !== state.statusFilter) return false;
      if (state.tab === 'mine' && c.assignee !== DATA.currentAgent.id) return false;
      if (state.tab === 'queue' && c.assignee !== 'queue') return false;

      if (state.searchQuery.trim()) {
        const q = state.searchQuery.toLowerCase();
        const match =
          c.contact.name.toLowerCase().includes(q) ||
          c.contact.phone.toLowerCase().includes(q) ||
          c.connection.toLowerCase().includes(q) ||
          c.department.toLowerCase().includes(q) ||
          (c.ticketNumber || '').toLowerCase().includes(q);
        if (!match) return false;
      }
      return true;
    });

    return [...filtered].sort((a, b) => {
      if (state.convSort === 'oldest_first') return (a.createdTs || 0) - (b.createdTs || 0);
      if (state.convSort === 'newest_first') return (b.createdTs || 0) - (a.createdTs || 0);
      if (state.convSort === 'longest_wait') return (b.waitMinutes || 0) - (a.waitMinutes || 0);
      if (state.convSort === 'shortest_wait') return (a.waitMinutes || 0) - (b.waitMinutes || 0);
      return (b.lastMessageTs || 0) - (a.lastMessageTs || 0);
    });
  }

  function renderAvatarInner(contact) {
    const initials = escapeHtml(contact?.initials || 'CT');
    if (contact?.avatarUrl) {
      return `<img class="avatar-img" src="${escapeHtml(contact.avatarUrl)}" alt="${escapeHtml(contact.name || '')}" loading="lazy" onerror="this.style.display='none';if(this.nextElementSibling)this.nextElementSibling.style.display='inline';" /><span style="display:none">${initials}</span>`;
    }
    return `<span>${initials}</span>`;
  }

  function renderConversations() {
    updateGlobalCounts();

    $$('.pill-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
    $('#statusFilter').value = state.statusFilter;

    const listEl = $('#conversationList');
    const list = getFilteredConversations();
    const isSearching = Boolean(state.searchQuery.trim());

    const renderConvCard = (c) => {
      const presenceStatus = state.conversationPresences[c.id] || null;
      const presenceLabel = formatPresenceLabel(presenceStatus);
      const preview = presenceLabel || getConversationPreviewText(c);
      return `
        <div class="conv-row ${c.id === state.selectedConvId ? 'active' : ''}" data-conv-id="${c.id}">
          <div class="avatar md">
            ${renderAvatarInner(c.contact)}
            <span class="ch-dot ${channelBadgeClass(c.channel)}" title="${escapeHtml(c.channel)}">${channelMiniGlyph(c.channel)}</span>
          </div>
          <div class="conv-row-body">
            <div class="conv-row-top">
              <span class="conv-row-name">${escapeHtml(c.contact.name)}</span>
              <span class="conv-row-time">${escapeHtml(c.updatedAt)}</span>
            </div>
            <div class="conv-ticket-tag">${escapeHtml(c.ticketNumber || '')}</div>
            <div class="conv-row-bottom">
              <span class="conv-row-preview ${presenceLabel ? 'is-presence' : ''}">${escapeHtml(preview)}</span>
              ${c.unread > 0 ? `<span class="unread-dot">${c.unread}</span>` : ''}
            </div>
          </div>
        </div>
      `;
    };

    if (isSearching) {
      const shownContactIds = new Set(list.map((c) => c.contact?.id).filter(Boolean));
      const agendaContacts = (state.contactSearchResults || []).filter(
        (ct) => !shownContactIds.has(ct.id)
      );

      const convSectionHtml = `
        <div class="conv-section-header">
          <span>Conversas</span>
          <span class="conv-section-count">${list.length}</span>
        </div>
        ${
          list.length > 0
            ? list.map(renderConvCard).join('')
            : `<div class="conv-section-empty">Nenhuma conversa aberta corresponde à busca.</div>`
        }
      `;

      const agendaSectionHtml = `
        <div class="conv-section-header">
          <span>Contatos da Agenda</span>
          <span class="conv-section-count">${state.contactSearchLoading ? '...' : agendaContacts.length}</span>
        </div>
        ${
          state.contactSearchLoading && agendaContacts.length === 0
            ? `<div class="conv-section-empty">Buscando na agenda...</div>`
            : agendaContacts.length > 0
              ? agendaContacts
                  .map(
                    (ct) => `
                      <div class="conv-row agenda-row" data-agenda-contact-id="${escapeHtml(ct.id)}">
                        <div class="avatar md">
                          ${renderAvatarInner(ct)}
                          <span class="ch-dot wa" title="WhatsApp">W</span>
                        </div>
                        <div class="conv-row-body">
                          <div class="conv-row-top">
                            <span class="conv-row-name">${escapeHtml(ct.name)}</span>
                            <span class="agenda-action-chip">Conversar</span>
                          </div>
                          <div class="conv-row-bottom">
                            <span class="conv-row-preview">${escapeHtml(ct.phone || 'WhatsApp')}${ct.connection && ct.connection !== '-' ? ' • ' + escapeHtml(ct.connection) : ''}</span>
                          </div>
                        </div>
                      </div>
                    `
                  )
                  .join('')
              : `<div class="conv-section-empty">Nenhum outro contato encontrado na agenda.</div>`
        }
      `;

      listEl.innerHTML = convSectionHtml + agendaSectionHtml;
    } else if (list.length === 0) {
      listEl.innerHTML = `<div style="padding:36px 14px;text-align:center;color:var(--text-muted);font-size:12.5px;">Nenhuma conversa nesta aba.</div>`;
    } else {
      listEl.innerHTML = list.map(renderConvCard).join('');
    }

    $$('.conv-row[data-conv-id]').forEach((row) => {
      row.addEventListener('click', () => {
        const rawId = row.dataset.convId;
        const matched = state.conversations.find((c) => String(c.id) === String(rawId));
        state.selectedConvId = matched ? matched.id : Number(rawId);
        const selected = getSelectedConv();
        const hadUnread = Boolean(selected && selected.unread > 0);
        if (selected) {
          selected.unread = 0;
        }

        // UI otimista: renderiza imediatamente o que já está em memória (<16ms)
        renderConversations();

        // Sincronização silenciosa em segundo plano sem travar a troca de chat
        if (selected && state.apiConnected && selected.isRemote) {
          ensurePresenceSubscribed(selected);
          if (hadUnread) {
            void API.markConversationRead(selected.id).catch(() => {});
          }
          const isStale = Date.now() - (selected._messagesFetchedAt || 0) > 15000;
          if (!selected._messagesLoaded || !state.socketConnected || isStale) {
            void loadMessagesForConversation(selected.id, {
              silent: Boolean(selected._messagesLoaded),
            });
          }
        }
      });
    });

    $$('.agenda-row[data-agenda-contact-id]').forEach((row) => {
      row.addEventListener('click', () => {
        const contactId = row.dataset.agendaContactId;
        const contact = state.contactSearchResults.find((x) => String(x.id) === String(contactId));
        if (contact) void openConversationForContact(contact);
      });
    });

    renderActiveChat();
  }

  function renderActiveChat() {
    const conv = getSelectedConv();
    if (!conv) {
      $('#chatAvatar').innerHTML = '';
      $('#chatCustomerName').textContent = 'Selecione uma conversa';
      $('#chatHeaderPills').innerHTML = '';
      renderActiveChatPresence(null);
      $('#detailsDrawer')?.classList.add('hidden');
      $('#chatMessages').innerHTML =
        '<div class="empty-hint" style="margin:auto;text-align:center;">Conecte um WhatsApp via QR Code em <strong>Conexões → + Adicionar</strong> ou selecione um chamado ao lado.</div>';
      return;
    }

    $('#chatAvatar').innerHTML = `
      ${renderAvatarInner(conv.contact)}
      <span class="ch-dot ${channelBadgeClass(conv.channel)}">${channelMiniGlyph(conv.channel)}</span>
    `;
    $('#chatCustomerName').textContent = conv.contact.name;
    renderActiveChatPresence(conv);
    if (conv.isRemote) ensurePresenceSubscribed(conv);

    const agObj = DATA.agents.find((a) => a.id === conv.assignee);
    const agLabel = conv.assignee === 'queue' ? 'Na Fila' : agObj ? agObj.name.replace(' (Você)', '') : 'Sem atendente';

    $('#chatHeaderPills').innerHTML = `
      <span class="header-pill ticket">${escapeHtml(conv.ticketNumber || '')}</span>
      <span class="header-pill connection">${escapeHtml(conv.connection)}</span>
      <span class="header-pill dept">${escapeHtml(conv.department)}</span>
      <span class="header-pill agent">${escapeHtml(agLabel)}</span>
    `;

    // Botão Finalizar / Reabrir
    const btnRes = $('#btnResolveToggle');
    if (conv.status === 'resolved') {
      btnRes.className = 'btn-resolve reopen';
      btnRes.innerHTML = '<span>↺ Reabrir</span>';
    } else {
      btnRes.className = 'btn-resolve';
      btnRes.innerHTML =
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg><span>Finalizar</span>';
    }

    // Mensagens (com suporte a busca interna e citação)
    const filterQ = state.inChatSearch.trim().toLowerCase();
    const msgs = filterQ
      ? conv.messages.filter((m) => (m.text || '').toLowerCase().includes(filterQ))
      : conv.messages;

    const canvas = $('#chatMessages');
    canvas.innerHTML = msgs
      .map((m) => {
        if (m.type === 'activity') {
          return `<div class="sys-pill">${escapeHtml(m.text)} • ${escapeHtml(m.time)}</div>`;
        }
        const quoteHtml = m.quote
          ? `<div class="quote-box"><div class="quote-author">${escapeHtml(m.quote.author)}</div><div>${escapeHtml(m.quote.text)}</div></div>`
          : '';
        const isOut = m.type === 'outgoing';
        const isPriv = m.type === 'private';

        let attachHtml = '';
        if (m.attachment) {
          const att = m.attachment;
          if (att.kind === 'image' && att.url) {
            attachHtml = `<img class="msg-attach-img" src="${escapeHtml(att.url)}" alt="${escapeHtml(att.name || 'Imagem')}" />`;
          } else if (att.kind === 'sticker') {
            attachHtml = att.url
              ? `<img class="msg-attach-img" style="max-width:130px;max-height:130px;" src="${escapeHtml(att.url)}" alt="Figurinha" />`
              : `<div class="msg-sticker-glyph">${escapeHtml(att.glyph || '🚀')}</div>`;
          } else if (att.kind === 'document') {
            attachHtml = `
              <div class="msg-attach-card">
                <div class="msg-attach-title">📄 ${escapeHtml(att.name)}</div>
                <div class="msg-attach-sub">${escapeHtml(att.size || 'Documento anexado')}</div>
              </div>
            `;
          } else if (att.kind === 'audio') {
            attachHtml = `
              <div class="msg-attach-card">
                <div class="msg-attach-title">🎧 ${escapeHtml(att.name || 'Mensagem de voz')}</div>
                <div class="msg-audio-bar">
                  <span>▶</span>
                  <div class="msg-audio-wave"><span></span></div>
                  <span class="msg-attach-sub">${escapeHtml(att.duration || '0:14')}</span>
                </div>
              </div>
            `;
          } else if (att.kind === 'contact') {
            attachHtml = `
              <div class="msg-attach-card">
                <div class="msg-attach-title">👤 ${escapeHtml(att.contactName)}</div>
                <div class="msg-attach-sub">${escapeHtml(att.contactPhone)}</div>
              </div>
            `;
          } else if (att.kind === 'poll') {
            attachHtml = `
              <div class="msg-attach-card">
                <div class="msg-attach-title">📊 ${escapeHtml(att.question)}</div>
                ${(att.options || [])
                .map((opt) => `<div class="msg-poll-opt"><span>○ ${escapeHtml(opt)}</span><span>0%</span></div>`)
                .join('')}
              </div>
            `;
          } else if (att.kind === 'pix') {
            attachHtml = `
              <div class="msg-attach-card">
                <div class="msg-attach-title">💠 Cobrança Pix • ${escapeHtml(att.amount)}</div>
                <div class="msg-attach-sub">Chave: ${escapeHtml(att.key)}</div>
                ${att.desc ? `<div class="msg-attach-sub">${escapeHtml(att.desc)}</div>` : ''}
              </div>
            `;
          } else if (att.kind === 'event') {
            attachHtml = `
              <div class="msg-attach-card">
                <div class="msg-attach-title">📅 ${escapeHtml(att.title)}</div>
                <div class="msg-attach-sub">${escapeHtml(att.when)}${att.location ? ' • ' + escapeHtml(att.location) : ''}</div>
              </div>
            `;
          }
        }

        return `<div class="msg-wrap ${m.type}"><div class="bubble"><div class="bubble-head"><span class="bubble-sender">${isPriv ? '🔒 ' : ''}${escapeHtml(m.sender)}</span><span class="bubble-time">${escapeHtml(m.time)}${isOut ? ' ✓✓' : ''}</span></div>${quoteHtml}${m.text ? `<div class="bubble-text">${escapeHtml(m.text)}</div>` : ''}${attachHtml}</div></div>`;
      })
      .join('');

    canvas.scrollTop = canvas.scrollHeight;
    renderDrawer(conv);
  }

  function renderDrawer(conv) {
    $('#contactProfileBox').innerHTML = `
      <div class="contact-top">
        <div class="avatar lg yellow-avatar">${renderAvatarInner(conv.contact)}</div>
        <div>
          <div class="contact-name">${escapeHtml(conv.contact.name)}</div>
          <div class="contact-sub">${escapeHtml(conv.contact.role)}</div>
        </div>
      </div>
      <div class="contact-meta">
        <span>📞 ${escapeHtml(conv.contact.phone)}</span>
        <span>✉️ ${escapeHtml(conv.contact.email)}</span>
      </div>
    `;

    $('#detailTicketNumber').textContent = conv.ticketNumber || 'Chamado';
    $('#selectAgent').innerHTML = DATA.agents
      .map((a) => `<option value="${a.id}" ${conv.assignee === a.id ? 'selected' : ''}>${a.name}</option>`)
      .join('');

    $('#selectDept').innerHTML = DATA.departments
      .map((d) => `<option value="${d}" ${conv.department === d ? 'selected' : ''}>${d}</option>`)
      .join('');

    $('#detailConnection').textContent = `${conv.connection} (${conv.channel})`;

    $('#labelsEditor').innerHTML = DATA.availableLabels
      .map(
        (lbl) => `
          <button type="button" class="tag-btn ${conv.labels.includes(lbl) ? 'active' : ''}" data-lbl="${lbl}">
            ${lbl}
          </button>
        `
      )
      .join('');

    $$('.tag-btn').forEach((b) => {
      b.onclick = () => {
        const lbl = b.dataset.lbl;
        const idx = conv.labels.indexOf(lbl);
        if (idx >= 0) conv.labels.splice(idx, 1);
        else conv.labels.push(lbl);
        renderConversations();
      };
    });
  }

  // ========================================================================
  // ENVIAR MENSAGENS & RESPOSTAS RÁPIDAS
  // ========================================================================
  async function sendMessage() {
    const input = $('#composerInput');
    const text = input.value.trim();
    if (!text) return;

    const conv = getSelectedConv();
    if (!conv) return;

    input.value = '';
    input.style.height = 'auto';
    hideCanned();

    if (state.apiConnected && conv.isRemote && API) {
      try {
        const visibility = state.privateMode ? 'PRIVATE_NOTE' : 'PUBLIC';
        const res = await API.sendTextMessage(conv.id, text, visibility);
        if (res?.message) {
          const mapped = mapBackendMessage(res.message);
          if (!conv.messages.some((m) => m.id === mapped.id)) {
            conv.messages.push(mapped);
          }
          conv.updatedAt = mapped.time;
          conv.lastMessageTs = Date.now();
          if (!state.privateMode && conv.assignee === 'queue') {
            conv.assignee = DATA.currentAgent.id;
          }
          renderConversations();
        }
      } catch (err) {
        input.value = text;
        toast(`❌ ${err.message || 'Falha ao enviar mensagem'}`);
      }
      return;
    }

    conv.messages.push({
      id: 'm_' + Date.now(),
      type: state.privateMode ? 'private' : 'outgoing',
      sender: DATA.currentAgent.name,
      text,
      time: nowTime(),
    });
    conv.updatedAt = nowTime();
    conv.lastMessageTs = Date.now();
    if (!state.privateMode) conv.waitMinutes = 0;

    if (!state.privateMode && conv.assignee === 'queue') {
      conv.assignee = DATA.currentAgent.id;
    }

    renderConversations();
  }

  function showCanned(query = '') {
    const q = query.replace(/^\//, '').toLowerCase();
    const list = DATA.cannedResponses.filter(
      (r) => r.code.includes(q) || r.title.toLowerCase().includes(q) || r.content.toLowerCase().includes(q)
    );
    if (list.length === 0) {
      hideCanned();
      return;
    }
    $('#cannedList').innerHTML = list
      .map(
        (r) => `
          <button type="button" class="canned-item" data-code="${r.code}">
            <span class="canned-code">${r.code} — ${escapeHtml(r.title)}</span>
            <span class="canned-text">${escapeHtml(r.content)}</span>
          </button>
        `
      )
      .join('');

    $$('.canned-item').forEach((btn) => {
      btn.onclick = () => {
        const chosen = DATA.cannedResponses.find((r) => r.code === btn.dataset.code);
        if (chosen) {
          $('#composerInput').value = chosen.content;
          $('#composerInput').focus();
          hideCanned();
        }
      };
    });

    $('#cannedPopover').classList.remove('hidden');
  }

  function hideCanned() {
    $('#cannedPopover').classList.add('hidden');
  }

  // ========================================================================
  // VIEW 2: CONEXÕES (ESTILO DIGISAC) + CATÁLOGO ADICIONAR CONEXÃO
  // ========================================================================
  const CONNECTION_CATALOG = [
    {
      channel: 'WhatsApp',
      title: 'WhatsApp',
      slug: 'whatsapp',
      placeholder: 'Ex: +55 11 99999-0000',
      iconSvg:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
    },
    {
      channel: 'WebChat',
      title: 'Webchat',
      slug: 'webchat',
      placeholder: 'Ex: WebChat • Site Oficial',
      iconSvg:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><circle cx="9" cy="10" r="1" fill="currentColor"/><circle cx="15" cy="10" r="1" fill="currentColor"/></svg>',
    },
    {
      channel: 'Telegram',
      title: 'Telegram',
      slug: 'telegram',
      placeholder: 'Ex: @smvsac_bot',
      iconSvg:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
    },
    {
      channel: 'WhatsApp Business API',
      title: 'WhatsApp Business API',
      slug: 'whatsapp-api',
      placeholder: 'Ex: +55 11 4000-1234 (Meta Cloud API)',
      iconSvg:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9"/><path d="M16 5h6"/><path d="M19 2v6"/></svg>',
    },
    {
      channel: 'Instagram',
      title: 'Instagram',
      slug: 'instagram',
      placeholder: 'Ex: @supermegavendas.oficial',
      iconSvg:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>',
    },
    {
      channel: 'Facebook Messenger',
      title: 'Facebook Messenger',
      slug: 'messenger',
      placeholder: 'Ex: Página Super MegaVendas',
      iconSvg:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5.1-1.3A10 10 0 1 0 12 2z"/><polyline points="8 14 11 10 13 12 16 9"/></svg>',
    },
    {
      channel: 'Email',
      title: 'Email',
      slug: 'email',
      placeholder: 'Ex: suporte@supermegavendas.com',
      iconSvg:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="22,6 12,13 2,6"/></svg>',
    },
    {
      channel: 'SMS',
      title: 'SMS',
      slug: 'sms',
      placeholder: 'Ex: Shortcode 28900 / Gateway SMS',
      iconSvg:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 10h8"/><path d="M8 13h5"/></svg>',
    },
    {
      channel: 'Reclame Aqui',
      title: 'Reclame Aqui',
      slug: 'reclame-aqui',
      placeholder: 'Ex: ID Empresa Reclame Aqui',
      iconSvg:
        '<svg viewBox="0 0 24 24" fill="none"><text x="12" y="16" text-anchor="middle" font-size="11.5" font-weight="800" fill="currentColor" font-family="Inter, sans-serif">RA</text></svg>',
    },
  ];

  function getChannelCatalogInfo(channel) {
    return (
      CONNECTION_CATALOG.find((item) => item.channel === channel) ||
      CONNECTION_CATALOG[0]
    );
  }

  function renderConnectionsCatalog() {
    const grid = $('#connCatalogGrid');
    grid.innerHTML = CONNECTION_CATALOG.map((item) => {
      const quota = state.connQuotas[item.channel] ?? 0;
      const used = state.connections.filter(
        (c) => c.status === 'active' && c.channel === item.channel
      ).length;
      const available = Math.max(0, quota - used);
      const isContracted = quota > 0;
      const isLimitReached = isContracted && available === 0;
      const canConfigure = isContracted && available > 0;

      let statusHtml = '';
      let descText = 'Contrate essa conexão para começar a usá-la.';
      if (isLimitReached) {
        statusHtml = `<span class="catalog-status limit"><i class="status-dot-sm"></i> Limite atingido</span>`;
        descText = 'Você atingiu o limite contratado desta conexão.';
      } else if (canConfigure) {
        statusHtml = `<span class="catalog-status available">${available} ${available === 1 ? 'disponível' : 'disponíveis'}</span>`;
        descText = 'Configure sua conta e comece a usar esta conexão.';
      }

      const iconClass = isContracted ? `catalog-icon active-${item.slug}` : 'catalog-icon';
      const cardStateClass = canConfigure ? 'available' : 'locked';

      return `
        <button type="button" class="catalog-card ${cardStateClass}" data-catalog-channel="${escapeHtml(item.channel)}">
          <div class="catalog-card-top">
            <span class="${iconClass}">${item.iconSvg}</span>
            ${statusHtml}
          </div>
          <div class="catalog-title">${escapeHtml(item.title)}</div>
          <p class="catalog-desc">${escapeHtml(descText)}</p>
        </button>
      `;
    }).join('');

    $$('[data-catalog-channel]').forEach((card) => {
      card.onclick = () => {
        const channel = card.dataset.catalogChannel;
        const quota = state.connQuotas[channel] ?? 0;
        const used = state.connections.filter(
          (c) => c.status === 'active' && c.channel === channel
        ).length;
        const available = Math.max(0, quota - used);

        if (quota > 0 && available > 0) {
          if (channel === 'WhatsApp') {
            void openWhatsAppQrModal(null);
          } else {
            openConnectionFormModal(null, channel);
          }
        } else {
          openUpgradeConnectionModal(channel, quota > 0);
        }
      };
    });
  }

  function openUpgradeConnectionModal(channel, isLimitReached) {
    state.upgradingChannel = channel;
    const item = getChannelCatalogInfo(channel);
    $('#upgradeConnTitle').textContent = isLimitReached
      ? `Limite atingido — ${item.title}`
      : `Contratar conexão — ${item.title}`;
    $('#upgradeConnMessage').innerHTML = isLimitReached
      ? `Você atingiu o limite atual contratado para <strong>${escapeHtml(item.title)}</strong>. Deseja liberar <strong>+1 vaga</strong> agora no plano para configurar uma nova conexão?`
      : `A conexão <strong>${escapeHtml(item.title)}</strong> ainda não está habilitada no seu plano atual. Deseja habilitar <strong>1 vaga</strong> no plano para configurar agora?`;
    $('#upgradeConnModal').classList.remove('hidden');
  }

  function renderConnections() {
    const isAddMode = state.connSubView === 'add';
    $('#connectionsListView').classList.toggle('hidden', isAddMode);
    $('#connectionsAddView').classList.toggle('hidden', !isAddMode);
    if (isAddMode) {
      renderConnectionsCatalog();
      return;
    }

    const activeTotal = state.connections.filter((c) => c.status === 'active').length;
    const archivedTotal = state.connections.filter((c) => c.status === 'archived').length;
    $('#connActiveCount').textContent = activeTotal;
    $('#connArchivedCount').textContent = archivedTotal;

    $$('.u-tab').forEach((t) => t.classList.toggle('active', t.dataset.connTab === state.connTab));

    const q = state.connSearch.trim().toLowerCase();
    const filtered = state.connections.filter((c) => {
      if (c.status !== state.connTab) return false;
      if (state.connChannel !== 'all' && c.channel !== state.connChannel) return false;
      if (q && !c.name.toLowerCase().includes(q) && !c.identifier.toLowerCase().includes(q)) return false;
      return true;
    });

    const getConnStatusMeta = (c) => {
      if (c.status === 'archived') return { cls: 'archived', label: 'Arquivada' };
      if (c.sessionState === 'qr') return { cls: 'restarting', label: 'Aguardando QR' };
      if (c.sessionState === 'connecting' || c.sessionState === 'restarting') return { cls: 'restarting', label: 'Conectando...' };
      if (c.sessionState === 'paused') return { cls: 'paused', label: 'Pausado' };
      if (c.sessionState === 'disconnected') return { cls: 'disconnected', label: 'Desconectado' };
      return { cls: '', label: 'Conectado' };
    };

    const grid = $('#connectionsGrid');
    if (filtered.length === 0) {
      grid.innerHTML = `<div style="grid-column:1/-1;padding:40px;text-align:center;color:var(--text-muted);">Nenhuma conexão encontrada.</div>`;
    } else {
      grid.innerHTML = filtered
        .map((c) => {
          const chInfo = getChannelCatalogInfo(c.channel);
          const cls = chInfo.slug;
          const icon = chInfo.iconSvg;
          const statusMeta = getConnStatusMeta(c);
          const isMenuOpen = state.openConnMenuId === c.id;
          const isPaused = c.sessionState === 'paused';
          const isDisconnected = c.sessionState === 'disconnected';
          return `
            <div class="conn-card ${isMenuOpen ? 'menu-open' : ''}">
              <div class="conn-card-head">
                <div class="conn-brand-row">
                  <div class="conn-circle ${cls}">${icon}</div>
                  <div style="min-width:0;">
                    <div class="conn-title">${escapeHtml(c.name)}</div>
                    <div class="conn-channel">${escapeHtml(c.channel)}</div>
                  </div>
                </div>
                <div class="conn-menu-wrap">
                  <button
                    type="button"
                    class="icon-btn conn-menu-trigger"
                    data-conn-menu-toggle="${c.id}"
                    title="Mais opções"
                    aria-haspopup="menu"
                    aria-expanded="${isMenuOpen ? 'true' : 'false'}"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <circle cx="12" cy="5" r="2" />
                      <circle cx="12" cy="12" r="2" />
                      <circle cx="12" cy="19" r="2" />
                    </svg>
                  </button>
                  <div class="conn-menu-dropdown ${isMenuOpen ? '' : 'hidden'}" role="menu">
                    <button type="button" class="conn-menu-item" data-conn-action="view" data-conn-id="${c.id}">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                      <span>Visualizar</span>
                    </button>
                    <button type="button" class="conn-menu-item" data-conn-action="events" data-conn-id="${c.id}">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>
                      <span>Histórico de eventos</span>
                    </button>
                    <button type="button" class="conn-menu-item" data-conn-action="edit" data-conn-id="${c.id}">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                      <span>Editar</span>
                    </button>
                    <button type="button" class="conn-menu-item" data-conn-action="archive" data-conn-id="${c.id}">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
                      <span>${c.status === 'active' ? 'Arquivar' : 'Reativar'}</span>
                    </button>

                    <div class="conn-menu-divider"></div>

                    ${
                      c.channel === 'WhatsApp'
                        ? `<button type="button" class="conn-menu-item" data-conn-action="sync-contacts" data-conn-id="${c.id}">
                             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 11a4 4 0 0 0-6-3.46"/><path d="M16 14.46A4 4 0 0 0 22 11"/></svg>
                             <span>Sincronizar Contatos</span>
                           </button>`
                        : ''
                    }

                    <button type="button" class="conn-menu-item" data-conn-action="restart" data-conn-id="${c.id}">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
                      <span>Reiniciar</span>
                    </button>
                    <button type="button" class="conn-menu-item" data-conn-action="pause" data-conn-id="${c.id}">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                      <span>${isPaused ? 'Retomar' : 'Pausar'}</span>
                    </button>
                    <button type="button" class="conn-menu-item" data-conn-action="disconnect" data-conn-id="${c.id}">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                      <span>${isDisconnected ? 'Reconectar' : 'Desconectar'}</span>
                    </button>

                    <div class="conn-menu-divider"></div>

                    <button type="button" class="conn-menu-item danger" data-conn-action="delete" data-conn-id="${c.id}">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                      <span>Excluir</span>
                    </button>
                  </div>
                </div>
              </div>
              <div class="conn-card-body">
                <div class="conn-meta-row">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                  <span>${escapeHtml(c.identifier)}</span>
                </div>
                <div class="conn-meta-row">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/></svg>
                  <span>${escapeHtml(c.bot)}</span>
                </div>
                <div class="conn-meta-row">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="9" y1="22" x2="9" y2="2"/></svg>
                  <span>${escapeHtml(c.department)}${c.ownerUserName ? ` • Resp.: ${escapeHtml(c.ownerUserName)}` : ''}</span>
                </div>
                <div class="conn-status-row">
                  <span class="status-pill ${statusMeta.cls}">
                    <i></i> ${statusMeta.label}
                  </span>
                  <div class="conn-actions-inline">
                    ${
                      c.channel === 'WhatsApp' && c.status === 'active' && c.sessionState === 'connected'
                        ? `<button class="conn-action-link" data-sync-contacts-conn="${escapeHtml(c.id)}">Sincronizar Contatos</button>`
                        : ''
                    }
                    ${
                      c.channel === 'WhatsApp' && c.status === 'active' && c.sessionState !== 'connected'
                        ? `<button class="conn-action-link" data-wa-qr-conn="${escapeHtml(c.id)}">Conectar QR Code →</button>`
                        : `<button class="conn-action-link" data-filter-conn="${escapeHtml(c.name)}">Ver fila →</button>`
                    }
                  </div>
                </div>
              </div>
            </div>
          `;
        })
        .join('');

      $$('[data-conn-menu-toggle]').forEach((btn) => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const id = btn.dataset.connMenuToggle;
          state.openConnMenuId = state.openConnMenuId === id ? null : id;
          renderConnections();
        };
      });

      $$('[data-conn-action]').forEach((btn) => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const action = btn.dataset.connAction;
          const id = btn.dataset.connId;
          state.openConnMenuId = null;
          handleConnectionAction(action, id);
        };
      });

      $$('[data-wa-qr-conn]').forEach((btn) => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const target = state.connections.find((x) => x.id === btn.dataset.waQrConn);
          if (target) void openWhatsAppQrModal(target);
        };
      });

      $$('[data-sync-contacts-conn]').forEach((btn) => {
        btn.onclick = (e) => {
          e.stopPropagation();
          void syncWhatsAppContacts(btn.dataset.syncContactsConn);
        };
      });

      $$('[data-filter-conn]').forEach((btn) => {
        btn.onclick = () => {
          state.tab = 'all';
          state.searchQuery = btn.dataset.filterConn;
          $('#convSearchInput').value = state.searchQuery;
          setView('conversations');
        };
      });
    }

    const totalInTab = state.connTab === 'active' ? activeTotal : archivedTotal;
    $('#connFooterCount').textContent = `Mostrando ${filtered.length} de ${totalInTab} resultados`;
  }

  function pushConnectionEvent(conn, title, tone = 'info') {
    if (!Array.isArray(conn.events)) conn.events = [];
    conn.events.unshift({
      title,
      actor: DATA.currentAgent.name || 'Operador',
      time: `Hoje às ${nowTime()}`,
      tone,
    });
  }

  function openConnectionFormModal(conn = null, presetChannel = null) {
    state.editingConnId = conn ? conn.id : null;
    const selectedChannel = conn ? conn.channel : presetChannel || 'WhatsApp';
    const chInfo = getChannelCatalogInfo(selectedChannel);
    $('#connModalTitle').textContent = conn
      ? 'Editar Conexão'
      : `Nova Conexão — ${chInfo.title}`;
    $('#btnSaveAddConn').textContent = conn ? 'Salvar alterações' : 'Salvar conexão';
    $('#newConnName').value = conn ? conn.name : '';
    $('#newConnChannel').value = selectedChannel;
    $('#newConnIdentifier').value = conn ? (conn.identifier === '-' ? '' : conn.identifier) : '';
    $('#newConnIdentifier').placeholder = chInfo.placeholder;
    $('#newConnBot').value = conn ? conn.bot : '-';
    $('#newConnDept').value = conn ? conn.department : 'Suporte';
    $('#addConnModal').classList.remove('hidden');
    setTimeout(() => $('#newConnName').focus(), 20);
  }

  function openViewConnectionModal(conn) {
    state.viewingConnId = conn.id;
    const statusLabel =
      conn.status === 'archived'
        ? 'Arquivada'
        : conn.sessionState === 'paused'
          ? 'Pausado'
          : conn.sessionState === 'disconnected'
            ? 'Desconectado'
            : conn.sessionState === 'restarting'
              ? 'Reiniciando...'
              : 'Conectado';

    $('#viewConnTitle').textContent = `Conexão — ${conn.name}`;
    $('#viewConnBody').innerHTML = `
      <div class="conn-detail-grid">
        <div class="conn-detail-item">
          <span>Nome</span>
          <strong>${escapeHtml(conn.name)}</strong>
        </div>
        <div class="conn-detail-item">
          <span>Canal</span>
          <strong>${escapeHtml(conn.channel)}</strong>
        </div>
        <div class="conn-detail-item full">
          <span>Identificador / Número</span>
          <strong>${escapeHtml(conn.identifier)}</strong>
        </div>
        <div class="conn-detail-item">
          <span>Departamento padrão</span>
          <strong>${escapeHtml(conn.department)}</strong>
        </div>
        <div class="conn-detail-item">
          <span>Bot vinculado</span>
          <strong>${escapeHtml(conn.bot)}</strong>
        </div>
        <div class="conn-detail-item">
          <span>Status atual</span>
          <strong>${escapeHtml(statusLabel)}</strong>
        </div>
        <div class="conn-detail-item">
          <span>ID da conexão</span>
          <strong>${escapeHtml(conn.id)}</strong>
        </div>
      </div>
    `;
    $('#viewConnModal').classList.remove('hidden');
  }

  function openEventsConnectionModal(conn) {
    $('#eventsConnTitle').textContent = 'Histórico de eventos';
    $('#eventsConnSubtitle').textContent = `${conn.name} • ${conn.channel} (${conn.identifier})`;
    const events = Array.isArray(conn.events) ? conn.events : [];
    $('#eventsConnList').innerHTML =
      events.length === 0
        ? `<div class="empty-hint">Nenhum evento registrado para esta conexão.</div>`
        : events
          .map(
            (ev) => `
                <div class="conn-event-row">
                  <span class="conn-event-dot ${escapeHtml(ev.tone || 'info')}"></span>
                  <div class="conn-event-content">
                    <div class="conn-event-title">${escapeHtml(ev.title)}</div>
                    <div class="conn-event-meta">${escapeHtml(ev.time)} • ${escapeHtml(ev.actor)}</div>
                  </div>
                </div>
              `
          )
          .join('');
    $('#eventsConnModal').classList.remove('hidden');
  }

  function openDeleteConnectionModal(conn) {
    state.deletingConnId = conn.id;
    $('#deleteConnMessage').innerHTML = `Tem certeza que deseja excluir permanentemente a conexão <strong>${escapeHtml(conn.name)}</strong> (${escapeHtml(conn.identifier)})? Esta ação não poderá ser desfeita.`;
    $('#deleteConnModal').classList.remove('hidden');
  }

  function handleConnectionAction(action, id) {
    const conn = state.connections.find((x) => x.id === id);
    if (!conn) return;

    if (action === 'view') {
      renderConnections();
      openViewConnectionModal(conn);
      return;
    }

    if (action === 'events') {
      renderConnections();
      openEventsConnectionModal(conn);
      return;
    }

    if (action === 'edit') {
      renderConnections();
      openConnectionFormModal(conn);
      return;
    }

    if (action === 'archive') {
      const nextAction = conn.status === 'active' ? 'archive' : 'activate';
      if (state.apiConnected && conn.isRemote) {
        void API.updateConnectionStatus(conn.id, nextAction).catch(() => { });
      }
      conn.status = conn.status === 'active' ? 'archived' : 'active';
      if (conn.status === 'archived') {
        conn.sessionState = 'disconnected';
        clearConversationsUIForConnection(conn.id, true);
      } else if (conn.status === 'active' && conn.sessionState === 'disconnected') {
        conn.sessionState = 'connected';
      }
      pushConnectionEvent(
        conn,
        conn.status === 'archived' ? 'Conexão arquivada' : 'Conexão reativada',
        conn.status === 'archived' ? 'warning' : 'success'
      );
      renderConnections();
      toast(conn.status === 'archived' ? `Conexão "${conn.name}" arquivada` : `Conexão "${conn.name}" reativada!`);
      return;
    }

    if (action === 'sync-contacts') {
      renderConnections();
      void syncWhatsAppContacts(conn.id);
      return;
    }

    if (action === 'restart') {
      if (conn.status === 'archived') conn.status = 'active';
      conn.sessionState = 'restarting';
      pushConnectionEvent(conn, 'Reinicialização da sessão solicitada', 'warning');
      renderConnections();
      toast(`Reiniciando conexão "${conn.name}"...`);
      if (state.apiConnected && conn.isRemote) {
        void API.restartConnection(conn.id).catch((err) => toast(`Erro ao reiniciar: ${err.message}`));
        return;
      }
      setTimeout(() => {
        const target = state.connections.find((x) => x.id === id);
        if (!target) return;
        target.sessionState = 'connected';
        pushConnectionEvent(target, 'Conexão reiniciada e sincronizada com sucesso', 'success');
        renderConnections();
        toast(`Conexão "${target.name}" reiniciada e conectada!`);
      }, 1100);
      return;
    }

    if (action === 'pause') {
      if (conn.sessionState === 'paused') {
        if (state.apiConnected && conn.isRemote) void API.updateConnectionStatus(conn.id, 'resume').catch(() => { });
        conn.sessionState = 'connected';
        pushConnectionEvent(conn, 'Atendimentos da conexão retomados', 'success');
        toast(`Conexão "${conn.name}" retomada!`);
      } else {
        if (state.apiConnected && conn.isRemote) void API.updateConnectionStatus(conn.id, 'pause').catch(() => { });
        conn.sessionState = 'paused';
        pushConnectionEvent(conn, 'Conexão pausada temporariamente', 'warning');
        pushNotification({
          category: 'alert',
          title: `Conexão pausada — ${conn.name}`,
          message: `A conexão ${conn.channel} (${conn.identifier}) foi pausada temporariamente.`,
          viewTarget: 'connections',
        });
        toast(`Conexão "${conn.name}" pausada`);
      }
      renderConnections();
      return;
    }

    if (action === 'disconnect') {
      if (conn.sessionState === 'disconnected') {
        if (state.apiConnected && conn.isRemote && conn.channel === 'WhatsApp') {
          void openWhatsAppQrModal(conn);
          return;
        }
        conn.sessionState = 'connected';
        pushConnectionEvent(conn, 'Sessão reconectada manualmente', 'success');
        toast(`Conexão "${conn.name}" reconectada!`);
      } else {
        if (state.apiConnected && conn.isRemote) void API.updateConnectionStatus(conn.id, 'disconnect').catch(() => { });
        conn.sessionState = 'disconnected';
        clearConversationsUIForConnection(conn.id, true);
        pushConnectionEvent(conn, 'Sessão desconectada manualmente', 'danger');
        pushNotification({
          category: 'alert',
          title: `Conexão desconectada — ${conn.name}`,
          message: `A sessão ${conn.channel} (${conn.identifier}) foi desconectada.`,
          viewTarget: 'connections',
        });
        toast(`Conexão "${conn.name}" desconectada`);
      }
      renderConnections();
      return;
    }

    if (action === 'delete') {
      renderConnections();
      openDeleteConnectionModal(conn);
    }
  }

  // ========================================================================
  // VIEW 3: CONTATOS
  // ========================================================================
  function getFilteredContacts() {
    const q = ($('#contactsSearchInput').value || '').trim().toLowerCase();
    const qDigits = q.replace(/\D/g, '');
    const source =
      state.apiConnected && state.contacts.length > 0
        ? state.contacts.map((ct) => ({
            id: ct.id,
            conversationId: ct.conversationId,
            connection: ct.connection || '-',
            connectionId: ct.connectionId || null,
            department: ct.department || 'Suporte',
            labels: [],
            contact: ct,
          }))
        : state.conversations.map((c) => ({
            id: c.contact.id || String(c.id),
            conversationId: c.id,
            connection: c.connection,
            connectionId: c.connectionId || null,
            department: c.department,
            labels: c.labels || [],
            contact: c.contact,
          }));

    return source.filter((item) => {
      if (state.contactsConnFilter !== 'all' && item.connection !== state.contactsConnFilter) return false;
      if (state.contactsDeptFilter !== 'all' && item.department !== state.contactsDeptFilter) return false;
      if (state.contactsLabelFilter !== 'all' && !(item.labels || []).includes(state.contactsLabelFilter)) return false;
      if (q) {
        const phoneDigits = (item.contact.phone || '').replace(/\D/g, '');
        const match =
          (item.contact.name || '').toLowerCase().includes(q) ||
          (item.contact.role || '').toLowerCase().includes(q) ||
          (item.contact.phone || '').toLowerCase().includes(q) ||
          (qDigits.length >= 2 && phoneDigits.includes(qDigits)) ||
          (item.contact.email || '').toLowerCase().includes(q) ||
          (item.connection || '').toLowerCase().includes(q);
        if (!match) return false;
      }
      return true;
    });
  }

  function renderContacts() {
    updateContactsCountBadge();
    const connSelect = $('#contactsConnFilter');
    const uniqueConns = [...new Set(state.connections.map((c) => c.name))];
    connSelect.innerHTML = [
      '<option value="all">Conexão: Todas</option>',
      ...uniqueConns.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`),
    ].join('');
    connSelect.value = uniqueConns.includes(state.contactsConnFilter) ? state.contactsConnFilter : 'all';

    const activeFiltersCount =
      (($('#contactsSearchInput').value || '').trim() ? 1 : 0) +
      (state.contactsConnFilter !== 'all' ? 1 : 0) +
      (state.contactsDeptFilter !== 'all' ? 1 : 0) +
      (state.contactsLabelFilter !== 'all' ? 1 : 0);

    const badge = $('#contactsFilterBadge');
    badge.textContent = activeFiltersCount;
    badge.classList.toggle('hidden', activeFiltersCount === 0);

    const list = getFilteredContacts();

    if (list.length === 0) {
      $('#contactsTableBody').innerHTML = `
        <tr>
          <td colspan="5" style="text-align:center;padding:36px 16px;color:var(--text-muted);">
            Nenhum contato encontrado com os filtros aplicados.
          </td>
        </tr>
      `;
      return;
    }

    $('#contactsTableBody').innerHTML = list
      .map(
        (c) => `
          <tr>
            <td>
              <div style="display:flex;align-items:center;gap:10px;">
                <div class="avatar xs yellow-avatar">${renderAvatarInner(c.contact)}</div>
                <div>
                  <div style="font-weight:600;">${escapeHtml(c.contact.name)}</div>
                  <div style="font-size:11.5px;color:var(--text-muted);">${escapeHtml(c.contact.role || 'WhatsApp')}</div>
                </div>
              </div>
            </td>
            <td>
              <div>${escapeHtml(c.contact.phone || 'WhatsApp')}</div>
              <div style="font-size:11.5px;color:var(--text-muted);">${escapeHtml(c.contact.email || '-')}</div>
            </td>
            <td><span class="header-pill connection">${escapeHtml(c.connection)}</span></td>
            <td>${escapeHtml(c.department)}</td>
            <td style="text-align:right;">
              <button class="btn secondary pill" style="padding:6px 13px;font-size:12px;" data-open-contact-chat="${escapeHtml(c.id)}">Abrir chat</button>
            </td>
          </tr>
        `
      )
      .join('');

    $$('[data-open-contact-chat]').forEach((btn) => {
      btn.onclick = () => {
        const targetId = btn.dataset.openContactChat;
        const item = list.find((x) => String(x.id) === String(targetId));
        if (item) {
          void openConversationForContact({
            ...item.contact,
            id: item.id,
            connectionId: item.connectionId,
            conversationId: item.conversationId,
          });
        }
      };
    });
  }

  // ========================================================================
  // VIEW 4: RELATÓRIOS
  // ========================================================================
  function renderReports() {
    const rep = DATA.reports[state.reportPeriod];

    $('#reportsKpiGrid').innerHTML = rep.kpis
      .map(
        (k) => `
          <div class="kpi-box ${k.accent ? 'accent' : ''}">
            <span class="kpi-label">${escapeHtml(k.label)}</span>
            <strong class="kpi-num">${escapeHtml(k.value)}</strong>
          </div>
        `
      )
      .join('');

    const maxVal = Math.max(...rep.series.map((s) => s.received)) * 1.15;
    const width = 500;
    const height = 205;
    const padL = 34;
    const padB = 26;
    const chartH = height - padB - 14;
    const groupW = (width - padL - 10) / rep.series.length;

    const bars = rep.series
      .map((s, i) => {
        const x = padL + i * groupW + groupW * 0.18;
        const bw = Math.min(20, groupW * 0.28);
        const h1 = (s.received / maxVal) * chartH;
        const h2 = (s.resolved / maxVal) * chartH;
        return `
          <g>
            <rect x="${x}" y="${14 + chartH - h1}" width="${bw}" height="${h1}" rx="4" fill="#FACC15"/>
            <rect x="${x + bw + 4}" y="${14 + chartH - h2}" width="${bw}" height="${h2}" rx="4" fill="#3F3F46"/>
            <text x="${x + bw + 2}" y="${height - 7}" text-anchor="middle" fill="#A1A1AE" font-size="11">${s.label}</text>
          </g>
        `;
      })
      .join('');

    $('#volumeChart').innerHTML = `
      <svg viewBox="0 0 ${width} ${height}" width="100%" height="100%">
        <line x1="${padL}" y1="14" x2="${width - 8}" y2="14" stroke="#22222A" stroke-dasharray="3 3"/>
        <line x1="${padL}" y1="${14 + chartH * 0.5}" x2="${width - 8}" y2="${14 + chartH * 0.5}" stroke="#22222A" stroke-dasharray="3 3"/>
        <line x1="${padL}" y1="${14 + chartH}" x2="${width - 8}" y2="${14 + chartH}" stroke="#30303A"/>
        ${bars}
      </svg>
    `;

    $('#channelDistribution').innerHTML = rep.byConnection
      .map(
        (c) => `
          <div>
            <div class="bar-item-top">
              <span>${escapeHtml(c.name)}</span>
              <span style="color:var(--yellow-400)">${c.pct}%</span>
            </div>
            <div class="bar-track"><div class="bar-fill" style="width:${c.pct}%"></div></div>
          </div>
        `
      )
      .join('');
  }

  // ========================================================================
  // BUSCA RÁPIDA (CTRL + K)
  // ========================================================================
  function renderCommandBar(query = '') {
    const items = [
      { label: 'Ir para Conversas', cat: 'Tela', run: () => setView('conversations') },
      { label: 'Ir para Conexões', cat: 'Tela', run: () => setView('connections') },
      { label: 'Ir para Contatos', cat: 'Tela', run: () => setView('contacts') },
      { label: 'Ir para Relatórios', cat: 'Tela', run: () => setView('reports') },
      ...state.conversations.map((c) => ({
        label: `${c.contact.name} (${c.ticketNumber || ''})`,
        cat: c.connection,
        run: () => {
          state.selectedConvId = c.id;
          state.tab = 'all';
          setView('conversations');
        },
      })),
    ].filter((i) => i.label.toLowerCase().includes(query.toLowerCase()) || i.cat.toLowerCase().includes(query.toLowerCase()));

    $('#commandBarResults').innerHTML = items
      .slice(0, 8)
      .map(
        (i, idx) => `
          <button type="button" class="cb-item" data-idx="${idx}">
            <span>${escapeHtml(i.label)}</span>
            <span class="cb-cat">${escapeHtml(i.cat)}</span>
          </button>
        `
      )
      .join('');

    $$('.cb-item').forEach((btn, idx) => {
      btn.onclick = () => {
        $('#commandBarModal').classList.add('hidden');
        items[idx].run();
      };
    });
  }

  // ========================================================================
  // VIEW 5: USUÁRIOS (GESTÃO DE PERFIS ADMINISTRADOR E USER)
  // ========================================================================
  function getAvailableDepartmentsList() {
    if (Array.isArray(state.backendDepartments) && state.backendDepartments.length > 0) {
      return state.backendDepartments.map((d) => ({ id: d.id || null, name: d.name }));
    }
    return (DATA.departments || []).map((name) => ({ id: null, name }));
  }

  function populateUserDepartmentSelect(selectEl, selectedDeptId = '', selectedDeptName = '') {
    if (!selectEl) return;
    const depts = getAvailableDepartmentsList();
    const opts = ['<option value="">Sem setor específico</option>'];
    let matchedValue = '';

    depts.forEach((d) => {
      const isMatch =
        (selectedDeptId && d.id && String(d.id) === String(selectedDeptId)) ||
        (selectedDeptName && d.name.toLowerCase() === String(selectedDeptName).toLowerCase());
      if (isMatch) matchedValue = d.name;
      opts.push(
        `<option value="${escapeHtml(d.name)}" data-dept-id="${escapeHtml(d.id || '')}">${escapeHtml(d.name)}</option>`
      );
    });

    if (!matchedValue && selectedDeptName) {
      matchedValue = selectedDeptName;
      opts.push(
        `<option value="${escapeHtml(selectedDeptName)}" data-dept-id="${escapeHtml(selectedDeptId || '')}">${escapeHtml(selectedDeptName)}</option>`
      );
    }

    selectEl.innerHTML = opts.join('');
    selectEl.value = matchedValue;
  }

  function readSelectedDepartmentPayload(selectEl) {
    if (!selectEl) return { departmentId: null, departmentName: null };
    const selectedOption = selectEl.options[selectEl.selectedIndex];
    const departmentName = (selectEl.value || '').trim();
    const departmentId = (selectedOption?.dataset?.deptId || '').trim();
    return {
      departmentId: departmentId || null,
      departmentName: departmentName || null,
    };
  }

  function syncUsersDeptFilterOptions() {
    const filterEl = $('#usersDeptFilter');
    if (!filterEl) return;
    const prevValue = state.usersDeptFilter || 'all';
    const names = new Set(getAvailableDepartmentsList().map((d) => d.name));
    state.usersList.forEach((u) => {
      if (u.department) names.add(u.department);
    });
    const sortedNames = [...names].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    filterEl.innerHTML = [
      '<option value="all">Setor: Todos</option>',
      '<option value="__none__">Sem setor</option>',
      ...sortedNames.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`),
    ].join('');
    if ([...filterEl.options].some((o) => o.value === prevValue)) {
      filterEl.value = prevValue;
    } else {
      state.usersDeptFilter = 'all';
      filterEl.value = 'all';
    }
  }

  const INVALID_CORPORATE_DOMAIN_MSG =
    'Apenas e-mails com o domínio @supermegavendas.com são permitidos para cadastro.';

  function isAllowedCorporateEmail(rawEmail) {
    const normalized = String(rawEmail || '').trim().toLowerCase();
    const parts = normalized.split('@');
    if (parts.length !== 2) return false;
    return parts[0].length > 0 && parts[1] === 'supermegavendas.com';
  }

  function syncPendingUsersIndicators() {
    const pendingCount = state.usersList.filter(
      (u) => u.approvalStatus === 'PENDING' || u.isPendingApproval
    ).length;

    const navBadge = $('#navUsersPendingBadge');
    if (navBadge) {
      navBadge.textContent = pendingCount;
      navBadge.classList.toggle('hidden', pendingCount === 0);
    }

    const alertBox = $('#usersPendingAlert');
    const alertText = $('#usersPendingAlertText');
    if (alertBox && alertText) {
      if (pendingCount > 0) {
        alertText.innerHTML =
          pendingCount === 1
            ? '<strong>1 solicitação de cadastro</strong> aguardando aprovação do administrador.'
            : `<strong>${pendingCount} solicitações de cadastro</strong> aguardando aprovação do administrador.`;
        alertBox.classList.remove('hidden');
      } else {
        alertBox.classList.add('hidden');
      }
    }

    const approvalSelect = $('#usersApprovalFilter');
    if (approvalSelect) {
      const pendingOpt = approvalSelect.querySelector('option[value="PENDING"]');
      if (pendingOpt) {
        pendingOpt.textContent =
          pendingCount > 0 ? `Aguardando aprovação (${pendingCount})` : 'Aguardando aprovação';
      }
    }
  }

  async function loadBackendUsers() {
    if (!API?.getToken() || !isCurrentUserAdmin()) return;
    try {
      const data = await API.getUsers();
      state.usersList = Array.isArray(data.users) ? data.users : [];
      syncPendingUsersIndicators();
      if (state.view === 'users') renderUsers();
    } catch (err) {
      console.warn('[API] Falha ao carregar usuários:', err);
    }
  }

  function renderUsers() {
    const tbody = $('#usersTableBody');
    if (!tbody) return;

    const source = state.usersList;
    const badge = $('#usersTotalBadge');
    if (badge) {
      badge.textContent = source.length;
      badge.classList.toggle('hidden', source.length === 0);
    }

    syncPendingUsersIndicators();
    syncUsersDeptFilterOptions();

    const q = (state.usersSearch || '').trim().toLowerCase();
    const roleFilter = state.usersRoleFilter || 'all';
    const deptFilter = state.usersDeptFilter || 'all';
    const approvalFilter = state.usersApprovalFilter || 'all';

    const filtered = source.filter((u) => {
      const isPending = u.approvalStatus === 'PENDING' || Boolean(u.isPendingApproval);
      if (approvalFilter === 'PENDING' && !isPending) return false;
      if (approvalFilter === 'APPROVED' && isPending) return false;
      if (roleFilter !== 'all' && u.role !== roleFilter) return false;
      if (deptFilter === '__none__' && u.department) return false;
      if (deptFilter !== 'all' && deptFilter !== '__none__' && (u.department || '') !== deptFilter) return false;
      if (q) {
        const match =
          (u.name || '').toLowerCase().includes(q) ||
          (u.email || '').toLowerCase().includes(q) ||
          (u.department || '').toLowerCase().includes(q) ||
          (u.profileLabel || '').toLowerCase().includes(q) ||
          (isPending && 'aguardando aprovação pendente'.includes(q));
        if (!match) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" style="text-align:center;padding:36px 16px;color:var(--text-muted);">
            Nenhum usuário encontrado com os filtros aplicados.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = filtered
      .map((u) => {
        const isAdmin = u.role === 'ADMIN';
        const isPending = u.approvalStatus === 'PENDING' || Boolean(u.isPendingApproval);
        const isPrimary = Boolean(u.isPrimaryAdmin) || String(u.email || '').toLowerCase() === PRIMARY_ADMIN_EMAIL;
        const isSelf =
          (state.currentUser.id && u.id === state.currentUser.id) ||
          String(u.email || '').toLowerCase() === String(state.currentUser.email || '').toLowerCase();
        const parts = (u.name || 'US').trim().split(/\s+/);
        const initials = ((parts[0]?.[0] || 'U') + (parts[1]?.[0] || parts[0]?.[1] || 'S')).toUpperCase();
        const waCount = u.whatsappConnectionsCount || 0;
        const waSummary = isPending
          ? 'Acesso bloqueado'
          : waCount > 0
            ? `${waCount} WhatsApp${waCount > 1 ? 's' : ''}`
            : 'Pronto para parear QR';
        const statusLabel = isPending
          ? 'Aguardando aprovação'
          : u.availability === 'ONLINE'
            ? 'Online'
            : u.availability === 'BUSY'
              ? 'Ocupado'
              : 'Offline';
        const statusCls = isPending
          ? 'paused'
          : u.availability === 'ONLINE'
            ? ''
            : u.availability === 'BUSY'
              ? 'paused'
              : 'archived';

        const canMutate = !isPrimary && !isSelf;
        const isMenuOpen = state.openUserMenuId === u.id;
        const sectorHtml = u.department
          ? `<span class="sector-pill">${escapeHtml(u.department)}</span>`
          : `<span class="sector-pill empty">Sem setor</span>`;

        return `
          <tr class="user-row ${isPending ? 'is-pending' : ''} ${isMenuOpen ? 'menu-open' : ''}">
            <td>
              <div style="display:flex;align-items:center;gap:10px;">
                <div class="avatar xs ${isAdmin ? 'yellow-avatar' : ''}">${escapeHtml(initials)}</div>
                <div>
                  <div style="font-weight:600;display:flex;align-items:center;flex-wrap:wrap;gap:4px;">
                    <span>${escapeHtml(u.name)}</span>
                    ${isPending ? '<span class="pending-approval-pill">⏳ Aguardando aprovação</span>' : ''}
                    ${isPrimary ? '<span class="role-pill primary-badge">Admin principal</span>' : ''}
                    ${isSelf && !isPrimary ? '<span class="role-pill primary-badge">Você</span>' : ''}
                  </div>
                  <div style="font-size:11.5px;color:var(--text-muted);">${escapeHtml(u.email)}</div>
                </div>
              </div>
            </td>
            <td>${sectorHtml}</td>
            <td>
              <span class="role-pill ${isAdmin ? 'admin' : 'user'}">
                ${isAdmin ? '🛡️ Administrador' : '👤 User'}
              </span>
            </td>
            <td>
              <span class="header-pill connection">${escapeHtml(waSummary)}</span>
            </td>
            <td>
              <span class="status-pill ${statusCls}"><i></i> ${escapeHtml(statusLabel)}</span>
            </td>
            <td style="text-align:right;">
              <div class="user-actions-cell">
                ${
                  isPending
                    ? `
                      <button type="button" class="btn approve-outline pill sm-action" data-quick-approve-user="${escapeHtml(u.id)}" title="Aprovar acesso deste usuário">
                        ✓ Aceitar
                      </button>
                      <button type="button" class="btn danger-outline pill sm-action" data-quick-reject-user="${escapeHtml(u.id)}" title="Recusar solicitação de cadastro">
                        Recusar
                      </button>
                    `
                    : ''
                }
                <div class="user-menu-wrap">
                  <button
                    type="button"
                    class="conn-menu-trigger"
                    data-user-menu-toggle="${escapeHtml(u.id)}"
                    title="Opções do usuário"
                    aria-label="Opções de ${escapeHtml(u.name)}"
                    aria-haspopup="menu"
                    aria-expanded="${isMenuOpen ? 'true' : 'false'}"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <circle cx="12" cy="5" r="2" />
                      <circle cx="12" cy="12" r="2" />
                      <circle cx="12" cy="19" r="2" />
                    </svg>
                  </button>
                  <div class="conn-menu-dropdown user-menu-dropdown ${isMenuOpen ? '' : 'hidden'}" role="menu">
                    ${
                      isPending
                        ? `
                          <button type="button" class="conn-menu-item success" data-user-action="approve" data-user-id="${escapeHtml(u.id)}" role="menuitem">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                            <span>Aceitar (Aprovar)</span>
                          </button>
                          <button type="button" class="conn-menu-item danger" data-user-action="reject" data-user-id="${escapeHtml(u.id)}" role="menuitem">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                            <span>Recusar solicitação</span>
                          </button>
                          <div class="conn-menu-divider"></div>
                        `
                        : ''
                    }
                    <button type="button" class="conn-menu-item" data-user-action="edit" data-user-id="${escapeHtml(u.id)}" role="menuitem">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                      <span>Editar usuário</span>
                    </button>
                    <button type="button" class="conn-menu-item" data-user-action="reset-password" data-user-id="${escapeHtml(u.id)}" role="menuitem">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                      <span>Redefinir senha</span>
                    </button>
                    ${
                      canMutate && !isPending
                        ? `
                          <button type="button" class="conn-menu-item" data-user-action="toggle-role" data-user-id="${escapeHtml(u.id)}" data-next-role="${isAdmin ? 'USER' : 'ADMIN'}" role="menuitem">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                            <span>${isAdmin ? 'Tornar User' : 'Tornar Administrador'}</span>
                          </button>
                          <div class="conn-menu-divider"></div>
                          <button type="button" class="conn-menu-item danger" data-user-action="delete" data-user-id="${escapeHtml(u.id)}" role="menuitem">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                            <span>Remover usuário</span>
                          </button>
                        `
                        : ''
                    }
                  </div>
                </div>
              </div>
            </td>
          </tr>
        `;
      })
      .join('');

    $$('[data-quick-approve-user]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const target = source.find((x) => x.id === btn.dataset.quickApproveUser);
        if (target) openApproveUserModal(target);
      };
    });

    $$('[data-quick-reject-user]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const target = source.find((x) => x.id === btn.dataset.quickRejectUser);
        if (target) openRejectUserModal(target);
      };
    });

    $$('[data-user-menu-toggle]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const userId = btn.dataset.userMenuToggle;
        state.openUserMenuId = state.openUserMenuId === userId ? null : userId;
        renderUsers();
      };
    });

    $$('[data-user-action]').forEach((btn) => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const action = btn.dataset.userAction;
        const userId = btn.dataset.userId;
        const target = source.find((x) => x.id === userId);
        state.openUserMenuId = null;
        renderUsers();
        if (!target) return;

        if (action === 'approve') {
          openApproveUserModal(target);
          return;
        }

        if (action === 'reject') {
          openRejectUserModal(target);
          return;
        }

        if (action === 'edit') {
          openEditUserModal(target);
          return;
        }

        if (action === 'reset-password') {
          openResetUserPasswordModal(target);
          return;
        }

        if (action === 'toggle-role') {
          const nextRole = btn.dataset.nextRole;
          if (!API?.getToken()) {
            forceRedirectToLogin('Sua sessão expirou. Faça login novamente.');
            return;
          }
          try {
            const res = await API.updateUserRole(userId, nextRole);
            await loadBackendUsers();
            toast(res.message || 'Perfil atualizado com sucesso!');
          } catch (err) {
            toast(`❌ ${formatApiErrorMessage(err, 'Erro ao alterar perfil.')}`);
          }
          return;
        }

        if (action === 'delete') {
          state.deletingUserId = target.id;
          $('#deleteUserMessage').innerHTML = `Tem certeza que deseja remover o usuário <strong>${escapeHtml(target.name)}</strong> (${escapeHtml(target.email)})? Ele perderá o acesso imediatamente.`;
          $('#deleteUserModal').classList.remove('hidden');
        }
      };
    });
  }

  function openAddUserModal() {
    if (!isCurrentUserAdmin()) {
      toast('Apenas Administradores podem cadastrar novos usuários.');
      return;
    }
    $('#newUserName').value = '';
    $('#newUserEmail').value = '';
    $('#newUserRole').value = 'USER';
    populateUserDepartmentSelect($('#newUserDepartment'), '', '');
    $('#newUserPassword').value = '';
    $('#newUserPassword').type = 'password';
    $('#newUserError').classList.add('hidden');
    updatePasswordRulesUI('#newUserPasswordRules', '', false);
    $('#addUserModal').classList.remove('hidden');
    setTimeout(() => $('#newUserName').focus(), 20);
  }

  function closeAddUserModal() {
    $('#addUserModal')?.classList.add('hidden');
  }

  function openEditUserModal(user) {
    if (!isCurrentUserAdmin() || !user) return;
    const isPrimary = Boolean(user.isPrimaryAdmin) || String(user.email || '').toLowerCase() === PRIMARY_ADMIN_EMAIL;
    const isSelf =
      (state.currentUser.id && user.id === state.currentUser.id) ||
      String(user.email || '').toLowerCase() === String(state.currentUser.email || '').toLowerCase();

    state.editingUserId = user.id;
    $('#editUserModalSub').textContent = `Editando cadastro de ${user.name} (${user.email}).`;
    $('#editUserName').value = user.name || '';
    $('#editUserEmail').value = user.email || '';
    $('#editUserEmail').disabled = isPrimary;

    const emailHint = $('#editUserEmailHint');
    if (emailHint) {
      if (isPrimary) {
        emailHint.textContent = 'O e-mail do administrador principal é protegido e não pode ser alterado.';
        emailHint.classList.remove('hidden');
      } else {
        emailHint.classList.add('hidden');
      }
    }

    populateUserDepartmentSelect($('#editUserDepartment'), user.departmentId || '', user.department || '');

    const roleSelect = $('#editUserRole');
    roleSelect.value = user.role === 'ADMIN' ? 'ADMIN' : 'USER';
    roleSelect.disabled = isPrimary || isSelf;

    const roleHint = $('#editUserRoleHint');
    if (roleHint) {
      if (isPrimary) {
        roleHint.textContent = 'O administrador principal mantém sempre o perfil Administrador.';
        roleHint.classList.remove('hidden');
      } else if (isSelf) {
        roleHint.textContent = 'Você não pode alterar o seu próprio perfil de acesso.';
        roleHint.classList.remove('hidden');
      } else {
        roleHint.classList.add('hidden');
      }
    }

    $('#editUserError').classList.add('hidden');
    $('#editUserModal').classList.remove('hidden');
    setTimeout(() => $('#editUserName').focus(), 20);
  }

  function closeEditUserModal() {
    state.editingUserId = null;
    $('#editUserModal')?.classList.add('hidden');
  }

  function openResetUserPasswordModal(user) {
    if (!isCurrentUserAdmin() || !user) return;
    state.resetPwdUserId = user.id;
    $('#resetUserPwdSubtitle').textContent = `Defina uma nova senha de acesso para ${user.name} (${user.email}).`;
    $('#resetUserPassword').value = '';
    $('#resetUserPassword').type = 'password';
    $('#resetUserPasswordConfirm').value = '';
    $('#resetUserPasswordConfirm').type = 'password';
    $('#resetUserPwdError').classList.add('hidden');
    updatePasswordRulesUI('#resetUserPasswordRules', '', false);
    $('#resetUserPasswordModal').classList.remove('hidden');
    setTimeout(() => $('#resetUserPassword').focus(), 20);
  }

  function closeResetUserPasswordModal() {
    state.resetPwdUserId = null;
    $('#resetUserPasswordModal')?.classList.add('hidden');
  }

  function openApproveUserModal(user) {
    if (!isCurrentUserAdmin() || !user) return;
    state.approvingUserId = user.id;
    $('#approveUserSubtitle').textContent = `Aprovar solicitação de ${user.name} (${user.email}) e liberar acesso ao SMV Sac.`;
    populateUserDepartmentSelect($('#approveUserDepartment'), user.departmentId || '', user.department || '');
    $('#approveUserRole').value = user.role === 'ADMIN' ? 'ADMIN' : 'USER';
    $('#approveUserError').classList.add('hidden');
    $('#approveUserModal').classList.remove('hidden');
  }

  function closeApproveUserModal() {
    state.approvingUserId = null;
    $('#approveUserModal')?.classList.add('hidden');
  }

  function openRejectUserModal(user) {
    if (!isCurrentUserAdmin() || !user) return;
    state.rejectingUserId = user.id;
    $('#rejectUserMessage').innerHTML = `Tem certeza que deseja recusar e excluir a solicitação de cadastro de <strong>${escapeHtml(user.name)}</strong> (${escapeHtml(user.email)})? O solicitante não terá acesso ao sistema.`;
    $('#rejectUserModal').classList.remove('hidden');
  }

  function closeRejectUserModal() {
    state.rejectingUserId = null;
    $('#rejectUserModal')?.classList.add('hidden');
  }

  function closeDeleteUserModal() {
    state.deletingUserId = null;
    $('#deleteUserModal')?.classList.add('hidden');
  }

  // ========================================================================
  // BIND DE EVENTOS
  // ========================================================================
  function bindEvents() {
    $('#brandHomeBtn').addEventListener('click', () => setView('conversations'));

    $$('.top-icon-btn[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => setView(btn.dataset.view));
    });

    // Sincronização do perfil do usuário e disponibilidade
    const syncUserProfileUI = () => {
      const u = state.currentUser;
      const parts = (u.name || 'RA').trim().split(/\s+/);
      const initials = ((parts[0]?.[0] || 'S') + (parts[1]?.[0] || parts[0]?.[1] || 'M')).toUpperCase();
      DATA.currentAgent.name = u.name;
      DATA.currentAgent.initials = initials;
      const selfAgent = DATA.agents.find((a) => a.id === DATA.currentAgent.id);
      if (selfAgent) {
        selfAgent.name = `${u.name} (${u.roleCode === 'ADMIN' ? 'Administrador' : 'User'})`;
      }
      $('#agentAvatarInitials').textContent = initials;
      $('#profileMenuUserName').textContent = u.name;
      $('#btnCopySubdomain').textContent = u.subdomain;
      $('#aboutSubdomainVal').textContent = u.subdomain;
      syncRoleVisibilityUI();

      const st = AGENT_STATUSES[state.agentStatusIndex] || AGENT_STATUSES[0];
      $('#agentStatusDot').className = `status-dot ${st.key}`;
      $('#profileStatusDot').className = `profile-status-dot ${st.key}`;
      $('#profileStatusText').textContent = st.label;
    };

    const closeAccountModal = () => $('#accountModal').classList.add('hidden');
    const closeAboutModal = () => $('#aboutModal').classList.add('hidden');

    // Abrir submenu do usuário ao clicar nas iniciais
    $('#agentStatusToggle').addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = $('#userProfileMenu').classList.contains('hidden');
      closeTopbarPopovers();
      if (willOpen) {
        syncUserProfileUI();
        $('#userProfileMenu').classList.remove('hidden');
        $('#agentStatusToggle').setAttribute('aria-expanded', 'true');
      }
    });

    $('#userProfileMenu').addEventListener('click', (e) => e.stopPropagation());

    $('#btnProfileCycleStatus').addEventListener('click', () => {
      state.agentStatusIndex = (state.agentStatusIndex + 1) % AGENT_STATUSES.length;
      syncUserProfileUI();
      toast(`Status: ${AGENT_STATUSES[state.agentStatusIndex].label}`);
    });

    $('#btnCopySubdomain').addEventListener('click', () => {
      const sub = state.currentUser.subdomain || 'supermegavendas';
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(`${sub}.smvsac.com.br`).catch(() => { });
      }
      toast(`Subdomínio copiado: ${sub}`);
    });

    $('#btnProfileUsers')?.addEventListener('click', () => {
      closeTopbarPopovers();
      setView('users');
    });

    $('#btnProfileAccount').addEventListener('click', () => {
      closeTopbarPopovers();
      $('#accNameInput').value = state.currentUser.name;
      $('#accEmailInput').value = state.currentUser.email;
      $('#accRoleInput').value = state.currentUser.role;
      $('#accSubdomainInput').value = state.currentUser.subdomain;
      $('#accStatusSelect').value = AGENT_STATUSES[state.agentStatusIndex]?.key || 'online';
      $('#accountModal').classList.remove('hidden');
      setTimeout(() => $('#accNameInput').focus(), 20);
    });

    $('#btnCloseAccountModal').addEventListener('click', closeAccountModal);
    $('#btnCancelAccountModal').addEventListener('click', closeAccountModal);
    $('#accountModal').addEventListener('click', (e) => {
      if (e.target === $('#accountModal')) closeAccountModal();
    });
    $('#btnSaveAccountModal').addEventListener('click', () => {
      const name = $('#accNameInput').value.trim();
      const email = $('#accEmailInput').value.trim();
      const subdomain = $('#accSubdomainInput').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || 'supermegavendas';
      if (!name) {
        toast('Informe seu nome completo');
        return;
      }
      state.currentUser.name = name;
      if (email) state.currentUser.email = email;
      state.currentUser.subdomain = subdomain;
      const statusIdx = AGENT_STATUSES.findIndex((s) => s.key === $('#accStatusSelect').value);
      if (statusIdx >= 0) state.agentStatusIndex = statusIdx;
      syncUserProfileUI();
      closeAccountModal();
      toast('Dados da conta atualizados!');
    });

    $('#btnProfileAbout').addEventListener('click', () => {
      closeTopbarPopovers();
      syncUserProfileUI();
      $('#aboutModal').classList.remove('hidden');
    });
    $('#btnCloseAboutModal').addEventListener('click', closeAboutModal);
    $('#btnOkAboutModal').addEventListener('click', closeAboutModal);
    $('#aboutModal').addEventListener('click', (e) => {
      if (e.target === $('#aboutModal')) closeAboutModal();
    });
    $('#btnAboutOpenLgpd').addEventListener('click', () => {
      closeAboutModal();
      state.pendingUser = null;
      openLgpdModal();
    });

    $('#btnProfileLogout').addEventListener('click', () => {
      closeTopbarPopovers();
      $('#btnLogout').click();
    });

    // Conversas filtros & abas
    $$('.pill-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.tab = btn.dataset.tab;
        renderConversations();
      });
    });

    $('#statusFilter').addEventListener('change', (e) => {
      state.statusFilter = e.target.value;
      renderConversations();
    });

    $('#convSearchInput').addEventListener('input', (e) => {
      state.searchQuery = e.target.value;
      renderConversations();

      if (state.convSearchDebounceTimer) {
        clearTimeout(state.convSearchDebounceTimer);
      }
      const q = state.searchQuery.trim();
      if (!q) {
        state.contactSearchResults = [];
        state.contactSearchLoading = false;
        renderConversations();
        return;
      }
      state.convSearchDebounceTimer = setTimeout(() => {
        void searchAgendaContactsForSidebar(q);
      }, 150);
    });

    // Recolher / expandir lista de conversas
    const syncConvSidebar = () => {
      $('#convSidebar').classList.toggle('collapsed', state.convSidebarCollapsed);
      $('#btnExpandConvSidebar').classList.toggle('hidden', !state.convSidebarCollapsed);
    };
    $('#btnToggleConvSidebar').addEventListener('click', () => {
      state.convSidebarCollapsed = true;
      syncConvSidebar();
    });
    $('#btnExpandConvSidebar').addEventListener('click', () => {
      state.convSidebarCollapsed = false;
      syncConvSidebar();
    });

    // Menus + (Adicionar contato / grupo) e ⋮ (Ordenar por)
    const closeConvMenus = () => {
      $('#convAddMenu').classList.add('hidden');
      $('#convSortMenu').classList.add('hidden');
      $('#btnConvAddMenu').setAttribute('aria-expanded', 'false');
      $('#btnConvSortMenu').setAttribute('aria-expanded', 'false');
    };

    const populateConnOptions = (selectEl) => {
      const actives = state.connections.filter((c) => c.status === 'active');
      const source = actives.length > 0 ? actives : state.connections;
      selectEl.innerHTML = source
        .map((c) => `<option value="${escapeHtml(c.name)}" data-channel="${escapeHtml(c.channel)}">${escapeHtml(c.name)} (${escapeHtml(c.channel)})</option>`)
        .join('');
    };

    const closeAddContactConvModal = () => $('#addContactConvModal').classList.add('hidden');
    const closeAddGroupConvModal = () => $('#addGroupConvModal').classList.add('hidden');

    $('#btnConvAddMenu').addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = $('#convAddMenu').classList.contains('hidden');
      closeConvMenus();
      if (willOpen) {
        $('#convAddMenu').classList.remove('hidden');
        $('#btnConvAddMenu').setAttribute('aria-expanded', 'true');
      }
    });

    $('#btnConvSortMenu').addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = $('#convSortMenu').classList.contains('hidden');
      closeConvMenus();
      if (willOpen) {
        $('#convSortMenu').classList.remove('hidden');
        $('#btnConvSortMenu').setAttribute('aria-expanded', 'true');
      }
    });

    const btnActionNewConv = $('#btnActionNewConversation');
    if (btnActionNewConv) {
      btnActionNewConv.addEventListener('click', (e) => {
        e.stopPropagation();
        closeConvMenus();
        openNewConversationModal();
      });
    }

    const newConvModal = $('#newConversationModal');
    if (newConvModal) {
      $('#btnCloseNewConv')?.addEventListener('click', closeNewConversationModal);
      $('#btnCancelNewConv')?.addEventListener('click', closeNewConversationModal);
      newConvModal.addEventListener('click', (e) => {
        if (e.target === newConvModal) closeNewConversationModal();
      });
      $('#btnNewConvGoRegister')?.addEventListener('click', () => {
        closeNewConversationModal();
        $('#btnActionAddContact').click();
      });
      $('#newConvSearchInput')?.addEventListener('input', (e) => {
        const val = e.target.value;
        if (state.newConvDebounceTimer) clearTimeout(state.newConvDebounceTimer);
        state.newConvDebounceTimer = setTimeout(() => {
          void searchContactsForNewConvModal(val);
        }, 150);
      });
    }

    $('#btnActionAddContact').addEventListener('click', (e) => {
      e.stopPropagation();
      closeConvMenus();
      state.contactModalSource = 'conversations';
      populateConnOptions($('#newContactConvConn'));
      $('#newContactConvName').value = '';
      $('#newContactConvPhone').value = '';
      $('#newContactConvEmail').value = '';
      $('#newContactConvMsg').value = '';
      $('#addContactConvModal').classList.remove('hidden');
      setTimeout(() => $('#newContactConvName').focus(), 20);
    });

    $('#btnActionAddGroup').addEventListener('click', (e) => {
      e.stopPropagation();
      closeConvMenus();
      populateConnOptions($('#newGroupConvConn'));
      $('#newGroupConvName').value = '';
      $('#newGroupConvMembers').value = '';
      $('#newGroupConvMsg').value = '';
      $('#addGroupConvModal').classList.remove('hidden');
      setTimeout(() => $('#newGroupConvName').focus(), 20);
    });

    const SORT_LABELS = {
      last_message_desc: 'Mensagem mais recente',
      oldest_first: 'Mais antigos',
      newest_first: 'Mais recentes',
      longest_wait: 'Maior tempo de espera',
      shortest_wait: 'Menor tempo de espera',
    };

    $$('.conv-sort-item').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sortKey = btn.dataset.convSort;
        state.convSort = sortKey;
        $$('.conv-sort-item').forEach((item) => {
          const active = item.dataset.convSort === sortKey;
          item.classList.toggle('active', active);
          item.setAttribute('aria-checked', active ? 'true' : 'false');
        });
        closeConvMenus();
        renderConversations();
        toast(`Ordenado por: ${SORT_LABELS[sortKey] || sortKey}`);
      });
    });

    // Modal Adicionar Contato
    $('#btnCloseAddContactConv').addEventListener('click', closeAddContactConvModal);
    $('#btnCancelAddContactConv').addEventListener('click', closeAddContactConvModal);
    $('#addContactConvModal').addEventListener('click', (e) => {
      if (e.target === $('#addContactConvModal')) closeAddContactConvModal();
    });
    $('#btnSaveAddContactConv').addEventListener('click', async () => {
      const name = $('#newContactConvName').value.trim();
      const phone = $('#newContactConvPhone').value.trim();
      if (!name) {
        toast('Informe o nome do contato');
        return;
      }
      const connSelect = $('#newContactConvConn');
      const connName = connSelect.value || 'SUPER MEGAVENDAS';
      const channel = connSelect.selectedOptions?.[0]?.dataset?.channel || 'WhatsApp';
      const dept = $('#newContactConvDept').value || 'Suporte';
      const email = $('#newContactConvEmail').value.trim() || '-';
      const firstMsg = $('#newContactConvMsg').value.trim();

      // Se o back-end real estiver conectado, persiste o contato e inicia a conversa no Supabase
      if (state.apiConnected && API) {
        try {
          const matchedConn = state.connections.find((c) => c.name === connName);
          const matchedDept = (state.backendDepartments || []).find((d) => d.name === dept);
          const created = await API.createContact({
            name,
            phone: phone || undefined,
            email: email !== '-' ? email : '',
            connectionId: matchedConn?.id,
            departmentId: matchedDept?.id,
            startConversation: true,
          });
          closeAddContactConvModal();
          void loadBackendContacts('', 200);
          if (created?.conversation) {
            const mapped = mapBackendConversation(created.conversation);
            state.conversations.unshift(mapped);
            if (state.contactModalSource === 'contacts') {
              renderContacts();
              updateGlobalCounts();
              toast(`Contato "${name}" cadastrado com sucesso!`);
            } else {
              state.tab = 'all';
              state.statusFilter = 'open';
              state.selectedConvId = mapped.id;
              setView('conversations');
              if (firstMsg) {
                $('#composerInput').value = firstMsg;
              }
              setTimeout(() => $('#composerInput')?.focus(), 35);
              toast(`Contato "${name}" adicionado e conversa iniciada (${mapped.ticketNumber})!`);
            }
          } else {
            toast(`Contato "${name}" cadastrado com sucesso!`);
          }
          return;
        } catch (err) {
          toast(`Erro ao salvar contato: ${err.message}`);
          return;
        }
      }

      const fallbackMsg = firstMsg || 'Olá! Iniciando atendimento por aqui.';
      const parts = name.split(/\s+/);
      const initials = ((parts[0]?.[0] || 'C') + (parts[1]?.[0] || parts[0]?.[1] || 'T')).toUpperCase();
      const id = 600 + (Date.now() % 100000);
      const now = Date.now();

      state.conversations.unshift({
        id,
        ticketNumber: generateTicketNumber(),
        status: 'open',
        assignee: DATA.currentAgent.id,
        connection: connName,
        channel,
        department: dept,
        unread: 0,
        updatedAt: nowTime(),
        createdTs: now,
        lastMessageTs: now,
        waitMinutes: 0,
        labels: [dept],
        contact: {
          name,
          initials,
          role: `Contato • ${channel}`,
          phone: phone || 'Não informado',
          email,
        },
        summary: `Contato ${name} adicionado manualmente no departamento ${dept}.`,
        aiSuggestedReply: `Olá ${parts[0] || name}! Tudo bem? Como posso ajudar você hoje?`,
        autoCustomerReply: 'Olá! Recebi sua mensagem, obrigado pelo contato!',
        messages: [
          {
            id: 'c_' + now,
            type: 'outgoing',
            sender: DATA.currentAgent.name,
            text: fallbackMsg,
            time: nowTime(),
          },
        ],
      });

      state.tab = 'mine';
      state.statusFilter = 'open';
      state.selectedConvId = id;
      closeAddContactConvModal();
      if (state.contactModalSource === 'contacts') {
        renderContacts();
        updateGlobalCounts();
        toast(`Contato "${name}" cadastrado com sucesso!`);
      } else {
        renderConversations();
        setTimeout(() => $('#composerInput')?.focus(), 35);
        toast(`Contato "${name}" adicionado e conversa iniciada!`);
      }
    });

    // Modal Adicionar Grupo
    $('#btnCloseAddGroupConv').addEventListener('click', closeAddGroupConvModal);
    $('#btnCancelAddGroupConv').addEventListener('click', closeAddGroupConvModal);
    $('#addGroupConvModal').addEventListener('click', (e) => {
      if (e.target === $('#addGroupConvModal')) closeAddGroupConvModal();
    });
    $('#btnSaveAddGroupConv').addEventListener('click', () => {
      const groupName = $('#newGroupConvName').value.trim();
      const membersRaw = $('#newGroupConvMembers').value.trim();
      if (!groupName) {
        toast('Informe o nome do grupo');
        return;
      }
      const connSelect = $('#newGroupConvConn');
      const connName = connSelect.value || 'SUPER MEGAVENDAS';
      const channel = connSelect.selectedOptions?.[0]?.dataset?.channel || 'WhatsApp';
      const dept = $('#newGroupConvDept').value || 'Suporte';
      const welcomeMsg =
        $('#newGroupConvMsg').value.trim() ||
        `Grupo "${groupName}" criado com sucesso.`;
      const memberCount = membersRaw
        ? membersRaw.split(',').map((s) => s.trim()).filter(Boolean).length
        : 2;

      const id = 700 + Date.now() % 100000;
      const now = Date.now();

      state.conversations.unshift({
        id,
        ticketNumber: generateTicketNumber(),
        status: 'open',
        assignee: DATA.currentAgent.id,
        connection: connName,
        channel,
        department: dept,
        unread: 0,
        updatedAt: nowTime(),
        createdTs: now,
        lastMessageTs: now,
        waitMinutes: 0,
        labels: ['Suporte'],
        contact: {
          name: `Grupo: ${groupName}`,
          initials: 'GR',
          role: `Grupo (${memberCount} participantes) • ${channel}`,
          phone: membersRaw || `${memberCount} participantes`,
          email: '-',
        },
        summary: `Grupo "${groupName}" criado para atendimento colaborativo (${memberCount} participantes).`,
        aiSuggestedReply: `Olá pessoal do grupo ${groupName}! Estamos à disposição por aqui.`,
        autoCustomerReply: 'Perfeito! Todos no grupo receberam a mensagem.',
        messages: [
          {
            id: 'g_act_' + now,
            type: 'activity',
            text: `Grupo "${groupName}" criado por ${DATA.currentAgent.name}`,
            time: nowTime(),
          },
          {
            id: 'g_' + now,
            type: 'outgoing',
            sender: DATA.currentAgent.name,
            text: welcomeMsg,
            time: nowTime(),
          },
        ],
      });

      state.tab = 'mine';
      state.statusFilter = 'open';
      state.selectedConvId = id;
      closeAddGroupConvModal();
      renderConversations();
      toast(`Grupo "${groupName}" criado!`);
    });

    // Header do chat
    $('#btnSearchInChat').addEventListener('click', () => {
      $('#chatInlineSearch').classList.toggle('hidden');
      if (!$('#chatInlineSearch').classList.contains('hidden')) $('#inChatSearchInput').focus();
    });
    $('#btnCloseInChatSearch').addEventListener('click', () => {
      state.inChatSearch = '';
      $('#inChatSearchInput').value = '';
      $('#chatInlineSearch').classList.add('hidden');
      renderActiveChat();
    });
    $('#inChatSearchInput').addEventListener('input', (e) => {
      state.inChatSearch = e.target.value;
      renderActiveChat();
    });

    // Modal Transferir Chamado (para departamento e/ou atendente do mesmo domínio)
    const getDomainAgents = () => [...DATA.agents];

    const closeTransferModal = () => {
      $('#transferTicketModal').classList.add('hidden');
      $('#transferDeptError').classList.add('hidden');
      $('#transferDeptWrap').classList.remove('has-error');
    };

    const openTransferModal = () => {
      const conv = getSelectedConv();
      if (!conv) return;

      $('#transferTicketMeta').textContent = `${conv.ticketNumber || 'Chamado'} • ${conv.contact.name}`;

      // Popula departamentos
      $('#transferDeptSelect').innerHTML = [
        '<option value="">Selecione</option>',
        ...DATA.departments.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`),
      ].join('');
      $('#transferDeptSelect').value = '';
      $('#transferDeptError').classList.add('hidden');
      $('#transferDeptWrap').classList.remove('has-error');

      // Popula atendentes da rede do mesmo domínio
      const domainAgents = getDomainAgents();
      $('#transferAgentSelect').innerHTML = domainAgents
        .map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}</option>`)
        .join('');
      // Seleciona um colega da rede por padrão (ex.: Ozaniele) se disponível, ou Na Fila
      const defaultColleague = domainAgents.find((a) => a.id === 'ozaniele') || domainAgents[0];
      $('#transferAgentSelect').value = defaultColleague ? defaultColleague.id : 'queue';

      $('#transferCommentInput').value = '';
      $('#transferTicketModal').classList.remove('hidden');
      setTimeout(() => $('#transferDeptSelect').focus(), 20);
    };

    $('#btnTransferQuick').addEventListener('click', openTransferModal);
    $('#btnCancelTransfer').addEventListener('click', closeTransferModal);
    $('#transferTicketModal').addEventListener('click', (e) => {
      if (e.target === $('#transferTicketModal')) closeTransferModal();
    });

    $('#transferDeptSelect').addEventListener('change', () => {
      if ($('#transferDeptSelect').value) {
        $('#transferDeptError').classList.add('hidden');
        $('#transferDeptWrap').classList.remove('has-error');
      }
    });

    $('#btnSaveTransfer').addEventListener('click', () => {
      const conv = getSelectedConv();
      if (!conv) return;

      const dept = $('#transferDeptSelect').value;
      if (!dept) {
        $('#transferDeptError').classList.remove('hidden');
        $('#transferDeptWrap').classList.add('has-error');
        $('#transferDeptSelect').focus();
        return;
      }

      const targetAgentId = $('#transferAgentSelect').value || 'queue';
      const comment = $('#transferCommentInput').value.trim();
      const targetAgent =
        DATA.agents.find((a) => a.id === targetAgentId) || { id: 'queue', name: 'Fila do departamento' };

      conv.department = dept;
      conv.assignee = targetAgentId;
      conv.updatedAt = nowTime();
      conv.lastMessageTs = Date.now();

      const destLabel =
        targetAgentId === 'queue' ? `${dept} (Fila)` : `${targetAgent.name} (${dept})`;

      conv.messages.push({
        id: 'trf_' + Date.now(),
        type: 'activity',
        text: `${conv.ticketNumber || 'Chamado'} transferido para ${destLabel} por ${DATA.currentAgent.name}`,
        time: nowTime(),
      });

      if (comment) {
        conv.messages.push({
          id: 'trf_note_' + Date.now(),
          type: 'private',
          sender: `${DATA.currentAgent.name} (Transferência)`,
          text: comment,
          time: nowTime(),
        });
      }

      pushNotification({
        category: 'ticket',
        title: `${conv.ticketNumber || 'Chamado'} transferido`,
        message: `${conv.contact.name} encaminhado para ${destLabel}.`,
        convId: conv.id,
        silent: true,
      });

      if (state.apiConnected && conv.isRemote && API) {
        API.transferConversation(conv.id, {
          departmentName: dept,
          assigneeId: targetAgentId === 'queue' ? null : targetAgentId,
          comment: comment || undefined,
        }).catch((err) => toast(`Erro ao transferir no servidor: ${err.message}`));
      }

      closeTransferModal();
      renderConversations();
      toast(`${conv.ticketNumber || 'Chamado'} transferido para ${destLabel}!`);
    });

    $('#btnToggleDrawer').addEventListener('click', () => $('#detailsDrawer').classList.toggle('hidden'));
    $('#btnCloseDrawer').addEventListener('click', () => $('#detailsDrawer').classList.add('hidden'));

    $('#btnResolveToggle').addEventListener('click', () => {
      const conv = getSelectedConv();
      if (!conv) return;
      const nextStatus = conv.status === 'resolved' ? 'open' : 'resolved';
      conv.status = nextStatus;
      if (state.apiConnected && conv.isRemote && API) {
        API.updateConversationStatus(conv.id, nextStatus === 'resolved' ? 'RESOLVED' : 'OPEN').catch(() => { });
      }
      conv.messages.push({
        id: 'act_' + Date.now(),
        type: 'activity',
        text: conv.status === 'resolved' ? `Atendimento finalizado por ${DATA.currentAgent.name}` : `Atendimento reaberto por ${DATA.currentAgent.name}`,
        time: nowTime(),
      });
      renderConversations();
      toast(conv.status === 'resolved' ? 'Atendimento finalizado ✓' : 'Atendimento reaberto');
    });

    // Drawer selects
    $('#selectAgent').addEventListener('change', (e) => {
      getSelectedConv().assignee = e.target.value;
      renderConversations();
    });
    $('#selectDept').addEventListener('change', (e) => {
      getSelectedConv().department = e.target.value;
      renderConversations();
    });

    // Composer
    $('#btnSendMessage').addEventListener('click', sendMessage);
    $('#composerInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
      if (e.key === 'Escape') hideCanned();
    });
    $('#composerInput').addEventListener('input', (e) => {
      e.target.style.height = 'auto';
      e.target.style.height = Math.min(e.target.scrollHeight, 110) + 'px';
      if (e.target.value.startsWith('/')) showCanned(e.target.value);
      else hideCanned();
    });

    $('#btnCannedTrigger').addEventListener('click', () => {
      closeComposerPopovers('canned');
      if ($('#cannedPopover').classList.contains('hidden')) showCanned('');
      else hideCanned();
    });

    // ======================================================================
    // CLIPE (ANEXOS) & SELETOR DE EMOJIS NO COMPOSER
    // ======================================================================
    const EMOJI_BANK = {
      faces: ['😀', '😃', '😄', '😁', '😊', '😉', '😍', '🥰', '😎', '🤩', '🤔', '😅', '😂', '🙏', '🥳', '😌', '😮', '😢', '😡', '🤝', '🙌', '👏', '🤗', '🫡'],
      gestures: ['👍', '👎', '👌', '✌️', '🤞', '🤙', '👋', '🤚', '✋', '🖐️', '👉', '👈', '☝️', '👇', '💪', '✍️', '🫶', '🙏', '👏', '🤝', '🎉', '🔥', '⭐', '⚡'],
      business: ['🚀', '💼', '📱', '💻', '📞', '📧', '📅', '⏰', '📄', '📎', '📊', '📈', '💳', '💰', '🧾', '✅', '🔔', '🛠️', '🔒', '🌐', '🏷️', '📦', '🚗', '🏢'],
      symbols: ['❤️', '💛', '💚', '💙', '🖤', '✨', '⭐', '🔥', '⚡', '✅', '❌', '⚠️', 'ℹ️', '❓', '❗', '💯', '🎯', '📌', '📍', '🔗', '💬', '🎧', '🛡️', '🏆'],
    };

    const closeComposerPopovers = (except = null) => {
      if (except !== 'canned') hideCanned();
      if (except !== 'attach') {
        $('#attachPopover').classList.add('hidden');
        $('#btnAttachTrigger').setAttribute('aria-expanded', 'false');
      }
      if (except !== 'emoji') {
        $('#emojiPopover').classList.add('hidden');
        $('#btnEmojiTrigger').setAttribute('aria-expanded', 'false');
      }
    };

    const closeComposerActionModal = () => {
      state.composerActionType = null;
      $('#composerActionModal').classList.add('hidden');
    };

    const pushRichMessage = ({ text = '', attachment = null }) => {
      const conv = getSelectedConv();
      if (!conv) return;
      conv.messages.push({
        id: 'm_' + Date.now(),
        type: state.privateMode ? 'private' : 'outgoing',
        sender: DATA.currentAgent.name,
        text,
        attachment,
        time: nowTime(),
      });
      conv.updatedAt = nowTime();
      conv.lastMessageTs = Date.now();
      if (!state.privateMode) conv.waitMinutes = 0;
      if (!state.privateMode && conv.assignee === 'queue') {
        conv.assignee = DATA.currentAgent.id;
      }
      renderConversations();
    };

    const formatFileSize = (bytes) => {
      if (!bytes) return 'Arquivo anexado';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    const renderEmojiGrid = (cat = 'faces') => {
      state.emojiCat = cat;
      $$('.emoji-tab').forEach((t) => t.classList.toggle('active', t.dataset.emojiCat === cat));
      const list = EMOJI_BANK[cat] || EMOJI_BANK.faces;
      $('#emojiGrid').innerHTML = list
        .map((em) => `<button type="button" class="emoji-btn" data-emoji="${em}">${em}</button>`)
        .join('');
      $$('.emoji-btn').forEach((btn) => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const input = $('#composerInput');
          const em = btn.dataset.emoji;
          const start = input.selectionStart ?? input.value.length;
          const end = input.selectionEnd ?? input.value.length;
          input.value = input.value.slice(0, start) + em + input.value.slice(end);
          const nextPos = start + em.length;
          input.focus();
          try {
            input.setSelectionRange(nextPos, nextPos);
          } catch { }
        };
      });
    };

    $('#btnAttachTrigger').addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = $('#attachPopover').classList.contains('hidden');
      closeComposerPopovers();
      if (willOpen) {
        $('#attachPopover').classList.remove('hidden');
        $('#btnAttachTrigger').setAttribute('aria-expanded', 'true');
      }
    });

    $('#attachPopover').addEventListener('click', (e) => e.stopPropagation());

    $('#btnEmojiTrigger').addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = $('#emojiPopover').classList.contains('hidden');
      closeComposerPopovers();
      if (willOpen) {
        renderEmojiGrid(state.emojiCat);
        $('#emojiPopover').classList.remove('hidden');
        $('#btnEmojiTrigger').setAttribute('aria-expanded', 'true');
      }
    });

    $('#emojiPopover').addEventListener('click', (e) => e.stopPropagation());
    $$('.emoji-tab').forEach((tab) => {
      tab.addEventListener('click', (e) => {
        e.stopPropagation();
        renderEmojiGrid(tab.dataset.emojiCat);
      });
    });

    const openComposerActionModal = (type) => {
      state.composerActionType = type;
      const titleEl = $('#composerActionTitle');
      const bodyEl = $('#composerActionBody');
      const btnConfirm = $('#btnConfirmComposerAction');
      btnConfirm.textContent = 'Enviar na conversa';

      if (type === 'audio') {
        titleEl.textContent = 'Enviar Áudio';
        bodyEl.innerHTML = `
          <label>Título / descrição do áudio</label>
          <input type="text" id="actAudioLabel" class="field-input" value="Mensagem de voz" />
          <label>Ou selecione um arquivo de áudio do computador</label>
          <button type="button" class="btn secondary pill" id="btnPickAudioFile">Escolher arquivo de áudio (.mp3, .ogg, .wav)</button>
        `;
        $('#composerActionModal').classList.remove('hidden');
        $('#btnPickAudioFile').onclick = () => {
          closeComposerActionModal();
          $('#fileInputAudio').click();
        };
        return;
      }

      if (type === 'contact') {
        titleEl.textContent = 'Enviar Contato';
        const options = state.conversations
          .map((c) => `<option value="${escapeHtml(c.contact.name)}|${escapeHtml(c.contact.phone)}">${escapeHtml(c.contact.name)} (${escapeHtml(c.contact.phone)})</option>`)
          .join('');
        bodyEl.innerHTML = `
          <label>Escolher contato da base</label>
          <select id="actContactSelect" class="field-select">${options}</select>
        `;
      } else if (type === 'poll') {
        titleEl.textContent = 'Criar Enquete';
        bodyEl.innerHTML = `
          <label>Pergunta da enquete</label>
          <input type="text" id="actPollQuestion" class="field-input" placeholder="Ex: Qual o melhor horário para nossa reunião?" />
          <label>Opção 1</label>
          <input type="text" id="actPollOpt1" class="field-input" placeholder="Ex: Manhã (09h às 12h)" />
          <label>Opção 2</label>
          <input type="text" id="actPollOpt2" class="field-input" placeholder="Ex: Tarde (14h às 18h)" />
          <label>Opção 3 (opcional)</label>
          <input type="text" id="actPollOpt3" class="field-input" placeholder="Ex: Outro horário" />
        `;
      } else if (type === 'pix') {
        titleEl.textContent = 'Enviar Cobrança Pix';
        bodyEl.innerHTML = `
          <label>Chave Pix</label>
          <input type="text" id="actPixKey" class="field-input" value="financeiro@supermegavendas.com" />
          <label>Valor (R$)</label>
          <input type="text" id="actPixAmount" class="field-input" placeholder="Ex: R$ 299,00" value="R$ 299,00" />
          <label>Descrição (opcional)</label>
          <input type="text" id="actPixDesc" class="field-input" placeholder="Ex: Mensalidade SMV Sac" />
        `;
      } else if (type === 'event') {
        titleEl.textContent = 'Criar Evento';
        bodyEl.innerHTML = `
          <label>Título do evento</label>
          <input type="text" id="actEventTitle" class="field-input" placeholder="Ex: Reunião de Alinhamento SMV" />
          <label>Data e horário</label>
          <input type="text" id="actEventWhen" class="field-input" placeholder="Ex: Segunda-feira às 09:00" value="Segunda-feira às 09:00" />
          <label>Local ou link da sala (opcional)</label>
          <input type="text" id="actEventLoc" class="field-input" placeholder="Ex: Google Meet" />
        `;
      } else if (type === 'sticker') {
        titleEl.textContent = 'Nova Figurinha';
        state.selectedQuickSticker = '🚀';
        bodyEl.innerHTML = `
          <label>Escolha uma figurinha rápida do SMV Sac</label>
          <div class="sticker-quick-grid">
            <button type="button" class="sticker-quick-btn selected" data-quick-sticker="🚀">🚀<span>Foguete</span></button>
            <button type="button" class="sticker-quick-btn" data-quick-sticker="✅">✅<span>Feito</span></button>
            <button type="button" class="sticker-quick-btn" data-quick-sticker="🤝">🤝<span>Fechado</span></button>
            <button type="button" class="sticker-quick-btn" data-quick-sticker="🎉">🎉<span>Sucesso</span></button>
          </div>
          <label style="margin-top:10px;">Ou envie uma imagem do computador como figurinha</label>
          <button type="button" class="btn secondary pill" id="btnPickStickerFile">Carregar imagem (.png, .webp)</button>
        `;
        $('#composerActionModal').classList.remove('hidden');
        $$('[data-quick-sticker]').forEach((b) => {
          b.onclick = () => {
            state.selectedQuickSticker = b.dataset.quickSticker;
            $$('[data-quick-sticker]').forEach((x) => x.classList.toggle('selected', x === b));
          };
        });
        $('#btnPickStickerFile').onclick = () => {
          closeComposerActionModal();
          $('#fileInputSticker').click();
        };
        return;
      }

      $('#composerActionModal').classList.remove('hidden');
      const firstInput = bodyEl.querySelector('input, select');
      if (firstInput) setTimeout(() => firstInput.focus(), 20);
    };

    $$('[data-attach-type]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const type = btn.dataset.attachType;
        closeComposerPopovers();
        if (type === 'document') $('#fileInputDocument').click();
        else if (type === 'media') $('#fileInputMedia').click();
        else if (type === 'camera') $('#fileInputCamera').click();
        else openComposerActionModal(type);
      });
    });

    const sendRealFileIfRemote = async (file) => {
      const conv = getSelectedConv();
      if (!state.apiConnected || !conv?.isRemote || !API) return false;
      try {
        const res = await API.sendFileMessage(conv.id, file, '', state.privateMode ? 'PRIVATE_NOTE' : 'PUBLIC');
        if (res?.message) {
          const mapped = mapBackendMessage(res.message);
          if (!conv.messages.some((m) => m.id === mapped.id)) conv.messages.push(mapped);
          conv.updatedAt = mapped.time;
          conv.lastMessageTs = Date.now();
          renderConversations();
        }
        return true;
      } catch (err) {
        toast(`❌ Erro ao enviar arquivo pelo WhatsApp: ${err.message}`);
        return true;
      }
    };

    $('#fileInputDocument').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (!(await sendRealFileIfRemote(file))) {
        pushRichMessage({
          text: '',
          attachment: { kind: 'document', name: file.name, size: formatFileSize(file.size) },
        });
      }
      e.target.value = '';
      toast(`📄 Documento "${file.name}" enviado!`);
    });

    const handleMediaFile = async (e, label) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (!(await sendRealFileIfRemote(file))) {
        const isImage = file.type.startsWith('image/');
        if (isImage) {
          const url = URL.createObjectURL(file);
          pushRichMessage({ text: '', attachment: { kind: 'image', url, name: file.name } });
        } else {
          pushRichMessage({
            text: '',
            attachment: { kind: 'document', name: `🎬 ${file.name}`, size: formatFileSize(file.size) },
          });
        }
      }
      e.target.value = '';
      toast(`${label} "${file.name}" enviado!`);
    };

    $('#fileInputMedia').addEventListener('change', (e) => void handleMediaFile(e, '🖼️ Mídia'));
    $('#fileInputCamera').addEventListener('change', (e) => void handleMediaFile(e, '📷 Foto'));

    $('#fileInputAudio').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (!(await sendRealFileIfRemote(file))) {
        pushRichMessage({
          text: '',
          attachment: { kind: 'audio', name: file.name, duration: formatFileSize(file.size) },
        });
      }
      e.target.value = '';
      toast(`🎧 Áudio "${file.name}" enviado!`);
    });

    $('#fileInputSticker').addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const url = URL.createObjectURL(file);
      pushRichMessage({ text: '', attachment: { kind: 'sticker', url } });
      e.target.value = '';
      toast('Figurinha enviada!');
    });

    $('#btnCloseComposerAction').addEventListener('click', closeComposerActionModal);
    $('#btnCancelComposerAction').addEventListener('click', closeComposerActionModal);
    $('#composerActionModal').addEventListener('click', (e) => {
      if (e.target === $('#composerActionModal')) closeComposerActionModal();
    });

    $('#btnConfirmComposerAction').addEventListener('click', () => {
      const type = state.composerActionType;
      if (type === 'audio') {
        const label = $('#actAudioLabel')?.value.trim() || 'Mensagem de voz';
        pushRichMessage({ text: '', attachment: { kind: 'audio', name: label, duration: '0:14' } });
        toast('🎧 Áudio enviado!');
      } else if (type === 'contact') {
        const val = $('#actContactSelect')?.value || 'Contato|+55 11 99999-0000';
        const [contactName, contactPhone] = val.split('|');
        pushRichMessage({ text: '', attachment: { kind: 'contact', contactName, contactPhone } });
        toast(`👤 Contato "${contactName}" compartilhado!`);
      } else if (type === 'poll') {
        const question = $('#actPollQuestion')?.value.trim();
        const options = [$('#actPollOpt1')?.value.trim(), $('#actPollOpt2')?.value.trim(), $('#actPollOpt3')?.value.trim()].filter(Boolean);
        if (!question || options.length < 2) {
          toast('Informe a pergunta e pelo menos 2 opções da enquete');
          return;
        }
        pushRichMessage({ text: '', attachment: { kind: 'poll', question, options } });
        toast('📊 Enquete enviada!');
      } else if (type === 'pix') {
        const key = $('#actPixKey')?.value.trim();
        const amount = $('#actPixAmount')?.value.trim() || 'R$ 0,00';
        const desc = $('#actPixDesc')?.value.trim() || '';
        if (!key) {
          toast('Informe a chave Pix');
          return;
        }
        pushRichMessage({ text: '', attachment: { kind: 'pix', key, amount, desc } });
        toast('💠 Cobrança Pix enviada!');
      } else if (type === 'event') {
        const title = $('#actEventTitle')?.value.trim();
        const when = $('#actEventWhen')?.value.trim() || 'A combinar';
        const location = $('#actEventLoc')?.value.trim() || '';
        if (!title) {
          toast('Informe o título do evento');
          return;
        }
        pushRichMessage({ text: '', attachment: { kind: 'event', title, when, location } });
        toast('📅 Evento enviado!');
      } else if (type === 'sticker') {
        pushRichMessage({ text: '', attachment: { kind: 'sticker', glyph: state.selectedQuickSticker || '🚀' } });
        toast('Figurinha enviada!');
      }
      closeComposerActionModal();
    });

    $('#btnTogglePrivate').addEventListener('click', () => {
      state.privateMode = !state.privateMode;
      $('#btnTogglePrivate').classList.toggle('active', state.privateMode);
      $('#composerBar').classList.toggle('private-mode', state.privateMode);
      $('#privateModeTag').classList.toggle('hidden', !state.privateMode);
      $('#composerInput').placeholder = state.privateMode
        ? 'Escreva uma nota interna para a equipe...'
        : "Digite uma mensagem (ou '/' para respostas rápidas)...";
    });

    // Conexões
    $$('.u-tab').forEach((t) => {
      t.addEventListener('click', () => {
        state.connTab = t.dataset.connTab;
        renderConnections();
      });
    });
    $('#connSearchInput').addEventListener('input', (e) => {
      state.connSearch = e.target.value;
      renderConnections();
    });
    $('#connChannelFilter').addEventListener('change', (e) => {
      state.connChannel = e.target.value;
      renderConnections();
    });

    // Modal Adicionar / Editar Conexão
    const closeConnModal = () => {
      state.editingConnId = null;
      $('#addConnModal').classList.add('hidden');
    };
    const closeViewConnModal = () => {
      state.viewingConnId = null;
      $('#viewConnModal').classList.add('hidden');
    };
    const closeEventsConnModal = () => $('#eventsConnModal').classList.add('hidden');
    const closeDeleteConnModal = () => {
      state.deletingConnId = null;
      $('#deleteConnModal').classList.add('hidden');
    };
    const closeUpgradeConnModal = () => {
      state.upgradingChannel = null;
      $('#upgradeConnModal').classList.add('hidden');
    };

    $('#btnAddConnection').addEventListener('click', () => {
      state.openConnMenuId = null;
      state.connSubView = 'add';
      renderConnections();
    });
    $('#btnConnBackToList').addEventListener('click', () => {
      state.connSubView = 'list';
      renderConnections();
    });
    $('#btnConnBreadcrumbBack').addEventListener('click', () => {
      state.connSubView = 'list';
      renderConnections();
    });
    $('#newConnChannel').addEventListener('change', (e) => {
      const chInfo = getChannelCatalogInfo(e.target.value);
      $('#newConnIdentifier').placeholder = chInfo.placeholder;
    });
    $('#btnCloseUpgradeConn').addEventListener('click', closeUpgradeConnModal);
    $('#btnCancelUpgradeConn').addEventListener('click', closeUpgradeConnModal);
    $('#upgradeConnModal').addEventListener('click', (e) => {
      if (e.target === $('#upgradeConnModal')) closeUpgradeConnModal();
    });
    $('#btnConfirmUpgradeConn').addEventListener('click', () => {
      const channel = state.upgradingChannel;
      if (!channel) return;
      state.connQuotas[channel] = (state.connQuotas[channel] ?? 0) + 1;
      closeUpgradeConnModal();
      renderConnectionsCatalog();
      toast(`+1 vaga liberada para ${getChannelCatalogInfo(channel).title}!`);
      openConnectionFormModal(null, channel);
    });
    $('#btnCloseAddConn').addEventListener('click', closeConnModal);
    $('#btnCancelAddConn').addEventListener('click', closeConnModal);
    $('#addConnModal').addEventListener('click', (e) => {
      if (e.target === $('#addConnModal')) closeConnModal();
    });

    $('#btnSaveAddConn').addEventListener('click', async () => {
      const name = $('#newConnName').value.trim();
      if (!name) {
        toast('Informe o nome da conexão');
        return;
      }

      const channel = $('#newConnChannel').value;
      const rawIdentifier = $('#newConnIdentifier').value.trim();
      const identifier = rawIdentifier || '-';
      const bot = $('#newConnBot').value;
      const department = $('#newConnDept').value;
      const hasApiSession = Boolean(API && (state.apiConnected || API.getToken()));

      if (state.editingConnId) {
        const existing = state.connections.find((c) => c.id === state.editingConnId);
        if (existing) {
          if (hasApiSession && existing.isRemote) {
            try {
              await API.updateConnection(existing.id, {
                name,
                identifier: rawIdentifier || '',
                departmentName: department,
              });
            } catch (err) {
              toast(`❌ ${formatApiErrorMessage(err, 'Erro ao atualizar conexão.')}`);
              return;
            }
          }
          existing.name = name;
          existing.channel = channel;
          existing.identifier = identifier;
          existing.bot = bot;
          existing.department = department;
          pushConnectionEvent(existing, 'Configurações da conexão atualizadas', 'info');
          toast(`Conexão "${name}" atualizada!`);
        }
        closeConnModal();
        renderConnections();
        return;
      }

      // Criação real no back-end (para Admin e User) com abertura imediata do QR Code para WhatsApp
      if (!API?.getToken()) {
        closeConnModal();
        forceRedirectToLogin('Sua sessão expirou. Faça login novamente para criar conexões.');
        return;
      }

      const saveBtn = $('#btnSaveAddConn');
      saveBtn.disabled = true;
      const apiChannel =
        channel === 'WhatsApp' || channel === 'WhatsApp Business API'
          ? 'WHATSAPP'
          : channel === 'WebChat'
            ? 'WEBCHAT'
            : 'INSTAGRAM';
      const isBaileysWhatsApp = channel === 'WhatsApp';

      try {
        const res = await API.createConnection({
          name,
          channel: apiChannel,
          provider: isBaileysWhatsApp ? 'BAILEYS' : undefined,
          identifier: rawIdentifier || undefined,
          departmentName: department,
          autoStartQr: isBaileysWhatsApp,
        });
        const conn = res.connection;
        state.apiConnected = true;
        state.connections.unshift({ ...conn, isRemote: true, events: [] });
        state.connTab = 'active';
        state.connSubView = 'list';
        closeConnModal();
        renderConnections();

        if (isBaileysWhatsApp) {
          state.waQrConnectionId = conn.id;
          $('#waQrTitle').textContent = `Conectar WhatsApp — ${conn.name}`;
          $('#waQrSetupStep').classList.add('hidden');
          $('#waQrScanStep').classList.remove('hidden');
          $('#whatsappQrModal').classList.remove('hidden');
          updateWaQrModalState({
            status: conn.sessionState === 'qr' ? 'QR_PENDING' : 'CONNECTING',
            qrDataUrl: conn.qrDataUrl || null,
            identifier: conn.identifier,
          });
          startWaQrPolling(conn.id);
        } else {
          toast(`Conexão "${name}" criada com sucesso!`);
        }
      } catch (err) {
        toast(`❌ ${formatApiErrorMessage(err, 'Não foi possível criar a conexão.')}`);
      } finally {
        saveBtn.disabled = false;
      }
    });

    // Modal Visualizar Conexão
    $('#btnCloseViewConn').addEventListener('click', closeViewConnModal);
    $('#btnOkViewConn').addEventListener('click', closeViewConnModal);
    $('#viewConnModal').addEventListener('click', (e) => {
      if (e.target === $('#viewConnModal')) closeViewConnModal();
    });
    $('#btnViewConnEdit').addEventListener('click', () => {
      const conn = state.connections.find((c) => c.id === state.viewingConnId);
      closeViewConnModal();
      if (conn) openConnectionFormModal(conn);
    });

    // Modal Histórico de Eventos
    $('#btnCloseEventsConn').addEventListener('click', closeEventsConnModal);
    $('#btnOkEventsConn').addEventListener('click', closeEventsConnModal);
    $('#eventsConnModal').addEventListener('click', (e) => {
      if (e.target === $('#eventsConnModal')) closeEventsConnModal();
    });

    // Modal WhatsApp QR Code
    $('#btnCloseWaQr').addEventListener('click', closeWaQrModal);
    $('#btnCancelWaQrSetup').addEventListener('click', closeWaQrModal);
    $('#btnDoneWaQr').addEventListener('click', () => {
      closeWaQrModal();
      void loadBackendConnections();
      state.connSubView = 'list';
      renderConnections();
    });
    $('#whatsappQrModal').addEventListener('click', (e) => {
      if (e.target === $('#whatsappQrModal')) closeWaQrModal();
    });

    $('#btnStartWaQr').addEventListener('click', async () => {
      const name = $('#waConnNameInput').value.trim() || 'WhatsApp SMV';
      const departmentName = $('#waConnDeptSelect').value || 'Suporte';

      $('#waQrSetupStep').classList.add('hidden');
      $('#waQrScanStep').classList.remove('hidden');
      $('#waQrTitle').textContent = `Conectar WhatsApp — ${name}`;
      updateWaQrModalState({ status: 'CONNECTING', qrDataUrl: null });

      try {
        const res = await API.createConnection({
          name,
          channel: 'WHATSAPP',
          provider: 'BAILEYS',
          departmentName,
          autoStartQr: true,
        });
        const conn = res.connection;
        state.waQrConnectionId = conn.id;
        state.connections.unshift({ ...conn, isRemote: true, events: [] });
        updateWaQrModalState({
          status: conn.sessionState === 'qr' ? 'QR_PENDING' : 'CONNECTING',
          qrDataUrl: conn.qrDataUrl,
          identifier: conn.identifier,
        });
        startWaQrPolling(conn.id);
      } catch (err) {
        toast(`❌ ${formatApiErrorMessage(err, 'Erro ao iniciar QR Code.')}`);
        $('#waQrSetupStep').classList.remove('hidden');
        $('#waQrScanStep').classList.add('hidden');
      }
    });

    $('#btnRegenerateWaQr').addEventListener('click', async () => {
      if (!state.waQrConnectionId || !state.apiConnected) return;
      updateWaQrModalState({ status: 'CONNECTING', qrDataUrl: null });
      try {
        const snap = await API.connectWhatsApp(state.waQrConnectionId);
        updateWaQrModalState(snap);
        startWaQrPolling(state.waQrConnectionId);
      } catch (err) {
        toast(`❌ ${formatApiErrorMessage(err, 'Erro ao gerar novo QR Code.')}`);
      }
    });

    // Modal Excluir Conexão
    $('#btnCloseDeleteConn').addEventListener('click', closeDeleteConnModal);
    $('#btnCancelDeleteConn').addEventListener('click', closeDeleteConnModal);
    $('#deleteConnModal').addEventListener('click', (e) => {
      if (e.target === $('#deleteConnModal')) closeDeleteConnModal();
    });
    $('#btnConfirmDeleteConn').addEventListener('click', async () => {
      const idx = state.connections.findIndex((c) => c.id === state.deletingConnId);
      if (idx !== -1) {
        const target = state.connections[idx];
        if (state.apiConnected && target.isRemote) {
          try {
            const res = await API.deleteConnection(target.id);
            state.connections.splice(idx, 1);
            clearConversationsUIForConnection(target.id, true);
            toast(res.message || `Conexão "${target.name}" excluída!`);
          } catch (err) {
            toast(`Erro ao excluir: ${err.message}`);
          }
        } else {
          state.connections.splice(idx, 1);
          clearConversationsUIForConnection(target.id, false);
          toast(`Conexão "${target.name}" excluída!`);
        }
      }
      closeDeleteConnModal();
      renderConnections();
    });

    // Fechar menus flutuantes ao clicar fora
    document.addEventListener('click', (e) => {
      if (state.openConnMenuId !== null && !e.target.closest('.conn-menu-wrap')) {
        state.openConnMenuId = null;
        renderConnections();
      }
      if (state.openUserMenuId !== null && !e.target.closest('.user-menu-wrap')) {
        state.openUserMenuId = null;
        renderUsers();
      }
      if (!e.target.closest('.conv-menu-wrap')) {
        closeConvMenus();
      }
      if (!e.target.closest('.contacts-import-wrap')) {
        closeContactsImportMenu();
      }
      if (!e.target.closest('.topbar-popover-wrap')) {
        closeTopbarPopovers();
      }
      if (!e.target.closest('#composerBar')) {
        closeComposerPopovers();
      }
    });

    // Contatos: Botões Importar contatos, Novo contato, Exibir Filtros e Atualizar
    const closeContactsImportMenu = () => {
      $('#contactsImportMenu').classList.add('hidden');
      $('#btnContactsImportMenu').setAttribute('aria-expanded', 'false');
    };
    const closeImportContactsModal = () => $('#importContactsModal').classList.add('hidden');

    $('#btnContactsImportMenu').addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = $('#contactsImportMenu').classList.contains('hidden');
      closeContactsImportMenu();
      if (willOpen) {
        $('#contactsImportMenu').classList.remove('hidden');
        $('#btnContactsImportMenu').setAttribute('aria-expanded', 'true');
      }
    });

    $('#btnContactsOpenImportModal').addEventListener('click', (e) => {
      e.stopPropagation();
      closeContactsImportMenu();
      populateConnOptions($('#importContactsConn'));
      $('#importContactsFile').value = '';
      $('#importContactsModal').classList.remove('hidden');
    });

    $('#btnContactsDownloadTemplate').addEventListener('click', (e) => {
      e.stopPropagation();
      closeContactsImportMenu();
      const csv = [
        'Nome,Telefone,Email',
        'Ana Paula - Motors,+55 (11) 99123-4567,ana.paula@motors.com.br',
        'Rodrigo - Imperial Honda,+55 (84) 98801-3344,rodrigo@imperialhonda.com.br',
      ].join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'smv-sac-modelo-contatos.csv';
      a.click();
      URL.revokeObjectURL(url);
      toast('Planilha modelo CSV baixada!');
    });

    $('#btnContactsExportCsv').addEventListener('click', (e) => {
      e.stopPropagation();
      closeContactsImportMenu();
      const rows = getFilteredContacts();
      const csv = [
        'Nome,Telefone,Email,Conexao,Departamento',
        ...rows.map((c) =>
          [c.contact.name, c.contact.phone, c.contact.email, c.connection, c.department]
            .map((v) => `"${String(v || '').replace(/"/g, '""')}"`)
            .join(',')
        ),
      ].join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'smv-sac-contatos.csv';
      a.click();
      URL.revokeObjectURL(url);
      toast(`${rows.length} contatos exportados em CSV!`);
    });

    const addImportedContacts = (entries) => {
      const connSelect = $('#importContactsConn');
      const connName = connSelect.value || 'SUPER MEGAVENDAS';
      const channel = connSelect.selectedOptions?.[0]?.dataset?.channel || 'WhatsApp';
      const dept = $('#importContactsDept').value || 'Suporte';
      const baseNow = Date.now();

      entries.forEach((item, idx) => {
        const parts = item.name.split(/\s+/);
        const initials = ((parts[0]?.[0] || 'C') + (parts[1]?.[0] || parts[0]?.[1] || 'T')).toUpperCase();
        state.conversations.unshift({
          id: 800 + ((baseNow + idx) % 100000),
          ticketNumber: generateTicketNumber(),
          status: 'open',
          assignee: 'queue',
          connection: connName,
          channel,
          department: dept,
          unread: 0,
          updatedAt: nowTime(),
          createdTs: baseNow + idx,
          lastMessageTs: baseNow + idx,
          waitMinutes: 1,
          labels: [dept],
          contact: {
            name: item.name,
            initials,
            role: `Importado via CSV • ${channel}`,
            phone: item.phone || 'Não informado',
            email: item.email || '-',
          },
          summary: `Contato ${item.name} importado em lote via CSV.`,
          aiSuggestedReply: `Olá ${parts[0] || item.name}! Tudo bem? Aqui é da equipe SMV Sac.`,
          autoCustomerReply: 'Olá! Obrigado pelo contato!',
          messages: [
            {
              id: 'imp_' + (baseNow + idx),
              type: 'activity',
              text: `Contato importado para ${connName} (${dept})`,
              time: nowTime(),
            },
          ],
        });
      });

      closeImportContactsModal();
      renderContacts();
      updateGlobalCounts();
      toast(`${entries.length} contato(s) importado(s) com sucesso!`);
    };

    $('#btnCloseImportContacts').addEventListener('click', closeImportContactsModal);
    $('#btnCancelImportContacts').addEventListener('click', closeImportContactsModal);
    $('#importContactsModal').addEventListener('click', (e) => {
      if (e.target === $('#importContactsModal')) closeImportContactsModal();
    });

    $('#btnConfirmImportContacts').addEventListener('click', () => {
      const file = $('#importContactsFile').files?.[0];
      if (!file) {
        toast('Selecione um arquivo .csv para importar');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || '');
        const lines = text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        const parsed = [];
        lines.forEach((line, index) => {
          const cols = line.split(/[,;]/).map((c) => c.replace(/^"|"$/g, '').trim());
          if (index === 0 && cols[0]?.toLowerCase() === 'nome') return;
          if (cols[0]) {
            parsed.push({ name: cols[0], phone: cols[1] || '', email: cols[2] || '' });
          }
        });
        if (parsed.length === 0) {
          toast('Nenhum contato válido encontrado no CSV.');
          return;
        }
        addImportedContacts(parsed);
      };
      reader.readAsText(file, 'utf-8');
    });

    $('#btnContactsNewContact').addEventListener('click', () => {
      state.contactModalSource = 'contacts';
      populateConnOptions($('#newContactConvConn'));
      $('#newContactConvName').value = '';
      $('#newContactConvPhone').value = '';
      $('#newContactConvEmail').value = '';
      $('#newContactConvMsg').value = '';
      $('#addContactConvModal').classList.remove('hidden');
      setTimeout(() => $('#newContactConvName').focus(), 20);
    });

    $('#btnContactsToggleFilters').addEventListener('click', () => {
      state.contactsFiltersOpen = !state.contactsFiltersOpen;
      $('#contactsFilterBar').classList.toggle('hidden', !state.contactsFiltersOpen);
      $('#contactsFilterBtnLabel').textContent = state.contactsFiltersOpen ? 'Ocultar Filtros' : 'Exibir Filtros';
      if (state.contactsFiltersOpen) {
        setTimeout(() => $('#contactsSearchInput').focus(), 20);
      }
    });

    $('#btnContactsSyncWa')?.addEventListener('click', () => {
      void syncWhatsAppContacts();
    });

    $('#btnContactsRefresh').addEventListener('click', async () => {
      const btn = $('#btnContactsRefresh');
      btn.classList.remove('spinning');
      void btn.offsetWidth;
      btn.classList.add('spinning');
      if (state.apiConnected) {
        await loadBackendContacts($('#contactsSearchInput').value || '', 200);
      } else {
        renderContacts();
      }
      toast('Lista de contatos atualizada!');
      setTimeout(() => btn.classList.remove('spinning'), 600);
    });

    $('#contactsSearchInput').addEventListener('input', () => {
      renderContacts();
      if (state.apiConnected) {
        if (state.contactsTabDebounceTimer) clearTimeout(state.contactsTabDebounceTimer);
        state.contactsTabDebounceTimer = setTimeout(() => {
          void loadBackendContacts($('#contactsSearchInput').value || '', 200);
        }, 150);
      }
    });
    $('#contactsConnFilter').addEventListener('change', (e) => {
      state.contactsConnFilter = e.target.value;
      renderContacts();
    });
    $('#contactsDeptFilter').addEventListener('change', (e) => {
      state.contactsDeptFilter = e.target.value;
      renderContacts();
    });
    $('#contactsLabelFilter').addEventListener('change', (e) => {
      state.contactsLabelFilter = e.target.value;
      renderContacts();
    });
    $('#btnContactsClearFilters').addEventListener('click', () => {
      $('#contactsSearchInput').value = '';
      state.contactsConnFilter = 'all';
      state.contactsDeptFilter = 'all';
      state.contactsLabelFilter = 'all';
      $('#contactsDeptFilter').value = 'all';
      $('#contactsLabelFilter').value = 'all';
      renderContacts();
      toast('Filtros de contatos limpos');
    });

    // Relatórios
    $$('#reportPeriodGroup .seg-btn').forEach((b) => {
      b.addEventListener('click', () => {
        $$('#reportPeriodGroup .seg-btn').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        state.reportPeriod = b.dataset.period;
        renderReports();
      });
    });

    $('#btnExportReport').addEventListener('click', () => {
      const rep = DATA.reports[state.reportPeriod];
      const csv = ['Periodo,Recebidos,Finalizados', ...rep.series.map((s) => `${s.label},${s.received},${s.resolved}`)].join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `smv-sac-relatorio-${state.reportPeriod}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast('Relatório CSV exportado!');
    });

    // Command Bar
    $('#btnOpenCommandBar').addEventListener('click', () => {
      $('#commandBarModal').classList.remove('hidden');
      $('#commandBarInput').value = '';
      renderCommandBar('');
      setTimeout(() => $('#commandBarInput').focus(), 20);
    });
    $('#commandBarInput').addEventListener('input', (e) => renderCommandBar(e.target.value));
    $('#commandBarModal').addEventListener('click', (e) => {
      if (e.target === $('#commandBarModal')) $('#commandBarModal').classList.add('hidden');
    });

    // ======================================================================
    // MANUAL DE USO (? ▾) & CENTRAL DE NOTIFICAÇÕES (🔔)
    // ======================================================================
    const closeTopbarPopovers = () => {
      $('#helpMenu').classList.add('hidden');
      $('#notificationsPanel').classList.add('hidden');
      $('#userProfileMenu').classList.add('hidden');
      $('#btnHelpMenu').setAttribute('aria-expanded', 'false');
      $('#btnNotifications').setAttribute('aria-expanded', 'false');
      $('#agentStatusToggle').setAttribute('aria-expanded', 'false');
    };
    const closeManualModal = () => $('#manualModal').classList.add('hidden');

    $('#btnHelpMenu').addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = $('#helpMenu').classList.contains('hidden');
      closeTopbarPopovers();
      if (willOpen) {
        $('#helpMenu').classList.remove('hidden');
        $('#btnHelpMenu').setAttribute('aria-expanded', 'true');
      }
    });

    $('#btnOpenManual').addEventListener('click', () => {
      closeTopbarPopovers();
      openManualModal('start');
    });
    $('#btnOpenShortcuts').addEventListener('click', () => {
      closeTopbarPopovers();
      openManualModal('shortcuts');
    });
    $('#btnOpenLgpdFromTop').addEventListener('click', () => {
      closeTopbarPopovers();
      state.pendingUser = null;
      openLgpdModal();
    });

    $$('.manual-tab').forEach((tabBtn) => {
      tabBtn.addEventListener('click', () => openManualModal(tabBtn.dataset.manualTab));
    });
    $('#btnCloseManual').addEventListener('click', closeManualModal);
    $('#btnOkManual').addEventListener('click', closeManualModal);
    $('#manualModal').addEventListener('click', (e) => {
      if (e.target === $('#manualModal')) closeManualModal();
    });

    $('#btnNotifications').addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = $('#notificationsPanel').classList.contains('hidden');
      closeTopbarPopovers();
      if (willOpen) {
        renderNotifications();
        $('#notificationsPanel').classList.remove('hidden');
        $('#btnNotifications').setAttribute('aria-expanded', 'true');
      }
    });

    $('#notificationsPanel').addEventListener('click', (e) => e.stopPropagation());

    $$('.notif-tab').forEach((tabBtn) => {
      tabBtn.addEventListener('click', () => {
        state.notifFilter = tabBtn.dataset.notifFilter;
        renderNotifications();
      });
    });

    $('#btnMarkAllRead').addEventListener('click', () => {
      state.notifications.forEach((n) => {
        n.unread = false;
      });
      renderNotifications();
      toast('Todas as notificações marcadas como lidas');
    });

    $('#btnClearReadNotifs').addEventListener('click', () => {
      state.notifications = state.notifications.filter((n) => n.unread);
      renderNotifications();
      toast('Notificações lidas removidas');
    });

    $('#toggleNotifSound').addEventListener('change', (e) => {
      state.notifSoundEnabled = e.target.checked;
      toast(state.notifSoundEnabled ? '🔊 Alerta sonoro ativado' : '🔇 Alerta sonoro desativado');
    });

    // ======================================================================
    // TEMA CLARO / ESCURO
    // ======================================================================
    $('#btnThemeToggleAuth').addEventListener('click', toggleTheme);
    $('#btnThemeToggleTop').addEventListener('click', toggleTheme);

    // ======================================================================
    // GESTÃO DE USUÁRIOS (ADMINISTRADOR)
    // ======================================================================
    $('#usersSearchInput')?.addEventListener('input', (e) => {
      state.usersSearch = e.target.value;
      renderUsers();
    });

    $('#usersApprovalFilter')?.addEventListener('change', (e) => {
      state.usersApprovalFilter = e.target.value;
      renderUsers();
    });

    $('#btnFilterPendingUsers')?.addEventListener('click', () => {
      state.usersApprovalFilter = 'PENDING';
      const sel = $('#usersApprovalFilter');
      if (sel) sel.value = 'PENDING';
      renderUsers();
    });

    $('#usersRoleFilter')?.addEventListener('change', (e) => {
      state.usersRoleFilter = e.target.value;
      renderUsers();
    });

    $('#usersDeptFilter')?.addEventListener('change', (e) => {
      state.usersDeptFilter = e.target.value;
      renderUsers();
    });

    $('#btnUsersRefresh')?.addEventListener('click', async () => {
      const btn = $('#btnUsersRefresh');
      btn.classList.remove('spinning');
      void btn.offsetWidth;
      btn.classList.add('spinning');
      if (state.apiConnected) {
        await loadBackendUsers();
      } else {
        renderUsers();
      }
      toast('Lista de usuários atualizada!');
      setTimeout(() => btn.classList.remove('spinning'), 600);
    });

    $('#btnOpenNewUserModal')?.addEventListener('click', openAddUserModal);
    $('#btnCloseAddUser')?.addEventListener('click', closeAddUserModal);
    $('#btnCancelAddUser')?.addEventListener('click', closeAddUserModal);
    $('#addUserModal')?.addEventListener('click', (e) => {
      if (e.target === $('#addUserModal')) closeAddUserModal();
    });

    $('#btnToggleNewUserPwd')?.addEventListener('click', () => {
      const inp = $('#newUserPassword');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });

    $('#newUserPassword')?.addEventListener('input', (e) => {
      const val = e.target.value;
      updatePasswordRulesUI('#newUserPasswordRules', val, false);
      const err = $('#newUserError');
      if (err && !err.classList.contains('hidden') && evaluatePasswordStrength(val).valid) {
        err.classList.add('hidden');
      }
    });

    $('#btnSaveAddUser')?.addEventListener('click', async () => {
      const name = $('#newUserName').value.trim();
      const email = $('#newUserEmail').value.trim().toLowerCase();
      const role = $('#newUserRole').value === 'ADMIN' ? 'ADMIN' : 'USER';
      const { departmentId, departmentName } = readSelectedDepartmentPayload($('#newUserDepartment'));
      const password = $('#newUserPassword').value;
      const err = $('#newUserError');

      if (!name || name.length < 2) {
        err.textContent = 'Informe o nome completo (mínimo 2 caracteres).';
        err.classList.remove('hidden');
        return;
      }
      if (!email || !email.includes('@')) {
        err.textContent = 'Informe um e-mail válido.';
        err.classList.remove('hidden');
        return;
      }
      if (!evaluatePasswordStrength(password).valid) {
        updatePasswordRulesUI('#newUserPasswordRules', password, true);
        err.textContent =
          'A senha deve ter no mínimo 8 caracteres, contendo letra maiúscula, letra minúscula, número e caractere especial.';
        err.classList.remove('hidden');
        return;
      }

      err.classList.add('hidden');

      if (!API?.getToken()) {
        closeAddUserModal();
        forceRedirectToLogin('Sua sessão expirou. Faça login novamente.');
        return;
      }

      const saveBtn = $('#btnSaveAddUser');
      saveBtn.disabled = true;
      try {
        const res = await API.createUser({
          name,
          email,
          password,
          role,
          departmentId,
          departmentName,
        });
        closeAddUserModal();
        await loadBackendUsers();
        toast(res.message || `Usuário "${name}" criado com sucesso!`);
      } catch (apiErr) {
        err.textContent = formatApiErrorMessage(apiErr, 'Não foi possível criar o usuário.');
        err.classList.remove('hidden');
      } finally {
        saveBtn.disabled = false;
      }
    });

    // Modal Editar Usuário
    $('#btnCloseEditUser')?.addEventListener('click', closeEditUserModal);
    $('#btnCancelEditUser')?.addEventListener('click', closeEditUserModal);
    $('#editUserModal')?.addEventListener('click', (e) => {
      if (e.target === $('#editUserModal')) closeEditUserModal();
    });

    $('#btnSaveEditUser')?.addEventListener('click', async () => {
      const targetId = state.editingUserId;
      if (!targetId) return;

      const name = $('#editUserName').value.trim();
      const emailInput = $('#editUserEmail');
      const email = emailInput.value.trim().toLowerCase();
      const roleSelect = $('#editUserRole');
      const { departmentId, departmentName } = readSelectedDepartmentPayload($('#editUserDepartment'));
      const err = $('#editUserError');

      if (!name || name.length < 2) {
        err.textContent = 'Informe o nome completo (mínimo 2 caracteres).';
        err.classList.remove('hidden');
        return;
      }
      if (!emailInput.disabled && (!email || !email.includes('@'))) {
        err.textContent = 'Informe um e-mail válido.';
        err.classList.remove('hidden');
        return;
      }

      err.classList.add('hidden');

      if (!API?.getToken()) {
        closeEditUserModal();
        forceRedirectToLogin('Sua sessão expirou. Faça login novamente.');
        return;
      }

      const payload = {
        name,
        departmentId,
        departmentName,
      };
      if (!emailInput.disabled) payload.email = email;
      if (!roleSelect.disabled) payload.role = roleSelect.value === 'ADMIN' ? 'ADMIN' : 'USER';

      const saveBtn = $('#btnSaveEditUser');
      saveBtn.disabled = true;
      try {
        const res = await API.updateUser(targetId, payload);
        if (state.currentUser.id && targetId === state.currentUser.id && res.user) {
          state.currentUser.name = res.user.name;
          state.currentUser.email = res.user.email;
          syncUserProfileUI();
        }
        closeEditUserModal();
        await loadBackendUsers();
        toast(res.message || `Usuário "${name}" atualizado com sucesso!`);
      } catch (apiErr) {
        err.textContent = formatApiErrorMessage(apiErr, 'Não foi possível salvar as alterações.');
        err.classList.remove('hidden');
      } finally {
        saveBtn.disabled = false;
      }
    });

    // Modal Redefinir Senha do Usuário (Administrador)
    $('#btnCloseResetUserPwd')?.addEventListener('click', closeResetUserPasswordModal);
    $('#btnCancelResetUserPwd')?.addEventListener('click', closeResetUserPasswordModal);
    $('#resetUserPasswordModal')?.addEventListener('click', (e) => {
      if (e.target === $('#resetUserPasswordModal')) closeResetUserPasswordModal();
    });

    $('#btnToggleResetUserPwd')?.addEventListener('click', () => {
      const inp = $('#resetUserPassword');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });

    $('#btnToggleResetUserPwdConfirm')?.addEventListener('click', () => {
      const inp = $('#resetUserPasswordConfirm');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });

    $('#resetUserPassword')?.addEventListener('input', (e) => {
      const val = e.target.value;
      updatePasswordRulesUI('#resetUserPasswordRules', val, false);
      const err = $('#resetUserPwdError');
      if (err && !err.classList.contains('hidden') && evaluatePasswordStrength(val).valid) {
        err.classList.add('hidden');
      }
    });

    $('#btnSaveResetUserPwd')?.addEventListener('click', async () => {
      const targetId = state.resetPwdUserId;
      if (!targetId) return;

      const password = $('#resetUserPassword').value;
      const confirmPassword = $('#resetUserPasswordConfirm').value;
      const err = $('#resetUserPwdError');

      if (!evaluatePasswordStrength(password).valid) {
        updatePasswordRulesUI('#resetUserPasswordRules', password, true);
        err.textContent =
          'A nova senha deve ter no mínimo 8 caracteres, contendo letra maiúscula, letra minúscula, número e caractere especial.';
        err.classList.remove('hidden');
        return;
      }

      if (password !== confirmPassword) {
        err.textContent = 'A confirmação da senha não confere com a nova senha.';
        err.classList.remove('hidden');
        return;
      }

      err.classList.add('hidden');

      if (!API?.getToken()) {
        closeResetUserPasswordModal();
        forceRedirectToLogin('Sua sessão expirou. Faça login novamente.');
        return;
      }

      const saveBtn = $('#btnSaveResetUserPwd');
      saveBtn.disabled = true;
      try {
        const res = await API.resetUserPassword(targetId, password);
        closeResetUserPasswordModal();
        toast(res.message || 'Senha redefinida com sucesso!');
      } catch (apiErr) {
        err.textContent = formatApiErrorMessage(apiErr, 'Não foi possível redefinir a senha.');
        err.classList.remove('hidden');
      } finally {
        saveBtn.disabled = false;
      }
    });

    // Modal Aprovar Cadastro Pendente
    $('#btnCloseApproveUser')?.addEventListener('click', closeApproveUserModal);
    $('#btnCancelApproveUser')?.addEventListener('click', closeApproveUserModal);
    $('#approveUserModal')?.addEventListener('click', (e) => {
      if (e.target === $('#approveUserModal')) closeApproveUserModal();
    });

    $('#btnConfirmApproveUser')?.addEventListener('click', async () => {
      const targetId = state.approvingUserId;
      if (!targetId) return;

      const { departmentId, departmentName } = readSelectedDepartmentPayload($('#approveUserDepartment'));
      const role = $('#approveUserRole').value === 'ADMIN' ? 'ADMIN' : 'USER';
      const err = $('#approveUserError');
      err.classList.add('hidden');

      if (!API?.getToken()) {
        closeApproveUserModal();
        forceRedirectToLogin('Sua sessão expirou. Faça login novamente.');
        return;
      }

      const btn = $('#btnConfirmApproveUser');
      btn.disabled = true;
      try {
        const res = await API.approveUser(targetId, { departmentId, departmentName, role });
        closeApproveUserModal();
        await loadBackendUsers();
        toast(res.message || 'Cadastro aprovado com sucesso!');
      } catch (apiErr) {
        err.textContent = formatApiErrorMessage(apiErr, 'Não foi possível aprovar o cadastro.');
        err.classList.remove('hidden');
      } finally {
        btn.disabled = false;
      }
    });

    // Modal Recusar Cadastro Pendente
    $('#btnCloseRejectUser')?.addEventListener('click', closeRejectUserModal);
    $('#btnCancelRejectUser')?.addEventListener('click', closeRejectUserModal);
    $('#rejectUserModal')?.addEventListener('click', (e) => {
      if (e.target === $('#rejectUserModal')) closeRejectUserModal();
    });

    $('#btnConfirmRejectUser')?.addEventListener('click', async () => {
      const targetId = state.rejectingUserId;
      if (!targetId) return;

      if (!API?.getToken()) {
        closeRejectUserModal();
        forceRedirectToLogin('Sua sessão expirou. Faça login novamente.');
        return;
      }

      const btn = $('#btnConfirmRejectUser');
      btn.disabled = true;
      try {
        const res = await API.rejectUser(targetId);
        closeRejectUserModal();
        await loadBackendUsers();
        toast(res.message || 'Solicitação de cadastro recusada.');
      } catch (apiErr) {
        toast(`❌ ${formatApiErrorMessage(apiErr, 'Erro ao recusar solicitação.')}`);
      } finally {
        btn.disabled = false;
      }
    });

    $('#btnCloseDeleteUser')?.addEventListener('click', closeDeleteUserModal);
    $('#btnCancelDeleteUser')?.addEventListener('click', closeDeleteUserModal);
    $('#deleteUserModal')?.addEventListener('click', (e) => {
      if (e.target === $('#deleteUserModal')) closeDeleteUserModal();
    });

    $('#btnConfirmDeleteUser')?.addEventListener('click', async () => {
      const targetId = state.deletingUserId;
      if (!targetId) return;

      if (!API?.getToken()) {
        closeDeleteUserModal();
        forceRedirectToLogin('Sua sessão expirou. Faça login novamente.');
        return;
      }

      try {
        const res = await API.deleteUser(targetId);
        closeDeleteUserModal();
        await loadBackendUsers();
        toast(res.message || 'Usuário removido com sucesso!');
      } catch (err) {
        toast(`❌ ${formatApiErrorMessage(err, 'Erro ao remover usuário.')}`);
      }
    });

    // ======================================================================
    // LOGIN / ESQUECI MINHA SENHA / CADASTRAR / LGPD
    // ======================================================================
    $('#btnGoForgot').addEventListener('click', () => showAuthPanel('forgot'));
    $('#btnGoRegister').addEventListener('click', () => showAuthPanel('register'));
    $('#btnBackToLogin').addEventListener('click', () => showAuthPanel('login'));
    $('#btnRegSuccessGoLogin')?.addEventListener('click', () => showAuthPanel('login'));

    $('#regEmail')?.addEventListener('input', (e) => {
      const err = $('#registerError');
      if (err && !err.classList.contains('hidden') && isAllowedCorporateEmail(e.target.value)) {
        err.classList.add('hidden');
      }
    });

    $('#btnToggleLoginPwd').addEventListener('click', () => {
      const inp = $('#loginPassword');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });

    const btnToggleRegPwd = $('#btnToggleRegPwd');
    if (btnToggleRegPwd) {
      btnToggleRegPwd.addEventListener('click', () => {
        const inp = $('#regPassword');
        inp.type = inp.type === 'password' ? 'text' : 'password';
      });
    }

    function updateRegPasswordRulesUI(pwd, showInvalidState = false) {
      updatePasswordRulesUI('#regPasswordRules', pwd, showInvalidState);
    }

    const regPasswordInput = $('#regPassword');
    if (regPasswordInput) {
      regPasswordInput.addEventListener('input', () => {
        updateRegPasswordRulesUI(regPasswordInput.value, false);
        const err = $('#registerError');
        if (!err.classList.contains('hidden')) {
          const { valid } = evaluatePasswordStrength(regPasswordInput.value);
          if (valid) err.classList.add('hidden');
        }
      });
    }

    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = $('#loginEmail').value.trim().toLowerCase();
      const pwd = $('#loginPassword').value;
      const err = $('#loginError');

      if (!email || !email.includes('@')) {
        err.textContent = 'Informe um e-mail válido para continuar.';
        err.classList.remove('hidden');
        return;
      }
      if (!pwd) {
        err.textContent = 'Digite sua senha para continuar.';
        err.classList.remove('hidden');
        return;
      }
      if (!API) {
        err.textContent = 'Cliente de API indisponível. Recarregue a página e tente novamente.';
        err.classList.remove('hidden');
        return;
      }

      try {
        const res = await API.login(email, pwd);
        if (!res?.accessToken || !res?.user) {
          throw new Error('Resposta de autenticação inválida do servidor.');
        }
        state.apiConnected = true;
        state.lgpdAccepted = Boolean(res.lgpd?.accepted);
        DATA.currentAgent.id = res.user.id;
        persistAuthSession(res.accessToken, res.user, state.lgpdAccepted);
        err.classList.add('hidden');
        startAuthFlow({
          id: res.user.id,
          name: res.user.name,
          email: res.user.email,
          role: res.user.role,
          subdomain: res.user.organization?.slug || 'supermegavendas',
        });
      } catch (apiErr) {
        state.apiConnected = false;
        API.setToken(null);
        err.textContent = formatApiErrorMessage(apiErr, 'E-mail ou senha inválidos.');
        err.classList.remove('hidden');
      }
    });

    $('#forgotForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const email = $('#forgotEmail').value.trim();
      const err = $('#forgotError');
      if (!email || !email.includes('@')) {
        err.textContent = 'Informe o e-mail cadastrado para receber o link.';
        err.classList.remove('hidden');
        return;
      }
      err.classList.add('hidden');
      $('#forgotEmail').value = '';
      showAuthPanel('login');
      toast(`Link de recuperação enviado para ${email}`);
    });

    $('#registerForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $('#regName').value.trim();
      const email = $('#regEmail').value.trim().toLowerCase();
      const pwd = $('#regPassword').value;
      const err = $('#registerError');

      if (!name || name.length < 2) {
        err.textContent = 'Informe seu nome completo.';
        err.classList.remove('hidden');
        return;
      }
      if (!email || !email.includes('@')) {
        err.textContent = 'Informe um e-mail válido.';
        err.classList.remove('hidden');
        return;
      }
      if (!isAllowedCorporateEmail(email)) {
        err.textContent = INVALID_CORPORATE_DOMAIN_MSG;
        err.classList.remove('hidden');
        return;
      }
      const pwdEval = evaluatePasswordStrength(pwd);
      if (!pwdEval.valid) {
        updateRegPasswordRulesUI(pwd, true);
        err.textContent =
          'A senha deve ter no mínimo 8 caracteres, contendo letra maiúscula, letra minúscula, número e caractere especial.';
        err.classList.remove('hidden');
        return;
      }
      if (!API) {
        err.textContent = 'Cliente de API indisponível. Recarregue a página e tente novamente.';
        err.classList.remove('hidden');
        return;
      }

      const submitBtn = $('#btnRegisterSubmit');
      if (submitBtn) submitBtn.disabled = true;
      err.classList.add('hidden');

      try {
        const res = await API.register(name, email, pwd);
        if (res?.pendingApproval || !res?.accessToken) {
          $('#regName').value = '';
          $('#regEmail').value = '';
          $('#regPassword').value = '';
          updateRegPasswordRulesUI('', false);
          $('#registerForm').classList.add('hidden');
          const successText = $('#registerSuccessText');
          if (successText) {
            successText.textContent =
              res?.message ||
              'Solicitação de cadastro enviada com sucesso! Seu acesso será liberado assim que um administrador aprovar sua conta.';
          }
          $('#registerSuccess')?.classList.remove('hidden');
          toast('Solicitação enviada! Aguarde a aprovação de um administrador.');
          return;
        }

        state.apiConnected = true;
        state.lgpdAccepted = Boolean(res.lgpd?.accepted);
        DATA.currentAgent.id = res.user.id;
        persistAuthSession(res.accessToken, res.user, state.lgpdAccepted);
        startAuthFlow({
          id: res.user.id,
          name: res.user.name,
          email: res.user.email,
          role: res.user.role,
          subdomain: res.user.organization?.slug || 'supermegavendas',
          isNew: true,
        });
      } catch (apiErr) {
        state.apiConnected = false;
        API.setToken(null);
        err.textContent = formatApiErrorMessage(apiErr, 'Não foi possível concluir o cadastro.');
        err.classList.remove('hidden');
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });

    // Modal LGPD
    $('#btnOpenLgpdFromAuth').addEventListener('click', () => {
      state.pendingUser = null;
      openLgpdModal();
    });

    $('#lgpdAcceptRequired').addEventListener('change', (e) => {
      $('#btnLgpdConfirm').disabled = !e.target.checked;
    });

    $('#btnLgpdConfirm').addEventListener('click', async () => {
      if (!$('#lgpdAcceptRequired').checked) return;
      state.lgpdAccepted = true;
      const acceptedMarketing = $('#lgpdAcceptMarketing').checked;
      localStorage.setItem(
        'smv_sac_lgpd_consent',
        JSON.stringify({
          accepted: true,
          marketing: acceptedMarketing,
          acceptedAt: new Date().toISOString(),
        })
      );
      if (state.apiConnected && API) {
        await API.recordLgpdConsent(acceptedMarketing).catch(() => { });
      }
      closeLgpdModal();
      if (state.pendingUser) {
        completeLogin(state.pendingUser);
        state.pendingUser = null;
      } else {
        toast('Consentimento LGPD confirmado com sucesso!');
      }
    });

    const handleLgpdDecline = () => {
      const hadPending = Boolean(state.pendingUser);
      state.pendingUser = null;
      closeLgpdModal();
      if (!state.authenticated) {
        $('#authScreen')?.classList.remove('hidden');
        showAuthPanel('login');
      }
      if (hadPending) {
        toast('É necessário aceitar o termo LGPD para acessar o SMV Sac.');
      }
    };
    $('#btnLgpdDecline').addEventListener('click', handleLgpdDecline);
    $('#btnCloseLgpd').addEventListener('click', handleLgpdDecline);

    // Logout
    $('#btnLogout').addEventListener('click', async () => {
      if (API?.getToken()) {
        await API.logout();
      }
      forceRedirectToLogin('Você saiu da sua conta SMV Sac.');
    });

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && state.authenticated) {
        e.preventDefault();
        $('#btnOpenCommandBar').click();
      } else if (e.key === 'Escape') {
        $('#commandBarModal').classList.add('hidden');
        closeConnModal();
        closeViewConnModal();
        closeEventsConnModal();
        closeDeleteConnModal();
        closeUpgradeConnModal();
        closeAddContactConvModal();
        closeNewConversationModal();
        closeAddGroupConvModal();
        closeImportContactsModal();
        closeManualModal();
        closeAccountModal();
        closeAddUserModal();
        closeEditUserModal();
        closeResetUserPasswordModal();
        closeApproveUserModal();
        closeRejectUserModal();
        closeDeleteUserModal();
        closeAboutModal();
        closeComposerActionModal();
        closeTransferModal();
        closeWaQrModal();
        closeConvMenus();
        closeContactsImportMenu();
        closeTopbarPopovers();
        closeComposerPopovers();
        if (state.openConnMenuId !== null) {
          state.openConnMenuId = null;
          renderConnections();
        }
        if (state.openUserMenuId !== null) {
          state.openUserMenuId = null;
          renderUsers();
        }
        hideCanned();
        closeLgpdModal();
      }
    });
  }

  // ========================================================================
  // HELPERS: TEMA, AUTENTICAÇÃO E LGPD
  // ========================================================================
  function applyTheme(theme) {
    state.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('smv_sac_theme', theme);

    const isLight = theme === 'light';
    $('#themeIconAuth').textContent = isLight ? '🌙' : '☀️';
    $('#themeLabelAuth').textContent = isLight ? 'Tela escura' : 'Tela clara';
    $('#themeIconTop').textContent = isLight ? '🌙' : '☀️';
    $('#btnThemeToggleTop').setAttribute('data-tip', isLight ? 'Mudar para tela escura' : 'Mudar para tela clara');
  }

  function toggleTheme() {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
    toast(state.theme === 'light' ? '☀️ Modo tela clara ativado' : '🌙 Modo tela escura ativado');
  }

  function showAuthPanel(panel) {
    $('#authLoginCard').classList.toggle('hidden', panel !== 'login');
    $('#authForgotCard').classList.toggle('hidden', panel !== 'forgot');
    $('#authRegisterCard').classList.toggle('hidden', panel !== 'register');
    $('#authLoginLinks').classList.toggle('hidden', panel !== 'login');
    $('#authBackLinks').classList.toggle('hidden', panel === 'login');

    $('#loginError').classList.add('hidden');
    $('#forgotError').classList.add('hidden');
    $('#registerError').classList.add('hidden');
    $('#registerForm')?.classList.remove('hidden');
    $('#registerSuccess')?.classList.add('hidden');

    if (panel === 'login') {
      $('#authSubtitle').textContent = 'Acesse sua conta para gerenciar seus atendimentos';
    } else if (panel === 'forgot') {
      $('#authSubtitle').textContent = 'Recuperação de acesso por e-mail';
    } else {
      $('#authSubtitle').textContent = 'Solicite seu acesso corporativo (@supermegavendas.com)';
    }
  }

  function hideBootSplash() {
    $('#bootSplash')?.classList.add('hidden');
  }

  function openLgpdModal() {
    hideBootSplash();
    $('#lgpdAcceptRequired').checked = state.lgpdAccepted;
    $('#btnLgpdConfirm').disabled = !state.lgpdAccepted;
    $('#lgpdModal').classList.remove('hidden');
  }

  function closeLgpdModal() {
    $('#lgpdModal').classList.add('hidden');
  }

  function startAuthFlow(user) {
    if (state.lgpdAccepted) {
      completeLogin(user);
    } else {
      state.pendingUser = user;
      openLgpdModal();
    }
  }

  function completeLogin(user) {
    state.authenticated = true;
    const normalized = normalizeUserProfile(user.role, user.email);
    state.currentUser = {
      id: user.id || null,
      name: user.name || 'Ransay',
      email: user.email || PRIMARY_ADMIN_EMAIL,
      roleCode: normalized.roleCode,
      role: normalized.roleLabel,
      subdomain: user.subdomain || state.currentUser?.subdomain || 'supermegavendas',
    };
    const parts = (state.currentUser.name || 'RA').trim().split(/\s+/);
    const initials = (parts[0]?.[0] || 'S') + (parts[1]?.[0] || parts[0]?.[1] || 'M');
    DATA.currentAgent.name = state.currentUser.name;
    DATA.currentAgent.initials = initials.toUpperCase();
    const selfAgent = DATA.agents.find((a) => a.id === DATA.currentAgent.id);
    if (selfAgent) {
      selfAgent.name = `${state.currentUser.name} (${normalized.roleCode === 'ADMIN' ? 'Administrador' : 'User'})`;
    }
    $('#agentAvatarInitials').textContent = DATA.currentAgent.initials;
    $('#profileMenuUserName').textContent = state.currentUser.name;
    $('#btnCopySubdomain').textContent = state.currentUser.subdomain;
    $('#aboutSubdomainVal').textContent = state.currentUser.subdomain;
    syncRoleVisibilityUI();

    hideBootSplash();
    $('#authScreen').classList.add('hidden');
    $('#appShell').classList.remove('hidden');
    setView('conversations');
    if (state.apiConnected) {
      void bootstrapBackendSession();
      if (isCurrentUserAdmin()) {
        void loadBackendUsers();
      }
    }
    toast(
      user.isNew
        ? `Conta criada! Bem-vindo ao SMV Sac, ${user.name} (${normalized.roleLabel})!`
        : `Bem-vindo ao SMV Sac, ${user.name} (${normalized.roleLabel})!`
    );
  }

  const SESSION_STORAGE_KEY = 'smv_sac_session';
  const LEGACY_OFFLINE_STORAGE_KEYS = [
    'smv_sac_users',
    'smv_sac_offline_mode',
    'smv_sac_token',
    'offlineMode',
  ];

  function clearStoredAuthSession() {
    try {
      localStorage.removeItem(SESSION_STORAGE_KEY);
      LEGACY_OFFLINE_STORAGE_KEYS.forEach((k) => localStorage.removeItem(k));
    } catch {}
    if (API) {
      API.setToken(null);
      API.disconnectSocket();
    }
  }

  function persistAuthSession(accessToken, user, lgpdAccepted) {
    if (!accessToken || typeof accessToken !== 'string') return;
    try {
      LEGACY_OFFLINE_STORAGE_KEYS.forEach((k) => localStorage.removeItem(k));
      localStorage.setItem(
        SESSION_STORAGE_KEY,
        JSON.stringify({
          accessToken,
          refreshToken: API?.getRefreshToken?.() || null,
          user,
          lgpdAccepted: Boolean(lgpdAccepted),
          savedAt: new Date().toISOString(),
        })
      );
    } catch {}
  }

  function forceRedirectToLogin(message = '') {
    clearStoredAuthSession();
    stopWaQrPolling();
    stopFallbackSyncPolling();
    clearAllConversationPresences();
    state.authenticated = false;
    state.apiConnected = false;
    state.socketConnected = false;
    state.lgpdAccepted = false;
    state.pendingUser = null;
    hideBootSplash();
    $('#appShell')?.classList.add('hidden');
    $('#authScreen')?.classList.remove('hidden');
    showAuthPanel('login');
    if (message) toast(message);
  }

  async function bootstrap() {
    try {
      bindEvents();
      applyTheme(state.theme);
      renderNotifications();

      // Remove qualquer resquício de chaves antigas de modo offline
      try {
        LEGACY_OFFLINE_STORAGE_KEYS.forEach((k) => localStorage.removeItem(k));
      } catch {}

      let savedSession = null;
      try {
        const raw = localStorage.getItem(SESSION_STORAGE_KEY);
        if (raw) {
          savedSession = JSON.parse(raw);
        }
      } catch {
        savedSession = null;
        clearStoredAuthSession();
      }

      // Se houver sessão salva sem accessToken válido ou marcada como offline, limpa e exibe o login imediatamente
      const hasValidStoredToken = Boolean(
        savedSession &&
          !savedSession.offlineMode &&
          typeof savedSession.accessToken === 'string' &&
          savedSession.accessToken.trim().length > 10
      );

      if (!hasValidStoredToken) {
        if (savedSession) {
          clearStoredAuthSession();
        }
        $('#appShell')?.classList.add('hidden');
        $('#authScreen')?.classList.remove('hidden');
        showAuthPanel('login');
        return;
      }

      // Mantém a tela de carregamento visível enquanto valida a sessão no back-end (/auth/me ou /auth/refresh)
      API.setToken(savedSession.accessToken, savedSession.refreshToken || null);
      const me = await API.getMe();
      if (!me?.user) {
        forceRedirectToLogin();
        return;
      }
      state.apiConnected = true;
      state.lgpdAccepted = Boolean(me.lgpd?.accepted);
      DATA.currentAgent.id = me.user.id;
      persistAuthSession(API.getToken() || savedSession.accessToken, me.user, state.lgpdAccepted);
      startAuthFlow({
        id: me.user.id,
        name: me.user.name,
        email: me.user.email,
        role: me.user.role,
        subdomain: me.user.organization?.slug || 'supermegavendas',
      });
    } catch {
      forceRedirectToLogin();
    } finally {
      hideBootSplash();
      const appHidden = $('#appShell')?.classList.contains('hidden');
      const authHidden = $('#authScreen')?.classList.contains('hidden');
      const lgpdHidden = $('#lgpdModal')?.classList.contains('hidden');
      if (appHidden && authHidden && lgpdHidden) {
        $('#authScreen')?.classList.remove('hidden');
        showAuthPanel('login');
      }
    }
  }

  void bootstrap();
})();
