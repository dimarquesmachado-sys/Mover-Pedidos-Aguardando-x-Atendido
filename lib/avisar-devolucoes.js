'use strict';
// ev1 - AVISA O APP DEVOLUCOES de eventos do checkout (etiqueta anexada,
// NF gerada...), pra ficarem registrados e pesquisaveis la depois.
// Fire-and-forget: qualquer falha e SILENCIOSA e nunca atrapalha o
// checkout. Sem as envs configuradas, vira no-op.
// Envs (servico Mover-Pedidos-Aguardando-x-Atendido, aba Environment):
//   DEVOLUCOES_URL = https://good-devolucoes-x-marketplaces-x-nfsbling.onrender.com
//   DEVOLUCOES_KEY = a ADMIN_KEY do servico de Devolucoes
module.exports = function avisarDevolucoes(empresa, tipo, codigo, extra) {
  try {
    const URL_BASE = process.env.DEVOLUCOES_URL || '';
    const KEY = process.env.DEVOLUCOES_KEY || '';
    if (!URL_BASE || !KEY || !codigo) return;
    const u = new URL(URL_BASE.replace(/\/+$/, '') + '/api/interno/evento-checkout');
    const mod = u.protocol === 'http:' ? require('http') : require('https');
    const corpo = JSON.stringify({
      k: KEY,
      empresa: String(empresa || ''),
      tipo: String(tipo || ''),
      codigo: String(codigo || ''),
      extra: (extra && typeof extra === 'object') ? extra : {},
    });
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname,
      method: 'POST',
      timeout: 6000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo) },
    }, (res) => { res.resume(); });
    req.on('error', () => {});
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} });
    req.end(corpo);
  } catch (e) {}
};
