/* ==========================================================================
   SMV SAC — CLIENTE DE API REST + SOCKET.IO (REALTIME WHATSAPP BAILEYS)
   ========================================================================== */

(function () {
  const BASE_URL = window.SMV_API_BASE_URL || 'http://localhost:3333';
  const API_PREFIX = `${BASE_URL}/api/v1`;

  let accessToken = null;
  let socket = null;

  async function rawFetch(path, options = {}, retried = false) {
    const headers = new Headers(options.headers || {});
    if (accessToken && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${accessToken}`);
    }
    if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const response = await fetch(`${API_PREFIX}${path}`, {
      ...options,
      headers,
      credentials: 'include',
    });

    if (response.status === 401 && !retried && path !== '/auth/login' && path !== '/auth/refresh') {
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        return rawFetch(path, options, true);
      }
    }

    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : await response.text();

    if (!response.ok) {
      const err = new Error(data?.message || `Erro HTTP ${response.status}`);
      err.status = response.status;
      err.code = data?.error || 'API_ERROR';
      throw err;
    }

    return data;
  }

  async function refreshAccessToken() {
    try {
      const res = await fetch(`${API_PREFIX}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (data?.accessToken) {
        accessToken = data.accessToken;
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  window.SMV_API = {
    BASE_URL,

    setToken(token) {
      accessToken = token || null;
    },

    getToken() {
      return accessToken;
    },

    async checkHealth() {
      const res = await fetch(`${BASE_URL}/health`);
      if (!res.ok) throw new Error('Backend indisponível');
      return res.json();
    },

    // Auth & LGPD
    async login(email, password) {
      const data = await rawFetch('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      accessToken = data.accessToken;
      return data;
    },

    async register(name, email, password) {
      const data = await rawFetch('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ name, email, password }),
      });
      accessToken = data.accessToken;
      return data;
    },

    async logout() {
      try {
        await rawFetch('/auth/logout', { method: 'POST' });
      } catch {
        // Ignora erro de rede ao encerrar
      }
      accessToken = null;
      this.disconnectSocket();
    },

    async recordLgpdConsent(acceptedMarketing = false) {
      return rawFetch('/lgpd/consents', {
        method: 'POST',
        body: JSON.stringify({
          termVersion: '1.0.0',
          acceptedRequired: true,
          acceptedMarketing: Boolean(acceptedMarketing),
          subjectType: 'USER',
        }),
      });
    },

    // Connections + WhatsApp Baileys QR
    getConnections() {
      return rawFetch('/connections');
    },

    createConnection(payload) {
      return rawFetch('/connections', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },

    connectWhatsApp(connectionId) {
      return rawFetch(`/connections/${connectionId}/whatsapp/connect`, {
        method: 'POST',
      });
    },

    getWhatsAppQr(connectionId) {
      return rawFetch(`/connections/${connectionId}/whatsapp/qr`);
    },

    updateConnection(connectionId, payload) {
      return rawFetch(`/connections/${connectionId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
    },

    updateConnectionStatus(connectionId, action) {
      return rawFetch(`/connections/${connectionId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ action }),
      });
    },

    restartConnection(connectionId) {
      return rawFetch(`/connections/${connectionId}/restart`, {
        method: 'POST',
      });
    },

    deleteConnection(connectionId) {
      return rawFetch(`/connections/${connectionId}`, {
        method: 'DELETE',
      });
    },

    // Conversations & Messages
    getConversationsMeta() {
      return rawFetch('/conversations/meta');
    },

    getConversations(params = {}) {
      const qs = new URLSearchParams(params).toString();
      return rawFetch(`/conversations${qs ? `?${qs}` : ''}`);
    },

    markConversationRead(conversationId) {
      return rawFetch(`/conversations/${conversationId}/read`, { method: 'POST' });
    },

    transferConversation(conversationId, payload) {
      return rawFetch(`/conversations/${conversationId}/assign`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
    },

    updateConversationStatus(conversationId, status) {
      return rawFetch(`/conversations/${conversationId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
    },

    getMessages(conversationId) {
      return rawFetch(`/messages/conversation/${conversationId}`);
    },

    sendTextMessage(conversationId, content, visibility = 'PUBLIC') {
      return rawFetch(`/messages/conversation/${conversationId}`, {
        method: 'POST',
        body: JSON.stringify({ content, visibility }),
      });
    },

    sendFileMessage(conversationId, file, caption = '', visibility = 'PUBLIC') {
      const fd = new FormData();
      fd.append('file', file);
      if (caption) fd.append('content', caption);
      fd.append('visibility', visibility);
      return rawFetch(`/messages/conversation/${conversationId}`, {
        method: 'POST',
        body: fd,
      });
    },

    // Socket.IO Realtime
    connectSocket(handlers = {}) {
      this.disconnectSocket();
      if (typeof window.io !== 'function' || !accessToken) {
        return null;
      }

      socket = window.io(BASE_URL, {
        auth: { token: accessToken },
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 2000,
      });

      socket.on('connect', () => {
        if (handlers.onConnect) handlers.onConnect();
      });

      socket.on('disconnect', () => {
        if (handlers.onDisconnect) handlers.onDisconnect();
      });

      socket.on('whatsapp:qr', (payload) => {
        if (handlers.onWhatsAppQr) handlers.onWhatsAppQr(payload);
      });

      socket.on('whatsapp:status', (payload) => {
        if (handlers.onWhatsAppStatus) handlers.onWhatsAppStatus(payload);
      });

      socket.on('whatsapp:history_synced', (payload) => {
        if (handlers.onHistorySynced) handlers.onHistorySynced(payload);
      });

      socket.on('message:created', (payload) => {
        if (handlers.onMessageCreated) handlers.onMessageCreated(payload);
      });

      socket.on('message:status', (payload) => {
        if (handlers.onMessageStatus) handlers.onMessageStatus(payload);
      });

      socket.on('conversation:updated', (payload) => {
        if (handlers.onConversationUpdated) handlers.onConversationUpdated(payload);
      });

      return socket;
    },

    disconnectSocket() {
      if (socket) {
        try {
          socket.disconnect();
        } catch {}
        socket = null;
      }
    },
  };
})();
