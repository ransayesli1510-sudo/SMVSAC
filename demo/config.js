/* ==========================================================================
   SMV SAC — CONFIGURAÇÃO DE AMBIENTE (LOCALHOST vs PRODUÇÃO VERCEL)
   Carregado antes de api.js.
   Em produção no Vercel, defina PRODUCTION_API_URL abaixo (ou via <meta name="smv-api-url">).
   ========================================================================== */
(function () {
  var existing = window.SMV_CONFIG || {};
  var host = window.location.hostname;
  var isLocal =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '' ||
    window.location.protocol === 'file:';

  var metaApi = document.querySelector('meta[name="smv-api-url"]');
  var metaApiUrl = metaApi && metaApi.content ? metaApi.content.trim() : '';

  // URL do servidor Node.js contínuo em produção (Railway / Render / VPS)
  var PRODUCTION_API_URL =
    existing.API_URL ||
    metaApiUrl ||
    'https://web-production-3f15bd90.up.railway.app';

  var resolvedApiUrl = (isLocal ? 'http://localhost:3333' : PRODUCTION_API_URL).replace(/\/+$/, '');

  window.SMV_CONFIG = Object.assign({}, existing, {
    ENV: isLocal ? 'development' : 'production',
    IS_LOCAL: isLocal,
    API_URL: resolvedApiUrl,
  });

  window.SMV_API_BASE_URL = resolvedApiUrl;
})();
