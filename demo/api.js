/* ==========================================================================
   SMV SAC — CLIENTE DE API REST + SOCKET.IO (REALTIME WHATSAPP BAILEYS)
   ========================================================================== */

(function () {
  const rawBaseUrl =
    (window.SMV_CONFIG && window.SMV_CONFIG.API_URL) ||
    window.SMV_API_BASE_URL ||
    'http://localhost:3333';
  const BASE_URL = String(rawBaseUrl).replace(/\/+$/, '');
  const API_PREFIX = `${BASE_URL}/api/v1`;

  let accessToken = null;
  let refreshToken = null;
  let socket = null;
  let socketScriptPromise = null;

  function ensureSocketIoClient() {
    if (typeof window.io === 'function') return Promise.resolve(true);
    if (socketScriptPromise) return socketScriptPromise;
    socketScriptPromise = new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = `${BASE_URL}/socket.io/socket.io.js`;
      script.async = true;
      script.onload = () => resolve(typeof window.io === 'function');
      script.onerror = () => resolve(false);
      document.head.appendChild(script);
    });
    return socketScriptPromise;
  }

  async function rawFetch(path, options = {}, retried = false) {
    const headers = new Headers(options.headers || {});
    if (accessToken && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${accessToken}`);
    }
    if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    let response;
    try {
      response = await fetch(`${API_PREFIX}${path}`, {
        ...options,
        headers,
        credentials: 'include',
      });
    } catch (networkErr) {
      const err = new Error('Não foi possível conectar ao servidor back-end. Verifique se a API está online.');
      err.status = 0;
      err.code = 'NETWORK_ERROR';
      err.isNetworkError = true;
      err.cause = networkErr;
      throw err;
    }

    if (response.status === 401 && !retried && path !== '/auth/login' && path !== '/auth/refresh') {
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        return rawFetch(path, options, true);
      }
    }

    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : await response.text();

    if (!response.ok) {
      const firstFieldError =
        data?.details && typeof data.details === 'object'
          ? Object.values(data.details)
            .flat()
            .find((msg) => typeof msg === 'string' && msg.trim().length > 0)
          : null;
      const err = new Error(firstFieldError || data?.message || `Erro HTTP ${response.status}`);
      err.status = response.status;
      err.code = data?.error || 'API_ERROR';
      err.details = data?.details;
      err.isNetworkError = false;
      throw err;
    }

    return data;
  }

  async function refreshAccessToken() {
    try {
      const res = await fetch(`${API_PREFIX}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: refreshToken ? { 'Content-Type': 'application/json' } : undefined,
        body: refreshToken ? JSON.stringify({ refreshToken }) : undefined,
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (data?.accessToken) {
        accessToken = data.accessToken;
        if (data.refreshToken) refreshToken = data.refreshToken;
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  window.SMV_API = {
    BASE_URL,

    setToken(token, nextRefreshToken) {
      accessToken = token || null;
      if (nextRefreshToken !== undefined) {
        refreshToken = nextRefreshToken || null;
      } else if (!token) {
        refreshToken = null;
      }
    },

    getToken() {
      return accessToken;
    },

    getRefreshToken() {
      return refreshToken;
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
      refreshToken = data.refreshToken || null;
      return data;
    },

    async register(name, email, password) {
      const data = await rawFetch('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ name, email, password }),
      });
      if (data?.accessToken) {
        accessToken = data.accessToken;
        refreshToken = data.refreshToken || null;
      }
      return data;
    },

    async getMe() {
      return rawFetch('/auth/me');
    },

    async logout() {
      try {
        await rawFetch('/auth/logout', { method: 'POST' });
      } catch {
        // Ignora erro de rede ao encerrar
      }
      accessToken = null;
      refreshToken = null;
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

    // Gestão de Usuários (apenas Administrador)
    getUsers() {
      return rawFetch('/users');
    },

    createUser(payload) {
      return rawFetch('/users', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },

    updateUser(userId, payload) {
      return rawFetch(`/users/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
    },

    resetUserPassword(userId, password) {
      return rawFetch(`/users/${userId}/password`, {
        method: 'PATCH',
        body: JSON.stringify({ password }),
      });
    },

    updateUserRole(userId, role) {
      return rawFetch(`/users/${userId}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      });
    },

    approveUser(userId, payload = {}) {
      return rawFetch(`/users/${userId}/approve`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
    },

    rejectUser(userId) {
      return rawFetch(`/users/${userId}/reject`, {
        method: 'POST',
      });
    },

    deleteUser(userId) {
      return rawFetch(`/users/${userId}`, {
        method: 'DELETE',
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

    syncConnectionContacts(connectionId) {
      return rawFetch(`/connections/${connectionId}/sync-contacts`, {
        method: 'POST',
      });
    },

    deleteConnection(connectionId) {
      return rawFetch(`/connections/${connectionId}`, {
        method: 'DELETE',
      });
    },

    // Contacts & Agenda Search
    getContacts(params = {}) {
      const clean = {};
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') clean[k] = String(v);
      });
      const qs = new URLSearchParams(clean).toString();
      return rawFetch(`/contacts${qs ? `?${qs}` : ''}`);
    },

    createContact(payload) {
      return rawFetch('/contacts', {
        method: 'POST',
        body: JSON.stringify(payload),
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

    openOrCreateConversation(payload) {
      return rawFetch('/conversations', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },

    markConversationRead(conversationId) {
      return rawFetch(`/conversations/${conversationId}/read`, { method: 'POST' });
    },

    subscribeConversationPresence(conversationId) {
      return rawFetch(`/conversations/${conversationId}/presence/subscribe`, { method: 'POST' });
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

    // Socket.IO Realtime (carrega socket.io.js dinamicamente a partir de BASE_URL para funcionar no Vercel e localhost)
    connectSocket(handlers = {}) {
      this.disconnectSocket();
      if (!accessToken) return null;

      const openNow = () => {
        if (typeof window.io !== 'function' || !accessToken) return null;

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

        socket.on('whatsapp:connection_deleted', (payload) => {
          if (handlers.onConnectionDeleted) handlers.onConnectionDeleted(payload);
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

        socket.on('conversation:presence', (payload) => {
          if (handlers.onConversationPresence) handlers.onConversationPresence(payload);
        });

        socket.on('contact:avatar_updated', (payload) => {
          if (handlers.onContactAvatarUpdated) handlers.onContactAvatarUpdated(payload);
        });

        socket.on('whatsapp:contacts_synced', (payload) => {
          if (handlers.onContactsSynced) handlers.onContactsSynced(payload);
        });

        return socket;
      };

      if (typeof window.io === 'function') {
        return openNow();
      }

      void ensureSocketIoClient().then((loaded) => {
        if (loaded) openNow();
      });
      return null;
    },

    disconnectSocket() {
      if (socket) {
        try {
          socket.disconnect();
        } catch { }
        socket = null;
      }
    },
  };
})();
