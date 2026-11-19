/* ==========================================================================
   SMV SAC — LÓGICA INTERATIVA (ESTILO DIGISAC • PRETO & AMARELO)
   ========================================================================== */

(function () {
  const DATA = window.SMV_SAC_DATA;

  const state = {
    view: 'conversations', // conversations | connections | contacts | reports | ai
    tab: 'mine', // mine | queue | all
    statusFilter: 'open', // open | resolved | all
    searchQuery: '',
    inChatSearch: '',
    selectedConvId: DATA.conversations[0].id,
    privateMode: false,
    connTab: 'active', // active | archived
    connSearch: '',
    connChannel: 'all',
    reportPeriod: '7d',
    liveWidgetConvId: null,
    agentStatusIndex: 0,
    conversations: JSON.parse(JSON.stringify(DATA.conversations)),
    connections: JSON.parse(JSON.stringify(DATA.connections)),
  };

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
  // NAVEGAÇÃO TOPBAR
  // ========================================================================
  function setView(viewName) {
    state.view = viewName;
    $$('.view-panel').forEach((p) => p.classList.remove('active'));
    const panel = $(`#view-${viewName}`);
    if (panel) panel.classList.add('active');

    $$('.top-icon-btn[data-view]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === viewName);
    });

    if (viewName === 'conversations') renderConversations();
    if (viewName === 'connections') renderConnections();
    if (viewName === 'contacts') renderContacts();
    if (viewName === 'reports') renderReports();
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
    return state.conversations.filter((c) => {
      if (state.statusFilter !== 'all' && c.status !== state.statusFilter) return false;
      if (state.tab === 'mine' && c.assignee !== DATA.currentAgent.id) return false;
      if (state.tab === 'queue' && c.assignee !== 'queue') return false;

      if (state.searchQuery.trim()) {
        const q = state.searchQuery.toLowerCase();
        const match =
          c.contact.name.toLowerCase().includes(q) ||
          c.contact.phone.toLowerCase().includes(q) ||
          c.connection.toLowerCase().includes(q) ||
          c.department.toLowerCase().includes(q);
        if (!match) return false;
      }
      return true;
    });
  }

  function renderConversations() {
    updateGlobalCounts();

    $$('.pill-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
    $('#statusFilter').value = state.statusFilter;

    const listEl = $('#conversationList');
    const list = getFilteredConversations();

    if (list.length === 0) {
      listEl.innerHTML = `<div style="padding:36px 14px;text-align:center;color:var(--text-muted);font-size:12.5px;">Nenhuma conversa nesta aba.</div>`;
    } else {
      listEl.innerHTML = list
        .map((c) => {
          const last = [...c.messages].reverse().find((m) => m.type !== 'activity') || c.messages[c.messages.length - 1];
          const prefix = last?.type === 'outgoing' ? '✓✓ ' : last?.type === 'private' ? '🔒 ' : '';
          const preview = last ? `${prefix}${last.text}` : '';
          return `
            <div class="conv-row ${c.id === state.selectedConvId ? 'active' : ''}" data-conv-id="${c.id}">
              <div class="avatar md">
                <span>${escapeHtml(c.contact.initials)}</span>
                <span class="ch-dot ${channelBadgeClass(c.channel)}" title="${escapeHtml(c.channel)}">${channelMiniGlyph(c.channel)}</span>
              </div>
              <div class="conv-row-body">
                <div class="conv-row-top">
                  <span class="conv-row-name">${escapeHtml(c.contact.name)}</span>
                  <span class="conv-row-time">${escapeHtml(c.updatedAt)}</span>
                </div>
                <div class="conv-row-bottom">
                  <span class="conv-row-preview">${escapeHtml(preview)}</span>
                  ${c.unread > 0 ? `<span class="unread-dot">${c.unread}</span>` : ''}
                </div>
              </div>
            </div>
          `;
        })
        .join('');

      $$('.conv-row').forEach((row) => {
        row.addEventListener('click', () => {
          state.selectedConvId = Number(row.dataset.convId);
          const selected = getSelectedConv();
          if (selected) selected.unread = 0;
          renderConversations();
        });
      });
    }

    renderActiveChat();
  }

  function renderActiveChat() {
    const conv = getSelectedConv();
    if (!conv) return;

    $('#chatAvatar').innerHTML = `
      <span>${escapeHtml(conv.contact.initials)}</span>
      <span class="ch-dot ${channelBadgeClass(conv.channel)}">${channelMiniGlyph(conv.channel)}</span>
    `;
    $('#chatCustomerName').textContent = conv.contact.name;

    const agObj = DATA.agents.find((a) => a.id === conv.assignee);
    const agLabel = conv.assignee === 'queue' ? 'Na Fila' : agObj ? agObj.name.replace(' (Você)', '') : 'Sem atendente';

    $('#chatHeaderPills').innerHTML = `
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

        return `
          <div class="msg-wrap ${m.type}">
            <div class="bubble">
              <div class="bubble-head">
                <span class="bubble-sender">${isPriv ? '🔒 ' : ''}${escapeHtml(m.sender)}</span>
                <span class="bubble-time">${escapeHtml(m.time)}${isOut ? ' ✓✓' : ''}</span>
              </div>
              ${quoteHtml}
              <div>${escapeHtml(m.text)}</div>
            </div>
          </div>
        `;
      })
      .join('');

    canvas.scrollTop = canvas.scrollHeight;
    renderDrawer(conv);
  }

  function renderDrawer(conv) {
    $('#contactProfileBox').innerHTML = `
      <div class="contact-top">
        <div class="avatar lg yellow-avatar">${escapeHtml(conv.contact.initials)}</div>
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

    $('#aiSummaryBox').textContent = conv.summary || 'Atendimento em andamento no SMV Sac.';
  }

  // ========================================================================
  // ENVIAR MENSAGENS & RESPOSTAS RÁPIDAS
  // ========================================================================
  function sendMessage() {
    const input = $('#composerInput');
    const text = input.value.trim();
    if (!text) return;

    const conv = getSelectedConv();
    if (!conv) return;

    conv.messages.push({
      id: 'm_' + Date.now(),
      type: state.privateMode ? 'private' : 'outgoing',
      sender: DATA.currentAgent.name,
      text,
      time: nowTime(),
    });
    conv.updatedAt = nowTime();

    if (!state.privateMode && conv.assignee === 'queue') {
      conv.assignee = DATA.currentAgent.id;
    }

    input.value = '';
    input.style.height = 'auto';
    hideCanned();
    renderConversations();

    if (!state.privateMode && conv.id === state.liveWidgetConvId) {
      renderLiveWidget();
      toast('Mensagem entregue no WebChat do cliente!');
      return;
    }

    if (!state.privateMode && conv.autoCustomerReply && !conv._replied) {
      conv._replied = true;
      $('#typingText').textContent = `${conv.contact.name} está digitando...`;
      $('#typingIndicator').classList.remove('hidden');

      setTimeout(() => {
        $('#typingIndicator').classList.add('hidden');
        conv.messages.push({
          id: 'c_' + Date.now(),
          type: 'incoming',
          sender: conv.contact.name,
          text: conv.autoCustomerReply,
          time: nowTime(),
        });
        conv.updatedAt = nowTime();
        if (state.selectedConvId !== conv.id) conv.unread += 1;
        renderConversations();
        toast(`Nova mensagem de ${conv.contact.name}`);
      }, 1500);
    }
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
  // VIEW 2: CONEXÕES (ESTILO DIGISAC)
  // ========================================================================
  function renderConnections() {
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

    const grid = $('#connectionsGrid');
    if (filtered.length === 0) {
      grid.innerHTML = `<div style="grid-column:1/-1;padding:40px;text-align:center;color:var(--text-muted);">Nenhuma conexão encontrada.</div>`;
    } else {
      grid.innerHTML = filtered
        .map((c) => {
          const cls = c.channel.toLowerCase();
          const icon = c.channel === 'WhatsApp' ? '💬' : c.channel === 'WebChat' ? '🌐' : '📸';
          return `
            <div class="conn-card">
              <div class="conn-card-head">
                <div class="conn-brand-row">
                  <div class="conn-circle ${cls}">${icon}</div>
                  <div style="min-width:0;">
                    <div class="conn-title">${escapeHtml(c.name)}</div>
                    <div class="conn-channel">${escapeHtml(c.channel)}</div>
                  </div>
                </div>
                <button class="icon-btn" data-toggle-archive="${c.id}" title="${c.status === 'active' ? 'Arquivar conexão' : 'Reativar conexão'}">
                  ⋮
                </button>
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
                  <span>${escapeHtml(c.department)}</span>
                </div>
                <div class="conn-status-row">
                  <span class="status-pill ${c.status === 'archived' ? 'archived' : ''}">
                    <i></i> ${c.status === 'active' ? 'Conectado' : 'Arquivada'}
                  </span>
                  ${
                    c.channel === 'WebChat' && c.status === 'active'
                      ? `<button class="conn-action-link" data-open-widget="1">Testar WebChat →</button>`
                      : `<button class="conn-action-link" data-filter-conn="${escapeHtml(c.name)}">Ver fila →</button>`
                  }
                </div>
              </div>
            </div>
          `;
        })
        .join('');

      $$('[data-toggle-archive]').forEach((btn) => {
        btn.onclick = () => {
          const item = state.connections.find((x) => x.id === btn.dataset.toggleArchive);
          if (!item) return;
          item.status = item.status === 'active' ? 'archived' : 'active';
          renderConnections();
          toast(item.status === 'archived' ? `Conexão "${item.name}" arquivada` : `Conexão "${item.name}" reativada!`);
        };
      });

      $$('[data-open-widget]').forEach((btn) => {
        btn.onclick = () => openLiveWidget();
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

  // ========================================================================
  // VIEW 3: CONTATOS
  // ========================================================================
  function renderContacts() {
    const q = ($('#contactsSearchInput').value || '').toLowerCase();
    const list = state.conversations.filter(
      (c) =>
        !q ||
        c.contact.name.toLowerCase().includes(q) ||
        c.contact.phone.toLowerCase().includes(q) ||
        c.contact.email.toLowerCase().includes(q)
    );

    $('#contactsTableBody').innerHTML = list
      .map(
        (c) => `
          <tr>
            <td>
              <div style="display:flex;align-items:center;gap:10px;">
                <div class="avatar xs yellow-avatar">${escapeHtml(c.contact.initials)}</div>
                <div>
                  <div style="font-weight:600;">${escapeHtml(c.contact.name)}</div>
                  <div style="font-size:11.5px;color:var(--text-muted);">${escapeHtml(c.contact.role)}</div>
                </div>
              </div>
            </td>
            <td>
              <div>${escapeHtml(c.contact.phone)}</div>
              <div style="font-size:11.5px;color:var(--text-muted);">${escapeHtml(c.contact.email)}</div>
            </td>
            <td><span class="header-pill connection">${escapeHtml(c.connection)}</span></td>
            <td>${escapeHtml(c.department)}</td>
            <td style="text-align:right;">
              <button class="btn secondary pill" style="padding:6px 13px;font-size:12px;" data-open-conv="${c.id}">Abrir chat</button>
            </td>
          </tr>
        `
      )
      .join('');

    $$('[data-open-conv]').forEach((btn) => {
      btn.onclick = () => {
        state.selectedConvId = Number(btn.dataset.openConv);
        state.tab = 'all';
        state.statusFilter = 'all';
        setView('conversations');
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
  // VIEW 5: SANDBOX IA
  // ========================================================================
  function runAiSandbox(question) {
    const q = question.trim();
    if (!q) return;
    const low = q.toLowerCase();
    let reply = 'Recebi sua dúvida! Posso resolver automaticamente ou direcionar para o departamento ideal no SMV Sac.';
    let tag = '✨ Resposta automática';

    if (low.includes('pix') || low.includes('boleto')) {
      reply = 'Você pode emitir a 2ª via ou gerar o QR Code PIX direto em financeiro.smvsac.com.br com baixa imediata.';
    } else if (low.includes('horário') || low.includes('suporte')) {
      reply = 'Nosso suporte humano atende de segunda a sexta, das 8h às 18h, e a IA do SMV Sac responde 24h por dia!';
    } else if (low.includes('contrato') || low.includes('humano') || low.includes('atendente')) {
      tag = '⚡ Transferência para humano';
      reply = 'Perfeito! Já estou transferindo seu atendimento para um especialista com todo o resumo da conversa.';
    }

    $('#aiSandboxLog').innerHTML = `
      <div class="lw-bubble visitor">${escapeHtml(q)}</div>
      <div class="lw-bubble agent" style="border-color:var(--border-yellow);">
        <div style="font-size:10.5px;font-weight:800;color:var(--yellow-400);margin-bottom:4px;">${tag}</div>
        <div>${escapeHtml(reply)}</div>
      </div>
    `;
  }

  // ========================================================================
  // SIMULADOR LIVE WIDGET (WEBCHAT)
  // ========================================================================
  function ensureLiveWidgetConv() {
    let conv = state.conversations.find((c) => c.id === state.liveWidgetConvId);
    if (!conv) {
      conv = {
        id: 500 + state.conversations.length,
        status: 'open',
        assignee: 'queue',
        connection: 'Atendimento',
        channel: 'WebChat',
        department: 'Suporte',
        unread: 0,
        updatedAt: nowTime(),
        labels: ['Suporte'],
        contact: {
          name: 'Visitante WebChat (Ao Vivo)',
          initials: 'VW',
          role: 'Cliente via Site • SMV Sac',
          phone: 'WebChat',
          email: 'visitante@site.com.br',
        },
        summary: 'Conversa iniciada ao vivo pelo simulador do WebChat.',
        aiSuggestedReply: 'Olá! Que bom falar com você pelo WebChat do SMV Sac. Como posso ajudar hoje?',
        messages: [
          {
            id: 'lw_0',
            type: 'outgoing',
            sender: 'SMV Sac',
            text: 'Olá! 🚀 Bem-vindo ao SMV Sac. Envie uma mensagem aqui e ela aparecerá ao vivo na tela de Conversas!',
            time: nowTime(),
          },
        ],
      };
      state.liveWidgetConvId = conv.id;
      state.conversations.unshift(conv);
    }
    return conv;
  }

  function renderLiveWidget() {
    const conv = ensureLiveWidgetConv();
    const box = $('#lwMessages');
    box.innerHTML = conv.messages
      .filter((m) => m.type === 'incoming' || m.type === 'outgoing')
      .map((m) => `<div class="lw-bubble ${m.type === 'incoming' ? 'visitor' : 'agent'}">${escapeHtml(m.text)}</div>`)
      .join('');
    box.scrollTop = box.scrollHeight;
  }

  function openLiveWidget() {
    ensureLiveWidgetConv();
    renderLiveWidget();
    $('#liveWidgetModal').classList.remove('hidden');
    setTimeout(() => $('#lwInput').focus(), 30);
  }

  function sendFromLiveWidget() {
    const input = $('#lwInput');
    const text = input.value.trim();
    if (!text) return;
    const conv = ensureLiveWidgetConv();
    conv.messages.push({ id: 'lw_' + Date.now(), type: 'incoming', sender: conv.contact.name, text, time: nowTime() });
    conv.status = 'open';
    conv.updatedAt = nowTime();
    input.value = '';
    renderLiveWidget();

    state.selectedConvId = conv.id;
    state.tab = 'all';
    state.statusFilter = 'open';
    setView('conversations');
    toast('💬 Mensagem recebida do WebChat!');
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
      { label: 'Ir para Assistente IA', cat: 'Tela', run: () => setView('ai') },
      { label: 'Abrir Simulador WebChat', cat: 'Demo', run: () => openLiveWidget() },
      ...state.conversations.map((c) => ({
        label: c.contact.name,
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
  // BIND DE EVENTOS
  // ========================================================================
  function bindEvents() {
    $('#brandHomeBtn').addEventListener('click', () => setView('conversations'));

    $$('.top-icon-btn[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => setView(btn.dataset.view));
    });

    // Status agente
    $('#agentStatusToggle').addEventListener('click', () => {
      state.agentStatusIndex = (state.agentStatusIndex + 1) % AGENT_STATUSES.length;
      const st = AGENT_STATUSES[state.agentStatusIndex];
      $('#agentStatusDot').className = `status-dot ${st.key}`;
      toast(`Status: ${st.label}`);
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
    });

    // Nova conversa simulada
    $('#btnNewConversation').addEventListener('click', () => {
      const id = 600 + state.conversations.length;
      state.conversations.unshift({
        id,
        status: 'open',
        assignee: 'queue',
        connection: 'SUPER MEGAVENDAS',
        channel: 'WhatsApp',
        department: 'Suporte',
        unread: 1,
        updatedAt: nowTime(),
        labels: ['Suporte'],
        contact: {
          name: `Novo Cliente #${state.conversations.length + 1}`,
          initials: 'NC',
          role: 'Atendimento WhatsApp',
          phone: '+55 (11) 99001-2244',
          email: 'cliente@empresa.com.br',
        },
        summary: 'Cliente entrou na fila solicitando atendimento rápido.',
        aiSuggestedReply: 'Olá! Seja bem-vindo ao SMV Sac. Em que posso ajudar você agora?',
        autoCustomerReply: 'Ótimo, obrigado pelo retorno rápido!',
        messages: [
          { id: 'n_' + Date.now(), type: 'incoming', sender: `Novo Cliente #${state.conversations.length + 1}`, text: 'Olá! Preciso de uma ajuda rápida com meu cadastro.', time: nowTime() },
        ],
      });
      state.tab = 'queue';
      state.selectedConvId = id;
      renderConversations();
      toast('Nova conversa adicionada à Fila!');
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

    $('#btnTransferQuick').addEventListener('click', () => {
      const conv = getSelectedConv();
      if (conv.assignee === DATA.currentAgent.id) {
        conv.assignee = 'queue';
        toast('Conversa devolvida para a Fila');
      } else {
        conv.assignee = DATA.currentAgent.id;
        toast('Atendimento assumido por você!');
      }
      renderConversations();
    });

    $('#btnToggleDrawer').addEventListener('click', () => $('#detailsDrawer').classList.toggle('hidden'));
    $('#btnCloseDrawer').addEventListener('click', () => $('#detailsDrawer').classList.add('hidden'));

    $('#btnResolveToggle').addEventListener('click', () => {
      const conv = getSelectedConv();
      conv.status = conv.status === 'resolved' ? 'open' : 'resolved';
      conv.messages.push({
        id: 'act_' + Date.now(),
        type: 'activity',
        text: conv.status === 'resolved' ? 'Atendimento finalizado por Lucas Mendes' : 'Atendimento reaberto por Lucas Mendes',
        time: nowTime(),
      });
      renderConversations();
      toast(conv.status === 'resolved' ? 'Atendimento finalizado ✓' : 'Atendimento reaberto');
    });

    // Drawer selects & IA
    $('#selectAgent').addEventListener('change', (e) => {
      getSelectedConv().assignee = e.target.value;
      renderConversations();
    });
    $('#selectDept').addEventListener('change', (e) => {
      getSelectedConv().department = e.target.value;
      renderConversations();
    });
    $('#btnDrawerAiReply').addEventListener('click', () => {
      $('#composerInput').value = getSelectedConv().aiSuggestedReply;
      $('#composerInput').focus();
      toast('Resposta sugerida inserida!');
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
      if ($('#cannedPopover').classList.contains('hidden')) showCanned('');
      else hideCanned();
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

    $('#btnAiDraft').addEventListener('click', () => {
      $('#composerInput').value = getSelectedConv().aiSuggestedReply;
      $('#composerInput').focus();
      toast('✨ Sugestão da IA preenchida!');
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

    // Modal Adicionar Conexão
    const closeConnModal = () => $('#addConnModal').classList.add('hidden');
    $('#btnAddConnection').addEventListener('click', () => {
      $('#newConnName').value = '';
      $('#newConnIdentifier').value = '';
      $('#addConnModal').classList.remove('hidden');
      setTimeout(() => $('#newConnName').focus(), 20);
    });
    $('#btnCloseAddConn').addEventListener('click', closeConnModal);
    $('#btnCancelAddConn').addEventListener('click', closeConnModal);
    $('#btnSaveAddConn').addEventListener('click', () => {
      const name = $('#newConnName').value.trim();
      if (!name) {
        toast('Informe o nome da conexão');
        return;
      }
      state.connections.unshift({
        id: 'conn_' + Date.now(),
        name,
        channel: $('#newConnChannel').value,
        identifier: $('#newConnIdentifier').value.trim() || '-',
        bot: '-',
        department: $('#newConnDept').value,
        status: 'active',
      });
      state.connTab = 'active';
      closeConnModal();
      renderConnections();
      toast(`Conexão "${name}" adicionada e conectada!`);
    });

    // Contatos
    $('#contactsSearchInput').addEventListener('input', renderContacts);

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

    // IA View
    $('#toggleAiAuto').addEventListener('change', (e) => {
      $('#aiAutoLabel').textContent = e.target.checked ? 'Triagem automática ativa' : 'Triagem automática pausada';
    });
    $$('.prompt-chip').forEach((c) => c.addEventListener('click', () => runAiSandbox(c.dataset.q)));
    $('#btnAiSandboxSend').addEventListener('click', () => {
      runAiSandbox($('#aiSandboxInput').value);
      $('#aiSandboxInput').value = '';
    });
    $('#aiSandboxInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#btnAiSandboxSend').click();
    });

    // Live Widget
    $('#btnToggleLiveWidget').addEventListener('click', () => {
      if ($('#liveWidgetModal').classList.contains('hidden')) openLiveWidget();
      else $('#liveWidgetModal').classList.add('hidden');
    });
    $('#btnCloseLiveWidget').addEventListener('click', () => $('#liveWidgetModal').classList.add('hidden'));
    $('#btnLwSend').addEventListener('click', sendFromLiveWidget);
    $('#lwInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendFromLiveWidget();
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

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        $('#btnOpenCommandBar').click();
      } else if (e.key === 'Escape') {
        $('#commandBarModal').classList.add('hidden');
        closeConnModal();
        hideCanned();
      }
    });
  }

  bindEvents();
  setView('conversations');
})();
