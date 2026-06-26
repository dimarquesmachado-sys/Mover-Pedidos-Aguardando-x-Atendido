'use strict';

/**
 * GOOD Checkout Offline — Diagnóstico (READ-ONLY) — temporário
 * Só LÊ do Bling da GOOD: lojas (dos pedidos recentes) + situações. NÃO move nada.
 * Uso:  GET /good-checkout-offline/diag?op=diag2026
 * Remover depois: apague a linha require('../good-checkout-offline') do config/empresas.js
 */

const { garantirToken } = require('../good/tokenManager');
const BLING = 'https://api.bling.com.br/Api/v3';

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj, null, 2));
}

function routes(readBody) {
  return async function handle(req, res, urlObj) {
    const { method } = req;
    const p = urlObj.pathname;

    if (p === '/good-checkout-offline/diag' && method === 'GET') {
      if ((urlObj.searchParams.get('op') || '') !== 'diag2026') {
        json(res, 403, { ok: false, erro: 'use ?op=diag2026' });
        return true;
      }
      try {
        const token = await garantirToken();
        const H = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

        // ── LOJAS: varre pedidos recentes (qualquer situação), agrupa por loja ──
        const lojas = {};
        for (let pg = 1; pg <= 6; pg++) {
          const r = await fetch(`${BLING}/pedidos/vendas?limite=100&pagina=${pg}`, { headers: H });
          if (!r.ok) break;
          const j = await r.json();
          const arr = (j && j.data) || [];
          if (!arr.length) break;
          for (const o of arr) {
            const lid = o.loja && o.loja.id;
            if (!lid) continue;
            const k = String(lid);
            if (!lojas[k]) lojas[k] = { idLoja: lid, qtd: 0, exemplo_numero: o.numero, exemplo_pedido_id: o.id, situacoes_vistas: {} };
            lojas[k].qtd++;
            const sid = o.situacao && o.situacao.id;
            if (sid) lojas[k].situacoes_vistas[sid] = (lojas[k].situacoes_vistas[sid] || 0) + 1;
          }
          await new Promise(s => setTimeout(s, 400));
        }

        // ── SITUAÇÕES (id + nome) — melhor esforço, nunca quebra a resposta ──
        let situacoes_modulos = null;
        try {
          const rs = await fetch(`${BLING}/situacoes/modulos`, { headers: H });
          situacoes_modulos = rs.ok ? await rs.json() : { httpStatus: rs.status, body: (await rs.text()).slice(0, 600) };
        } catch (e) { situacoes_modulos = { erro: e.message }; }

        json(res, 200, {
          ok: true,
          lojas: Object.values(lojas),
          situacoes_modulos,
          dica: 'LOJAS: veja o exemplo_numero de cada idLoja no Bling p/ saber o marketplace. SITUACOES: ache ATENDIDO/AGUARDANDO/VERIFICADO/DESPACHADO e seus IDs (situacoes_vistas mostra quais situacoes os pedidos estao usando).'
        });
      } catch (e) {
        json(res, 500, { ok: false, erro: e.message });
      }
      return true;
    }

    return false;
  };
}

module.exports = { id: 'good-checkout-offline', nome: 'GOOD Checkout Offline (diag read-only)', rotinas: {}, routes, crons: {} };
