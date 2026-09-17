'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   ROTAS DE BACKFILL DO HISTÓRICO — terceira fatia do passo 4 (16/09/2026).

   Três rotas de corpo idêntico nas três empresas e coesas: completar o detalhe do
   pedido, completar a NF e completar os valores — os três buracos que o histórico
   deixa quando a venda entra sem um dado que só aparece depois.

   ⚠️ COMO AS FATIAS ANTERIORES ENSINARAM: este handler NÃO valida sessão. Quem o
   registra PRECISA fazê-lo DEPOIS do portão de sessão do módulo — no #480 a
   delegação foi parar no topo do handle e duas rotas passaram a responder sem
   autenticação. Conferido para estas três, nas três empresas, que todas ficam
   depois do portão; `scripts/teste-rotas-backfill.js` trava a posição.
   ──────────────────────────────────────────────────────────────────────────── */

function criar(cfg) {
  /* o lint pegou o que minha varredura de dependências perdeu: `_bf` e `_bfd` não são
     valores, são ESTADO VIVO — objetos de status que estas rotas leem e escrevem enquanto o
     backfill roda. Extrair as funções sem eles é o mesmo erro do base.js (levar a função e
     deixar o que ela lê). Entram por referência, e a empresa continua dona deles: dois
     backfills de empresas diferentes não podem compartilhar contador. */
  for (const n of ['prefixo', 'json', 'readJson', 'writeJson', 'ehAdmin', 'lerChaveAdmin',
                   'detalhePedido', 'backfillNFLocal', 'dorme', 'CONFERIDOS_FILE',
                   'statusValores', 'statusDetalhes']) {
    if (!cfg || cfg[n] == null) throw new Error('lib/checkout/rotas-backfill: falta ' + n);
  }
  const { prefixo, json, readJson, writeJson, ehAdmin, lerChaveAdmin,
          detalhePedido, backfillNFLocal, dorme, CONFERIDOS_FILE } = cfg;
  const _bf = cfg.statusValores;     /* MESMA referência do módulo — não copiar */
  const _bfd = cfg.statusDetalhes;

  return async function handle(req, res, urlObj, method, validarSessao) {
    const p = urlObj.pathname;

    if ((method === 'POST' || method === 'GET') && p === (prefixo + '/backfill-detalhes')) {
      const k = lerChaveAdmin(req, urlObj);
      if (!process.env.ADMIN_KEY || k !== process.env.ADMIN_KEY) { json(res, 404, { error: 'not found' }); return true; }
      if (_bfd.rodando) { json(res, 200, { ok: true, rodando: true, progresso: _bfd.feitos + '/' + _bfd.total, ok_ate_agora: _bfd.ok, falhas: _bfd.falhas, iniciado_em: _bfd.iniciado_em }); return true; }
      const dias = Math.max(1, Math.min(120, Number(urlObj.searchParams.get('dias') || 31)));
      const corte = Date.now() - dias * 86400000;
      const confIni = readJson(CONFERIDOS_FILE, {});
      const alvos = Object.keys(confIni).filter(id => {
        const c = confIni[id];
        if (!c || !c.conferido_em || new Date(c.conferido_em).getTime() < corte) return false;
        const semItemValor = Array.isArray(c.itens) && c.itens.length && c.itens.some(it => it.valor_total == null);
        return c.uf == null || c.valor == null || semItemValor;
      });
      if (!alvos.length) { json(res, 200, { ok: true, mensagem: 'nada a preencher — últimos ' + dias + ' dias já têm UF e valores por item' }); return true; }
      _bfd = { rodando: true, feitos: 0, total: alvos.length, ok: 0, falhas: 0, iniciado_em: new Date().toISOString() };
      json(res, 200, { ok: true, iniciado: true, pedidos_a_detalhar: alvos.length, dias, mensagem: 'backfill de detalhes rodando (~' + Math.ceil(alvos.length * 0.5 / 60) + ' min) — chame de novo pra ver o progresso' });
      (async () => {
        const dorme = ms => new Promise(r => setTimeout(r, ms));
        const pend = {};
        const salvar = () => {
          if (!Object.keys(pend).length) return;
          const c2 = readJson(CONFERIDOS_FILE, {});
          for (const [id, d] of Object.entries(pend)) {
            if (!c2[id]) continue;
            if (d.valor != null && c2[id].valor == null) c2[id].valor = d.valor;
            if (d.uf) c2[id].uf = d.uf;
            if (d.municipio) c2[id].municipio = d.municipio;
            if (d.taxa_mkt != null && c2[id].taxa_mkt == null) c2[id].taxa_mkt = d.taxa_mkt;
            if (d.venda_dia && !c2[id].venda_dia) c2[id].venda_dia = d.venda_dia;
            if (d.frete_mkt != null && c2[id].frete_mkt == null) c2[id].frete_mkt = d.frete_mkt;
            if (d.porSku && Array.isArray(c2[id].itens)) {
              c2[id].itens.forEach(it => {
                const v = d.porSku[String(it.sku || '').trim()];
                if (v != null && it.valor_total == null) { it.valor_unit = v; it.valor_total = v * Number(it.qtd || 1); }
              });
            }
          }
          writeJson(CONFERIDOS_FILE, c2);
          for (const id of Object.keys(pend)) delete pend[id];
        };
        for (const id of alvos) {
          try {
            const det = await detalhePedido(id);
            if (det) {
              const porSku = {};
              (det.itens || []).forEach(it => { const c = String(it.codigo || (it.produto && it.produto.codigo) || '').trim(); if (c && it.valor != null) porSku[c] = Number(it.valor); });
              pend[id] = {
                valor: (det.total != null ? Number(det.total) : null),
                uf: (det.transporte && det.transporte.etiqueta && det.transporte.etiqueta.uf) || null,
                municipio: (det.transporte && det.transporte.etiqueta && det.transporte.etiqueta.municipio) || null,
                venda_dia: (det.data ? String(det.data).slice(0, 10) : null),
                taxa_mkt: (det.taxas && isFinite(Number(det.taxas.taxaComissao)) && Number(det.taxas.taxaComissao) > 0) ? Math.round(Number(det.taxas.taxaComissao) * 100) / 100 : null,
                frete_mkt: (det.taxas && isFinite(Number(det.taxas.custoFrete)) && Number(det.taxas.custoFrete) > 0) ? Math.round(Number(det.taxas.custoFrete) * 100) / 100 : null,
                porSku
              };
              _bfd.ok++;
            } else _bfd.falhas++;
          } catch (e) { _bfd.falhas++; }
          _bfd.feitos++;
          if (_bfd.feitos % 15 === 0) { salvar(); console.log(`[BACKFILL-DET] ${_bfd.feitos}/${_bfd.total}`); }
          await dorme(400);
        }
        salvar(); _bfd.rodando = false;
        console.log(`[BACKFILL-DET] ✔ concluído: ${_bfd.ok} ok, ${_bfd.falhas} falha(s) de ${_bfd.total}`);
      })().catch(e => { _bfd.rodando = false; console.log('[BACKFILL-DET] ✗ ' + e.message); });
      return true;
    }
    if ((method === 'POST' || method === 'GET') && p === (prefixo + '/backfill-nf')) {
      const k = lerChaveAdmin(req, urlObj);
      const sessB = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (sessB && ehAdmin(sessB)))) { json(res, 404, { error: 'not found' }); return true; }
      const r = backfillNFLocal(urlObj.searchParams.get('dias'));
      json(res, 200, { ok: true, ...r,
        mensagem: r.preenchidos_pela_nf ? ('✓ ' + r.preenchidos_pela_nf + ' pedido(s) ganharam produtos/frete EXATOS da nota (leitura local, sem API)') : 'nada novo a preencher' });
      return true;
    }
    if ((method === 'POST' || method === 'GET') && p === (prefixo + '/backfill-valores')) {
      const k = lerChaveAdmin(req, urlObj);
      if (!process.env.ADMIN_KEY || k !== process.env.ADMIN_KEY) { json(res, 404, { error: 'not found' }); return true; }
      if (_bf.rodando) { json(res, 200, { ok: true, rodando: true, progresso: _bf.feitos + '/' + _bf.total, ok_ate_agora: _bf.ok, falhas: _bf.falhas, iniciado_em: _bf.iniciado_em }); return true; }
      const dias = Math.max(1, Math.min(120, Number(urlObj.searchParams.get('dias') || 31)));
      const corte = Date.now() - dias * 86400000;
      const confIni = readJson(CONFERIDOS_FILE, {});
      const alvos = Object.keys(confIni).filter(id => {
        const c = confIni[id];
        return c && (c.valor == null) && c.conferido_em && new Date(c.conferido_em).getTime() >= corte;
      });
      if (!alvos.length) { json(res, 200, { ok: true, mensagem: 'nada a preencher — todos os finalizados dos últimos ' + dias + ' dias já têm valor' }); return true; }
      _bf = { rodando: true, feitos: 0, total: alvos.length, ok: 0, falhas: 0, iniciado_em: new Date().toISOString() };
      json(res, 200, { ok: true, iniciado: true, pedidos_sem_valor: alvos.length, dias, mensagem: 'backfill rodando em background (~' + Math.ceil(alvos.length * 0.5 / 60) + ' min) — chame esta URL de novo pra ver o progresso' });
      (async () => {
        const dorme = ms => new Promise(r => setTimeout(r, ms));
        const pendentes = {};
        const salvar = () => {
          if (!Object.keys(pendentes).length) return;
          const c2 = readJson(CONFERIDOS_FILE, {});
          for (const [id, v] of Object.entries(pendentes)) { if (c2[id]) c2[id].valor = v; }
          writeJson(CONFERIDOS_FILE, c2);
          for (const id of Object.keys(pendentes)) delete pendentes[id];
        };
        for (const id of alvos) {
          try {
            const det = await detalhePedido(id);
            if (det && det.total != null && isFinite(Number(det.total))) { pendentes[id] = Number(det.total); _bf.ok++; }
            else _bf.falhas++;
          } catch (e) { _bf.falhas++; }
          _bf.feitos++;
          if (_bf.feitos % 15 === 0) { salvar(); console.log(`[BACKFILL] ${_bf.feitos}/${_bf.total} (ok=${_bf.ok} falhas=${_bf.falhas})`); }
          await dorme(400);
        }
        salvar();
        _bf.rodando = false;
        console.log(`[BACKFILL] ✔ concluído: ${_bf.ok} valor(es) preenchido(s), ${_bf.falhas} falha(s) de ${_bf.total}`);
      })().catch(e => { _bf.rodando = false; console.log('[BACKFILL] ✗ ' + e.message); });
      return true;
    }
    return false;
  };
}

module.exports = { criar };
