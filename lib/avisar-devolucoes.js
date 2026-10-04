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
    const _rotulo = '[avisar-devolucoes] ' + String(empresa || '?') + ' ' + String(tipo || '?') +
                    ' ' + String(codigo || '?');
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname,
      method: 'POST',
      timeout: 6000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo) },
    /* ⚠️ 04/10 (Codex #608) — "FIRE-AND-FORGET" VIRAVA "NUNCA SOUBE". Este ajudante ignorava o
       status da resposta, engolia erro de rede com um ouvinte VAZIO e engolia o próprio erro
       síncrono no catch do fim. Resultado: a NF era anexada, a rota respondia ok:true, e o aviso
       podia nunca chegar — sem uma linha de log em lugar nenhum. Foi assim que o caminho de
       require quebrado (achado G) ficou escondido.
       Continua fire-and-forget — não bloqueia nem derruba o checkout —, mas TODA falha aparece:
       é a diferença entre "o Devoluções não tem a NF" ser um mistério ou ser um log. */
    }, (res) => {
      /* 4xx/5xx significa que o Devoluções RECUSOU — some igual a erro de rede */
      if (res.statusCode >= 300) {
        let corpoRes = '';
        res.on('data', (d) => { if (corpoRes.length < 300) corpoRes += String(d); });
        res.on('end', () => console.error(_rotulo + ': o Devoluções respondeu HTTP ' +
          res.statusCode + ' — ' + corpoRes.slice(0, 160)));
        return;
      }
      res.resume();
    });
    req.on('error', (e) => console.error(_rotulo + ': falha de rede — ' + (e && e.message)));
    req.on('timeout', () => {
      console.error(_rotulo + ': tempo esgotado (6s) — o aviso NÃO chegou');
      try { req.destroy(); } catch (e) {}
    });
    req.end(corpo);
  } catch (e) {
    /* o erro SÍNCRONO (URL malformada, env estranha) também era engolido */
    console.error('[avisar-devolucoes] não consegui nem montar o aviso: ' + (e && e.message));
  }
};
