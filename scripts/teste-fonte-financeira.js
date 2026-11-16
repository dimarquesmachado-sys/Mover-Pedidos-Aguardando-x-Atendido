'use strict';
/* 16/11 — DE ONDE VEIO A COMISSÃO E O FRETE DE CADA LINHA (docs/NORTE-2026-11.md, P1-4: "financeiro da Magalu falha →
   comissão e frete ZERO e margem completa").

   Prova, com código DE PRODUÇÃO e rede/banco de mentira:
     1) a peça lib/checkout/fonte-financeira: os três valores, a tradução dos nomes internos, a pior fonte, o contador;
        nome desconhecido vira 'ausente' (conservador) — e TODO nome que os produtores usam está traduzido (varre o código);
     2) a caça da Magalu (lib/checkout/magalu-caca): financeiro OK → linha 'real'/'real' com os valores do financeiro; taxa %
        e frete previsto → 'estimado'; financeiro FALHANDO (exceção ou resposta sem ok) → `financeiro.falhas` conta, o erro
        vai pro log, comissão/frete vão NULOS com fonte 'ausente' e a margem fica nula (nunca zero com cara de fechado);
        o estado da caça ganha `aviso_financeiro`; o refazer de PROVISÓRIOS (`refazer: 'provisorios'`) só mira as linhas
        não-reais, só troca quando a fonte MELHOROU, e `cacaMagaluProvisorios` cobre 60 dias;
     3) o motor do backfill (lib/checkout/backfill-motor, pelo `backfillVendas` da Girassol com o contexto da AMB): cada
        linha gravada leva as duas fontes; taxa do Bling → real; Bling sem taxa e sem billing → comissão NULA 'ausente' e
        margem nula; frete da Magalu pelo banco de SKU → 'estimado'; venda fora de marketplace → zero é 'real';
     4) os três leitores do histórico (lib/checkout/historico, pela fachada da GOOD): o agregado devolve
        `totais.financeiro` (completo só com tudo real; contagem por linha, por canal e os pedidos afetados); a lista e a
        busca marcam cada pedido com a pior fonte das linhas dele; linha sem a coluna (gravada antes) conta como ausente;
     5) o painel e o chat de análise avisam quando a margem não está fechada; as três empresas agendam a rotina de
        madrugada que refaz os provisórios. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const F = require('../lib/checkout/fonte-financeira');

/* ───── 1) a peça ───── */
assert.deepStrictEqual(F.VALORES, ['real', 'estimado', 'ausente']);
assert.strictEqual(F.fonteComissao('bling'), 'real'); assert.strictEqual(F.fonteComissao('fatura'), 'real'); assert.strictEqual(F.fonteComissao('magalu_financeiro'), 'real');
assert.strictEqual(F.fonteComissao('magalu_taxa'), 'estimado'); assert.strictEqual(F.fonteComissao('olist'), 'estimado');
assert.strictEqual(F.fonteComissao('zero'), 'ausente'); assert.strictEqual(F.fonteComissao('nao_sei'), 'ausente'); assert.strictEqual(F.fonteComissao('sem_marketplace'), 'real');
assert.strictEqual(F.fonteFrete('previsto'), 'estimado'); assert.strictEqual(F.fonteFrete('magalu_previsto'), 'estimado'); assert.strictEqual(F.fonteFrete('envio'), 'real');
assert.strictEqual(F.fonteFrete('envio_sem_custo'), 'real', 'zero CONFIRMADO pelo ML é real'); assert.strictEqual(F.fonteFrete('nao_sei'), 'ausente'); assert.strictEqual(F.fonteFrete('zero'), 'ausente');
assert.strictEqual(F.fonteComissao('inventado'), 'ausente', 'nome desconhecido vira ausente'); assert.strictEqual(F.fonteFrete(undefined), 'ausente'); assert.strictEqual(F.fonteFrete(''), 'ausente');
assert.strictEqual(F.pior('real', 'real'), 'real'); assert.strictEqual(F.pior('real', 'estimado'), 'estimado'); assert.strictEqual(F.pior('estimado', 'ausente'), 'ausente');
assert.strictEqual(F.pior('real', null), 'ausente', 'fonte nula conta como ausente'); assert.strictEqual(F.pior(undefined, 'estimado'), 'ausente');
assert.strictEqual(F.doConjunto([{ comissao_fonte: 'real', frete_fonte: 'real' }, { comissao_fonte: 'real', frete_fonte: 'estimado' }]), 'estimado');
assert.strictEqual(F.doConjunto([{ comissao_fonte: 'real', frete_fonte: 'real' }]), 'real'); assert.strictEqual(F.doConjunto([]), 'real'); assert.strictEqual(F.doConjunto([{}]), 'ausente');
{ const c = F.contador();
  c.somar({ comissao_fonte: 'real', frete_fonte: 'real' }); c.somar({ comissao_fonte: 'real', frete_fonte: 'estimado' }); c.somar({ comissao_fonte: 'ausente', frete_fonte: 'real' }); c.somar({});
  assert.deepStrictEqual(c.resultado(), { linhas: 4, por_linha: { real: 1, estimado: 1, ausente: 2 }, comissao: { real: 2, estimado: 0, ausente: 2 }, frete: { real: 2, estimado: 1, ausente: 1 }, completo: false });
  const c2 = F.contador(); c2.somar({ comissao_fonte: 'real', frete_fonte: 'real' }); assert.strictEqual(c2.resultado().completo, true);
  assert.strictEqual(F.contador().resultado().completo, false, 'sem linha não é completo');
  const c3 = F.contador(); c3.somar({ comissao_fonte: 'real', frete_fonte: 'estimado' }); assert.strictEqual(c3.resultado().completo, false, 'estimado NÃO é completo (só tudo real)'); }
/* todo nome em uso nos produtores está traduzido (um nome novo sem tradução viraria "ausente" em silêncio) */
{ const fontes = { com: new Set(), fre: new Set() };
  const motor = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'backfill-motor.js'), 'utf8');
  const vdml = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'venda-direta-ml.js'), 'utf8');
  const caca = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'magalu-caca.js'), 'utf8');
  for (const m of motor.matchAll(/comFonte\s*=\s*'(\w+)'/g)) fontes.com.add(m[1]);
  /* as declarações iniciais são ternários (`let comFonte = (comissao > 0) ? 'bling' : 'zero'`, idem freFonte): todo nome citado na linha */
  for (const m of motor.matchAll(/let comFonte = [^\n]*/g)) for (const n of m[0].matchAll(/'(\w+)'/g)) fontes.com.add(n[1]);
  for (const m of motor.matchAll(/let freFonte = [^\n]*/g)) for (const n of m[0].matchAll(/'(\w+)'/g)) fontes.fre.add(n[1]);
  for (const m of motor.matchAll(/freFonte\s*=\s*'(\w+)'/g)) fontes.fre.add(m[1]);
  for (const m of motor.matchAll(/comFonte === 'zero' \? '(\w+)'/g)) fontes.com.add(m[1]);
  for (const m of motor.matchAll(/freFonte === 'zero' \? '(\w+)'/g)) fontes.fre.add(m[1]);
  for (const m of vdml.matchAll(/comFonte: '(\w+)'/g)) fontes.com.add(m[1]);
  for (const m of vdml.matchAll(/freFonte: '(\w+)'/g)) fontes.fre.add(m[1]);
  for (const m of vdml.matchAll(/todas\((?:0|null), '(\w+)'\)/g)) fontes.fre.add(m[1]);
  for (const m of caca.matchAll(/fonteComissao\(([^)]*)\)/g)) for (const n of m[1].matchAll(/'(\w+)'/g)) fontes.com.add(n[1]);
  for (const m of caca.matchAll(/freFonte = (?:[^;]*?)'(\w+)'/g)) fontes.fre.add(m[1]);
  for (const m of caca.matchAll(/'(magalu_\w+)'/g)) { if (/previsto|financeiro/.test(m[1])) fontes.fre.add(m[1]); }
  assert.ok(fontes.com.size >= 10 && fontes.fre.size >= 12, 'a varredura dos nomes achou pouco: ' + [...fontes.com] + ' | ' + [...fontes.fre]);
  for (const n of fontes.com) assert.ok(n in F._mapas.COMISSAO, 'nome de fonte de COMISSÃO em uso sem tradução: ' + n);
  for (const n of fontes.fre) assert.ok(n in F._mapas.FRETE, 'nome de fonte de FRETE em uso sem tradução: ' + n);
  for (const n of ['bling', 'billing', 'sale_fee', 'tiktok', 'escrow', 'zero', 'fatura', 'venda', 'nao_sei', 'magalu_financeiro', 'magalu_taxa', 'olist', 'sem_marketplace']) assert.ok(fontes.com.has(n), 'esperava achar o nome ' + n + ' em uso (comissão)');
  for (const n of ['escrow', 'tiktok', 'bling', 'zero', 'billing', 'previsto', 'olist', 'fatura', 'fatura_no_carrinho', 'fatura_sem_frete', 'sem_envio', 'envio', 'envio_sem_custo', 'envio_no_bling', 'nao_sei', 'magalu_financeiro', 'magalu_previsto', 'sem_marketplace']) assert.ok(fontes.fre.has(n), 'esperava achar o nome ' + n + ' em uso (frete)');
}

(async () => {
  const _st = global.setTimeout; global.setTimeout = (fn, ms, ...a) => _st(fn, ms > 50 ? 0 : ms, ...a);
  const logs = []; const _log = console.log; console.log = (...a) => logs.push(a.join(' '));
  const _err = console.error; console.error = (...a) => logs.push(a.join(' '));
  process.env.ADMIN_KEY = 'adm'; process.env.PORT = '3999';
  let falhou = null;
  try {
    /* ───── 2) a caça da Magalu ───── */
    const { criarCacaMagalu } = require('../lib/checkout/magalu-caca');
    const cenario = (o) => {
      o = o || {};
      const log = [];
      const pedidos = [
        { code: 'M-1', id: 'u1', purchased_at: '2026-10-20T10:00:00Z', status: 'approved', total: 200, itens: [{ sku: 'SK1', desc: 'a', qtd: 2, valor: 100 }] },
        { code: 'M-2', id: 'u2', purchased_at: '2026-10-21T10:00:00Z', status: 'approved', total: 60, itens: [{ sku: 'SK2', desc: 'b', qtd: 1, valor: 60 }] },
      ];
      const fetch = async (url) => {
        const r = (b) => ({ status: 200, ok: true, json: async () => b });
        if (/pedidos-do-dia/.test(url)) return r({ ok: true, pedidos, parcial: false });
        if (/financeiro-lote/.test(url)) {
          if (o.financeiro === 'quebra') throw new Error('ECONNRESET');
          if (o.financeiro === 'semok') return r({ ok: false, erro: 'token da Magalu vencido' });
          if (o.financeiro === 'socomissao') return r({ ok: true, pedidos: { 'M-1': { comissao: -20, mdr: -3, tarifa_fixa: 0 } } });   /* a Magalu já cobrou a comissão; o frete ainda não */
          return r({ ok: true, pedidos: { 'M-1': { frete_debito: -12.5, comissao: -20, mdr: -3, tarifa_fixa: 0 } } });   /* só o M-1 tem financeiro */
        }
        return r(null);
      };
      const supa = { existentes: o.existentes || [], provisorios: o.provisorios || [], antigas: o.antigas || {} };
      const supaReq = async (emp, metodo, pq, body) => {
        log.push(metodo + ' ' + pq + (body ? ' ' + JSON.stringify(body) : ''));
        if (metodo === 'GET' && /or=\(/.test(pq)) return { ok: true, status: 200, body: JSON.stringify(supa.provisorios.map((n) => ({ numero_loja: n }))) };
        if (metodo === 'GET' && /select=numero_loja/.test(pq)) return { ok: true, status: 200, body: JSON.stringify(supa.existentes.map((n) => ({ numero_loja: n }))) };
        if (metodo === 'GET' && /select=\*/.test(pq)) { const m = /numero_loja=eq\.([^&]+)/.exec(pq); return { ok: true, status: 200, body: JSON.stringify(supa.antigas[decodeURIComponent(m[1])] || []) }; }
        if (metodo === 'GET') return { ok: true, status: 200, body: '[]' };
        return { ok: true, status: metodo === 'POST' ? 201 : 204, body: '' };
      };
      const readJson = (arq, d) => {
        if (/_config-fiscal\.json$/.test(arq)) return { aliquotas: { '2026-10': 6.5 }, taxas: { magalu: o.pctMag == null ? 16 : o.pctMag } };
        if (/_custos\.json$/.test(arq)) return { SK1: { custo: 30 }, SK2: { custo: 20 } };
        return d;
      };
      const m = criarCacaMagalu({ empresa: 'amb', supaReq, blingGet: async () => ({ ok: false }), readJson, CACHE_DIR: '/tmp/x', DEFAULT_ALIQ_BK: () => ({}),
        magaluFreteSkuLer: () => (o.semPrevisto ? {} : { SK2: { media: 9.9 } }), reparoAtivo: () => false, histCache: () => ({}), fetch });
      return { m, log, supa };
    };
    const porCod = (r) => Object.fromEntries(r.linhas.map((l) => [l.numero_loja, l]));
    /* financeiro OK: M-1 real/real com os valores do financeiro; M-2 sem financeiro → taxa % (estimado) e frete previsto (estimado) */
    { const { m } = cenario(); const r = await m.magaluLinhas('2026-10-01', '2026-10-28', 'amb', new Set());
      assert.deepStrictEqual(r.financeiro, { lotes: 1, falhas: 0, com_real: 1, frete_real: 1 });
      const L = porCod(r);
      assert.strictEqual(L['M-1'].comissao_fonte, 'real'); assert.strictEqual(L['M-1'].frete_fonte, 'real'); assert.strictEqual(L['M-1'].comissao, 23); assert.strictEqual(L['M-1'].frete_vendedor, 12.5);
      assert.strictEqual(L['M-1'].margem, Math.round((200 - 60 - 23 - 12.5 - 13) * 100) / 100, 'margem do M-1 com tudo real: ' + L['M-1'].margem);
      assert.strictEqual(L['M-2'].comissao_fonte, 'estimado'); assert.strictEqual(L['M-2'].comissao, 9.6, 'taxa de 16% sobre 60');
      assert.strictEqual(L['M-2'].frete_fonte, 'estimado'); assert.strictEqual(L['M-2'].frete_vendedor, 9.9, 'frete previsto do SK2');
      assert.ok(L['M-2'].margem != null, 'estimado tem margem (aproximada), não nula'); }
    /* financeiro FALHANDO (exceção), sem taxa % e sem previsto: conta a falha, loga, e as parcelas vão NULAS com fonte 'ausente' */
    for (const modo of ['quebra', 'semok']) {
      logs.length = 0;
      const { m } = cenario({ financeiro: modo, pctMag: 0, semPrevisto: true }); const r = await m.magaluLinhas('2026-10-01', '2026-10-28', 'amb', new Set());
      assert.deepStrictEqual(r.financeiro, { lotes: 1, falhas: 1, com_real: 0, frete_real: 0 }, modo + ': a falha do financeiro tem que ser contada');
      assert.ok(logs.some((l) => /\[MAGALU\] financeiro-lote (falhou|sem resposta válida)/.test(l) && /2 pedido\(s\) ficam sem comissão\/frete real/.test(l)), modo + ': a falha tem que ir pro log: ' + logs.join(' | '));
      const L = porCod(r);
      for (const c of ['M-1', 'M-2']) {
        assert.strictEqual(L[c].comissao_fonte, 'ausente', modo + ' ' + c); assert.strictEqual(L[c].comissao, null, modo + ' ' + c + ': comissão ausente tem que ir NULA, não zero');
        assert.strictEqual(L[c].frete_fonte, 'ausente'); assert.strictEqual(L[c].frete_vendedor, null);
        assert.strictEqual(L[c].margem, null, modo + ' ' + c + ': margem com parcela ausente é nula (era o bug: zero com cara de fechada)');
        assert.ok(L[c].valor_produto > 0 && L[c].imposto > 0 && L[c].custo != null, 'o resto da linha continua gravado');
      }
      assert.strictEqual(r.erro, null, 'a falha do financeiro não derruba a caça — as vendas entram, marcadas'); }
    /* financeiro falhando mas COM taxa % e previsto: estimado (não ausente) — e a falha segue contada */
    { const { m } = cenario({ financeiro: 'quebra' }); const r = await m.magaluLinhas('2026-10-01', '2026-10-28', 'amb', new Set());
      assert.strictEqual(r.financeiro.falhas, 1); const L = porCod(r);
      assert.strictEqual(L['M-1'].comissao_fonte, 'estimado'); assert.strictEqual(L['M-1'].frete_fonte, 'ausente', 'SK1 não tem previsto'); assert.strictEqual(L['M-1'].margem, null);
      assert.strictEqual(L['M-2'].comissao_fonte, 'estimado'); assert.strictEqual(L['M-2'].frete_fonte, 'estimado'); }
    /* o estado da caça: aviso quando o financeiro falhou; nada quando não */
    { const { m } = cenario({ financeiro: 'quebra' }); const e = await m.cacaMagalu('2026-10-01', '2026-10-28', 'amb');
      assert.ok(/1 de 1 lote\(s\) do financeiro da Magalu falharam/.test(e.aviso_financeiro), 'aviso_financeiro: ' + e.aviso_financeiro); assert.strictEqual(e.financeiro.falhas, 1);
      const { m: m2 } = cenario(); const e2 = await m2.cacaMagalu('2026-10-01', '2026-10-28', 'amb');
      assert.strictEqual(e2.aviso_financeiro, undefined); assert.strictEqual(e2.financeiro.falhas, 0); }
    /* refazer PROVISÓRIOS: só mira não-reais; troca só quando melhorou */
    { const antigasEst = (cod) => [{ id: 1, numero_loja: cod, numero_pedido: 'MG-' + cod, canal: 'magalu', sku: cod === 'M-1' ? 'SK1' : 'SK2', quantidade: cod === 'M-1' ? 2 : 1, comissao: 1, frete_vendedor: 1, comissao_fonte: 'estimado', frete_fonte: 'estimado' }];
      const { m, log } = cenario({ existentes: ['M-1', 'M-2'], provisorios: ['M-1', 'M-2'], antigas: { 'M-1': antigasEst('M-1'), 'M-2': antigasEst('M-2') } });
      const e = await m.cacaMagalu('2026-10-01', '2026-10-28', 'amb', { refazer: 'provisorios' });
      const qAlvos = log.find((l) => /^GET .*or=\(/.test(l));
      assert.ok(qAlvos && /or=\(comissao_fonte\.is\.null,frete_fonte\.is\.null,comissao_fonte\.neq\.real,frete_fonte\.neq\.real\)/.test(qAlvos) && !/sku\.is\.null/.test(qAlvos), 'o filtro dos provisórios: ' + qAlvos);
      assert.strictEqual(e.refazendo, 'provisorios'); assert.strictEqual(e.refazer_alvos, 2);
      /* M-1 ganhou financeiro (real/real) → trocado; M-2 continua estimado → fica como está */
      assert.strictEqual(e.refazer_trocados, 1, 'só o M-1 melhorou: ' + JSON.stringify(e)); assert.strictEqual(e.refazer_sem_melhora, 1);
      assert.ok(log.some((l) => /^DELETE .*numero_loja=eq\.M-1/.test(l)) && !log.some((l) => /^DELETE .*numero_loja=eq\.M-2/.test(l)), 'apagou o errado: ' + log.filter((l) => /^DELETE/.test(l)).join(' | '));
      const post = log.find((l) => /^POST vendas_historico/.test(l)); assert.ok(post && /"numero_loja":"M-1"/.test(post) && /"comissao_fonte":"real"/.test(post) && !/"numero_loja":"M-2"/.test(post), 'gravou o que não devia: ' + post);
      assert.strictEqual(e.inseridos, 2, 'as linhas da Magalu continuam contadas'); }
    /* Codex #913: a troca herda o que não é financeiro (nº do pedido, UF, custo da data da venda) e decide comissão e frete CAMPO A CAMPO */
    { const { m, log } = cenario({ existentes: ['M-1', 'M-2'], provisorios: ['M-1', 'M-2'], antigas: {
        /* a antiga veio do BLING: data e valores DIFERENTES do que a API da Magalu devolve agora (10-19 × 10-20; 190 × 200) — têm que ficar (Codex #914) */
        'M-1': [{ id: 1, empresa: 'amb', numero_loja: 'M-1', numero_pedido: '4455', canal: 'magalu', data_venda: '2026-10-19', sku: 'SK1', descricao: 'Nome do Bling', quantidade: 2, valor_produto: 190, valor_nota: 195, uf: 'SP', custo: 40, imposto: 13, comissao: 1, frete_vendedor: 1, comissao_fonte: 'estimado', frete_fonte: 'estimado' }],
        'M-2': [{ id: 2, empresa: 'amb', numero_loja: 'M-2', numero_pedido: '4456', canal: 'magalu', data_venda: '2026-10-21', sku: 'SK2', descricao: 'b', quantidade: 1, valor_produto: 60, valor_nota: 60, uf: 'RJ', custo: 15, imposto: 3.9, comissao: 7.7, frete_vendedor: null, comissao_fonte: 'real', frete_fonte: 'ausente' }] } });
      const e = await m.cacaMagalu('2026-10-01', '2026-10-28', 'amb', { refazer: 'provisorios' });
      assert.strictEqual(e.refazer_trocados, 2, JSON.stringify(e));
      const posts = log.filter((l) => /^POST vendas_historico/.test(l)).map((l) => JSON.parse(l.replace(/^POST vendas_historico /, ''))).flat();
      const P = Object.fromEntries(posts.map((l) => [l.numero_loja, l]));
      assert.strictEqual(P['M-1'].numero_pedido, '4455'); assert.strictEqual(P['M-1'].uf, 'SP'); assert.strictEqual(P['M-1'].custo, 40, 'custo histórico, não o de hoje (60)');
      assert.strictEqual(P['M-1'].comissao_fonte, 'real'); assert.strictEqual(P['M-1'].comissao, 23);
      assert.deepStrictEqual([P['M-1'].data_venda, P['M-1'].valor_produto, P['M-1'].valor_nota, P['M-1'].descricao, P['M-1'].id], ['2026-10-19', 190, 195, 'Nome do Bling', undefined], 'Codex #914: data, valores e descrição são os da linha gravada (reparo financeiro não mexe em receita nem em período); sem o id antigo: ' + JSON.stringify(P['M-1']));
      assert.strictEqual(P['M-1'].margem, Math.round((190 - 40 - 23 - 12.5 - 13) * 100) / 100, 'margem recalculada com o custo e o valor herdados');
      /* M-2: a comissão REAL que já estava gravada não é trocada pela estimativa; o frete ausente sobe pra estimado */
      assert.strictEqual(P['M-2'].comissao_fonte, 'real'); assert.strictEqual(P['M-2'].comissao, 7.7);
      assert.strictEqual(P['M-2'].frete_fonte, 'estimado'); assert.strictEqual(P['M-2'].frete_vendedor, 9.9); assert.strictEqual(P['M-2'].uf, 'RJ'); }
    /* fonte IGUAL nos dois lados (estimado × estimado): fica o valor GRAVADO, não a estimativa nova — a troca acontece pela comissão (ausente → estimado) */
    { const { m, log } = cenario({ existentes: ['M-2'], provisorios: ['M-2'], antigas: { 'M-2': [{ id: 2, empresa: 'amb', numero_loja: 'M-2', numero_pedido: 'MG-M-2', canal: 'magalu', data_venda: '2026-10-21', sku: 'SK2', quantidade: 1, valor_produto: 60, valor_nota: 60, custo: 20, imposto: 3.9, comissao: null, frete_vendedor: 5.5, comissao_fonte: 'ausente', frete_fonte: 'estimado' }] } });
      const e = await m.cacaMagalu('2026-10-01', '2026-10-28', 'amb', { refazer: 'provisorios' }); assert.strictEqual(e.refazer_trocados, 1, JSON.stringify(e));
      const L2 = JSON.parse(log.find((l) => /^POST vendas_historico/.test(l) && /"numero_loja":"M-2"/.test(l)).replace(/^POST vendas_historico /, ''))[0];
      assert.deepStrictEqual([L2.comissao, L2.comissao_fonte, L2.frete_vendedor, L2.frete_fonte], [9.6, 'estimado', 5.5, 'estimado'], 'frete estimado gravado (5,5) não vira a estimativa nova (9,9): ' + JSON.stringify(L2)); }
    /* linhas que NÃO casam 1:1 (SKU/quantidade diferentes, ou a mais/a menos): a madrugada não troca — conta como divergente, nada apagado */
    for (const [nome, antigas] of [['sku diferente', [{ id: 1, numero_loja: 'M-1', sku: 'OUTRO', quantidade: 2, comissao_fonte: 'estimado', frete_fonte: 'estimado' }]],
                                   ['quantidade diferente', [{ id: 1, numero_loja: 'M-1', sku: 'SK1', quantidade: 1, comissao_fonte: 'estimado', frete_fonte: 'estimado' }]],
                                   ['linha a mais no histórico', [{ id: 1, numero_loja: 'M-1', sku: 'SK1', quantidade: 2, comissao_fonte: 'estimado', frete_fonte: 'estimado' }, { id: 9, numero_loja: 'M-1', sku: 'SK9', quantidade: 1, comissao_fonte: 'estimado', frete_fonte: 'estimado' }]]]) {
      const { m, log } = cenario({ existentes: ['M-1'], provisorios: ['M-1'], antigas: { 'M-1': antigas } });
      const e = await m.cacaMagalu('2026-10-01', '2026-10-28', 'amb', { refazer: 'provisorios' });
      assert.deepStrictEqual([e.refazer_trocados, e.refazer_divergentes, e.refazer_sem_melhora], [0, 1, 0], nome + ': ' + JSON.stringify(e));
      assert.ok(!log.some((l) => /^DELETE/.test(l)) && !log.some((l) => /^POST vendas_historico/.test(l) && /"numero_loja":"M-1"/.test(l)), nome + ': o M-1 não pode ser apagado nem regravado (o M-2, novo, entra): ' + log.filter((l) => /^(DELETE|POST)/.test(l)).join(' | ')); }
    /* ...mas o ?refazer=1 manual troca mesmo divergente (decisão de quem clicou; é o refazer de sempre) */
    { const { m } = cenario({ existentes: ['M-1'], provisorios: ['M-1'], antigas: { 'M-1': [{ id: 1, numero_loja: 'M-1', sku: 'OUTRO', quantidade: 2 }] } });
      const e = await m.cacaMagalu('2026-10-01', '2026-10-28', 'amb', { refazer: true }); assert.strictEqual(e.refazer_trocados, 1, JSON.stringify(e)); }
    /* só a COMISSÃO chegou (real); o frete segue AUSENTE nos dois lados: a pior fonte do pedido não muda (ausente), mas o campo
       melhorou — troca (Codex #913: campo a campo, não a pior do pedido) */
    { const { m, log } = cenario({ financeiro: 'socomissao', semPrevisto: true, existentes: ['M-1'], provisorios: ['M-1'], antigas: { 'M-1': [{ id: 1, numero_loja: 'M-1', sku: 'SK1', quantidade: 2, comissao: 30, frete_vendedor: null, comissao_fonte: 'estimado', frete_fonte: 'ausente' }] } });
      const e = await m.cacaMagalu('2026-10-01', '2026-10-28', 'amb', { refazer: 'provisorios' }); assert.strictEqual(e.refazer_trocados, 1, 'a comissão real tem que entrar mesmo com o frete ainda ausente: ' + JSON.stringify(e));
      const post = log.find((l) => /^POST vendas_historico/.test(l) && /"numero_loja":"M-1"/.test(l)); const L1 = JSON.parse(post.replace(/^POST vendas_historico /, ''))[0];
      assert.deepStrictEqual([L1.comissao, L1.comissao_fonte, L1.frete_vendedor, L1.frete_fonte, L1.margem], [23, 'real', null, 'ausente', null], JSON.stringify(L1)); }
    /* comissão sobe de estimado→real com o frete ainda estimado: troca (antes a pior fonte do pedido igual rejeitava) */
    { const { m } = cenario({ existentes: ['M-1'], provisorios: ['M-1'], antigas: { 'M-1': [{ id: 1, numero_loja: 'M-1', sku: 'SK1', quantidade: 2, comissao: 1, frete_vendedor: 12.5, comissao_fonte: 'estimado', frete_fonte: 'estimado' }] } });
      const e = await m.cacaMagalu('2026-10-01', '2026-10-28', 'amb', { refazer: 'provisorios' }); assert.strictEqual(e.refazer_trocados, 1, JSON.stringify(e)); }
    /* o manual (?refazer=1) pega os DOIS tipos (sem SKU e provisórios) */
    { const { m, log } = cenario({ existentes: ['M-1'], provisorios: ['M-1'], antigas: { 'M-1': [{ id: 1, numero_loja: 'M-1', sku: null, quantidade: 2, comissao_fonte: null, frete_fonte: null }] } });
      const e = await m.cacaMagalu('2026-10-01', '2026-10-28', 'amb', { refazer: true });
      const qAlvos = log.find((l) => /^GET .*or=\(/.test(l)); assert.ok(/or=\(sku\.is\.null,sku\.eq\.,comissao_fonte\.is\.null/.test(qAlvos), qAlvos);
      assert.strictEqual(e.refazendo, true); assert.strictEqual(e.refazer_trocados, 1, 'linha sem fonte (antiga) e sem SKU é trocada pela completa'); }
    /* a rotina de madrugada: 60 dias, refazer de provisórios */
    { const { m, log } = cenario(); const e = await m.cacaMagaluProvisorios();
      assert.strictEqual(e.refazendo, 'provisorios'); const dias = Math.round((new Date(e.ate) - new Date(e.de)) / 86400000); assert.strictEqual(dias, 60, 'janela de 60 dias: ' + e.de + '..' + e.ate);
      assert.ok(log.some((l) => /^GET .*or=\(comissao_fonte/.test(l))); }

    /* ───── 2b) os REPAROS que regravam comissão/frete gravam a fonte junto (Codex #913) ───── */
    {
      /* TikTok (lib/tiktok-completar): a tarifa e o frete do extrato são reais; valor igual com fonte velha ainda repara */
      const dirTk = fs.mkdtempSync(path.join(os.tmpdir(), 'tkf-')); process.env.TIKTOK_CACHE_DIR = dirTk;
      fs.writeFileSync(path.join(dirTk, '_tiktok_financeiro_good.json'), JSON.stringify({ pedidos: { 'TK1': { tarifa: 30, frete_liquido: -4 } } }));
      const { criarCompletadorDaEmpresa } = require('../lib/tiktok-completar');
      const rodarTk = async (linha) => { const patches = []; const supaReq = async (emp, met, cam, corpo) => { if (met === 'PATCH') patches.push(corpo); return { ok: true, status: 200, body: JSON.stringify(met === 'GET' ? (/offset=0\b/.test(cam) ? [linha] : []) : [{ id: linha.id }]) }; };
        const r = await criarCompletadorDaEmpresa('good', { supaReq, aoAtualizar: () => {} })(45, {}); return { r, patches }; };
      const base = { id: 7, numero_pedido: '1', numero_loja: 'TK1', data_venda: '2026-10-01', valor_nota: 100, valor_produto: 100, custo: 40, imposto: 5 };
      let t = await rodarTk(Object.assign({}, base, { comissao: null, frete_vendedor: null, margem: null, comissao_fonte: 'ausente', frete_fonte: 'ausente' }));
      assert.strictEqual(t.patches.length, 1); assert.deepStrictEqual(t.patches[0], { comissao: 30, frete_vendedor: 4, comissao_fonte: 'real', frete_fonte: 'real', margem: 100 - 40 - 30 - 4 - 5 }, 'TikTok: o reparo grava valor E fonte: ' + JSON.stringify(t.patches[0]));
      t = await rodarTk(Object.assign({}, base, { comissao: 30, frete_vendedor: 4, margem: 21, comissao_fonte: 'estimado', frete_fonte: 'real' }));
      assert.strictEqual(t.patches.length, 1, 'valor igual mas fonte estimado: repara (a fonte sobe)'); assert.strictEqual(t.patches[0].comissao_fonte, 'real');
      t = await rodarTk(Object.assign({}, base, { comissao: 30, frete_vendedor: 4, margem: 21, comissao_fonte: 'real', frete_fonte: 'real' }));
      assert.strictEqual(t.patches.length, 0, 'tudo igual e real: nada a fazer'); assert.ok(t.r.ja_ok >= 1 || t.r.pedidos_ja_ok >= 1 || JSON.stringify(t.r).includes('1'), JSON.stringify(t.r));
      /* pescaria do ML (lib/checkout/pescaria-empresa): a comissão pescada é real; com o frete ausente a margem fica nula */
      const { criarPescaria } = require('../lib/checkout/pescaria-empresa');
      const dirPes = fs.mkdtempSync(path.join(os.tmpdir(), 'pesf-'));
      const rodarPes = async (linha) => { const patches = []; const fetchP = async (url) => ({ status: 200, ok: true, json: async () => (/vendas_historico\?/.test(url) ? [linha] : {}), text: async () => '' });
        const supaReq = async (e, m, pq, b) => { if (m === 'PATCH') patches.push({ pq, b }); return { ok: true, status: 204, data: [] }; };
        const m = criarPescaria({ base: { json: (res, c, b) => { res.c = c; res.b = b; }, ehAdmin: () => false, readJson: (a, d) => d, CACHE_DIR: dirPes }, prefixo: '/good-checkout-offline', empresa: 'good', mlTokenManager: () => ({ garantirTokenML: async () => 'tok' }), fetch: fetchP });
        const res = { c: 0, b: null }; process.env.ADMIN_KEY = 'adm';
        await m.rotasPescaria({ validarSessao: () => null, supaCfg: () => ({ url: 'https://supa.teste', key: 'k' }), supaReq, pescarDadosML: async () => ({ fee: 13.5, frete: 0 }) })({ method: 'GET', headers: {} }, res, new URL('http://h/good-checkout-offline/pescar-tarifas?k=adm&pedido=777&gravar=1'));
        return { res, patches }; };
      let pz = await rodarPes({ id: 11, numero_pedido: '777', numero_loja: '2000099', canal: 'ml', data_venda: '2026-10-20', valor_produto: 100, custo: 40, imposto: 8, frete_vendedor: 12, comissao: null, comissao_fonte: 'ausente', frete_fonte: 'real' });
      assert.strictEqual(pz.patches.length, 1, JSON.stringify(pz.res)); assert.ok(/id=eq\.11/.test(pz.patches[0].pq)); assert.deepStrictEqual(pz.patches[0].b, { comissao: 13.5, margem: 100 - 40 - 13.5 - 12 - 8, comissao_fonte: 'real' }, JSON.stringify(pz.patches[0].b));
      pz = await rodarPes({ id: 12, numero_pedido: '777', numero_loja: '2000099', canal: 'ml', data_venda: '2026-10-20', valor_produto: 100, custo: 40, imposto: 8, frete_vendedor: null, comissao: null, comissao_fonte: 'ausente', frete_fonte: 'ausente' });
      assert.deepStrictEqual(pz.patches[0].b, { comissao: 13.5, margem: null, comissao_fonte: 'real' }, 'frete ausente: a margem fica nula, não soma zero: ' + JSON.stringify(pz.patches[0].b));
    }

    /* ───── 3) o motor do backfill ───── */
    {
      const dirGir = fs.mkdtempSync(path.join(os.tmpdir(), 'gir-')), dirTk = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-')), dirAmb = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-'));
      process.env.GIRABKP_CACHE_DIR = dirGir; process.env.TIKTOK_CACHE_DIR = dirTk;
      fs.writeFileSync(path.join(dirAmb, '_custos.json'), JSON.stringify({ A1: { custo: 20 }, M1: { custo: 30 }, B1: { custo: 5 } }));
      fs.writeFileSync(path.join(dirAmb, '_config-fiscal.json'), JSON.stringify({ aliquotas: { '2026-10': 9.5 }, taxas: { magalu: 16 } }));
      const fetchStub = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '{}' });
      require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: fetchStub };
      const LJ = { ml: 206017293, magalu: 206018666, balcao: 777 };
      const pedidos = [
        { id: 1, numero: 9001, nl: '2000011111111111', lj: LJ.ml, sit: 9, itens: [{ codigo: 'A1', quantidade: 2, valor: 50 }], taxas: { taxaComissao: 14, custoFrete: 9 } },       /* taxa do Bling: real/real */
        { id: 2, numero: 9002, nl: '2000022222222222', lj: LJ.ml, sit: 9, itens: [{ codigo: 'A1', quantidade: 1, valor: 50 }], taxas: { taxaComissao: 0, custoFrete: 9 } },        /* ML sem taxa no Bling, sem billing: comissão AUSENTE */
        { id: 5, numero: 9005, nl: 'LU-555', lj: LJ.magalu, sit: 9, itens: [{ codigo: 'M1', quantidade: 1, valor: 90 }], taxas: { taxaComissao: 14.4, custoFrete: 0 } },           /* Magalu sem frete: previsto (estimado) */
        { id: 7, numero: 9007, nl: '', lj: LJ.balcao, sit: 9, itens: [{ codigo: 'B1', quantidade: 1, valor: 10 }], taxas: { taxaComissao: 0, custoFrete: 0 } },                  /* fora de marketplace: zero é real */
      ];
      const blingGet = async (p) => {
        if (/^\/situacoes\/modulos$/.test(p)) return { ok: true, status: 200, data: { data: [{ id: 98310, nome: 'Vendas' }] } };
        if (/^\/situacoes\/modulos\/98310$/.test(p)) return { ok: true, status: 200, data: { data: [{ id: 12, nome: 'Cancelado' }, { id: 9, nome: 'Atendido' }] } };
        if (/^\/pedidos\/vendas\?/.test(p)) return { ok: true, status: 200, data: { data: /pagina=1(&|$)/.test(p) ? pedidos.map((x) => ({ id: x.id, numero: x.numero, numeroLoja: x.nl, data: '2026-10-05', situacao: { id: x.sit }, loja: { id: x.lj } })) : [] } };
        const m = /^\/pedidos\/vendas\/(\d+)$/.exec(p);
        if (m) { const x = pedidos.find((y) => String(y.id) === m[1]);
          return { ok: true, status: 200, data: { data: { id: x.id, numero: x.numero, numeroPedidoLoja: x.nl, numeroLoja: x.nl, data: '2026-10-05', situacao: { id: x.sit }, loja: { id: x.lj },
            itens: x.itens.map((it) => Object.assign({ descricao: 'p ' + it.codigo }, it)), total: x.itens.reduce((a, it) => a + it.valor * it.quantidade, 0), taxas: x.taxas, contato: { endereco: { uf: 'SP' } }, transporte: {} } } }; }
        return { ok: true, status: 200, data: { data: [] } };
      };
      const readJson = (f, pad) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return pad; } };
      const comum = require('../amb-checkout-offline/comum');
      const gbo = require(path.join(raiz, 'girassol-backup-offline', 'gbo-app.js'));
      const gravadas = [];
      const supaReq = async (emp, met, q, body) => { if (met === 'POST' && Array.isArray(body)) gravadas.push(...body.map((l) => Object.assign({}, l))); return { ok: true, status: met === 'POST' ? 201 : 200, body: '[]' }; };
      const estado = { rodando: false, empresa: null, de: null, ate: null, pagina: 0, pedidos: 0, itens: 0, gravados: 0, erros: 0, fase: 'parado', inicio: null, fim: null, msg: '' };
      const ctx = { estadoBackfill: estado, blingGet, readJson, CACHE_DIR: dirAmb, supaReq, supaCount: async () => 4,
        DEFAULT_ALIQ_BK: { '2026-10': 9.5 }, aliqReserva: 14.1, custoVigenteEm: () => null, mapasBilling: async () => ({ com: {}, fre: {} }), garantirTokenML: async () => null,
        escrowEmLote: async () => ({}), escrowDoPedido: async () => null, LOJA_MKT: { [LJ.ml]: 'ml', [LJ.magalu]: 'magalu' }, magaluFreteSkuLer: () => ({ M1: { media: 13.3 } }),
        creditosFlex: async () => ({}), magaluLinhas: async () => ({ linhas: [], pedidos: 0, na_magalu: 0, parcial: false, erro: null }), cacaMagaluRodando: () => false, canarioRodando: () => false, reparoAtivo: () => false,
        ehFlex: comum.ehFlex, garantirSitCancel: async () => ({ ids: [12] }) };
      const r = await gbo.backfillVendas('2026-10-05', '2026-10-05', 'amb', ctx);
      assert.ok(r && r.ok, 'o backfill tinha que rodar: ' + JSON.stringify(r).slice(0, 300));
      const vh = gravadas.filter((l) => l.empresa === 'amb' && l.sku);
      assert.ok(vh.length >= 4, 'linhas gravadas: ' + vh.length);
      for (const l of vh) { assert.ok(F.VALORES.includes(l.comissao_fonte), 'linha sem comissao_fonte: ' + JSON.stringify(l)); assert.ok(F.VALORES.includes(l.frete_fonte), 'linha sem frete_fonte: ' + JSON.stringify(l)); }
      const por = (n) => vh.find((l) => String(l.numero_pedido) === String(n));
      assert.strictEqual(por(9001).comissao_fonte, 'real'); assert.strictEqual(por(9001).frete_fonte, 'real'); assert.strictEqual(por(9001).comissao, 14); assert.ok(por(9001).margem != null);
      assert.strictEqual(por(9002).comissao_fonte, 'ausente', 'ML sem taxa no Bling e sem billing'); assert.strictEqual(por(9002).comissao, null, 'comissão ausente vai NULA'); assert.strictEqual(por(9002).margem, null, 'margem com parcela ausente é nula');
      assert.strictEqual(por(9002).frete_fonte, 'real'); assert.strictEqual(por(9002).frete_vendedor, 9);
      assert.strictEqual(por(9005).frete_fonte, 'estimado', 'frete da Magalu pelo banco de SKU'); assert.strictEqual(por(9005).frete_vendedor, 13.3); assert.strictEqual(por(9005).comissao_fonte, 'real');
      assert.strictEqual(por(9007).comissao_fonte, 'real', 'fora de marketplace: zero é o valor'); assert.strictEqual(por(9007).frete_fonte, 'real'); assert.strictEqual(por(9007).comissao, 0); assert.strictEqual(por(9007).frete_vendedor, 0); assert.ok(por(9007).margem != null);
    }

    /* ───── 4) os três leitores ───── */
    {
      let roteiro = [];
      const fakeFetch = async () => { const r = roteiro.length ? roteiro.shift() : []; return { ok: true, status: 200, json: async () => r, text: async () => JSON.stringify(r) }; };
      require.cache[require.resolve('node-fetch')].exports = fakeFetch;
      process.env.ADMIN_KEY = 'chave-teste';
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-'));
      let resp = null; const json = (res, st, o) => { resp = o; };
      const histCache = {};
      const h = require('../good-checkout-offline/historico-good').rotasHistorico({ validarSessao: () => null, supaCfg: () => ({ url: 'https://supa.test', key: 'k' }), histCache, CACHE_DIR: tmp, json });
      const chama = async (rota, qs) => { resp = null; for (const k of Object.keys(histCache)) delete histCache[k]; await h({ method: 'GET', headers: {} }, {}, new URL('http://x/good-checkout-offline' + rota + '?k=chave-teste&' + qs)); return resp; };
      const linha = (n, extra) => Object.assign({ numero_pedido: n, numero_loja: 'L' + n, canal: 'ml', data_venda: '2026-10-05', sku: 'S1', descricao: 'p', quantidade: 1, valor_produto: 100, valor_nota: 100, custo: 20, comissao: 12, frete_vendedor: 3, imposto: 10, margem: 55, uf: 'SP', comissao_fonte: 'real', frete_fonte: 'real' }, extra);
      const L = [linha('1001', {}), linha('1002', { frete_fonte: 'estimado', canal: 'magalu' }), linha('1002', { sku: 'S2' }), linha('1003', { comissao_fonte: 'ausente', comissao: null, margem: null, canal: 'magalu' }), linha('1004', { comissao_fonte: undefined, frete_fonte: undefined })];
      roteiro = [L]; const a = await chama('/historico-longo', 'de=2026-10-01&ate=2026-10-13');
      assert.ok(a && a.ok, 'longo: ' + JSON.stringify(a).slice(0, 200));
      const fin = a.totais.financeiro;
      assert.deepStrictEqual({ linhas: fin.linhas, por_linha: fin.por_linha, comissao: fin.comissao, frete: fin.frete, completo: fin.completo, pedidos_nao_reais: fin.pedidos_nao_reais },
        { linhas: 5, por_linha: { real: 2, estimado: 1, ausente: 2 }, comissao: { real: 3, estimado: 0, ausente: 2 }, frete: { real: 3, estimado: 1, ausente: 1 }, completo: false, pedidos_nao_reais: 3 }, 'totais.financeiro: ' + JSON.stringify(fin));
      assert.deepStrictEqual(fin.por_canal, { magalu: { estimado: 1, ausente: 1 }, ml: { estimado: 0, ausente: 1 } }, 'por canal: ' + JSON.stringify(fin.por_canal));
      /* o select pede as colunas novas (sem isto tudo contaria como ausente) */
      roteiro = [[linha('1001', {})]]; const a2 = await chama('/historico-longo', 'de=2026-10-01&ate=2026-10-13&fresh=1');
      assert.strictEqual(a2.totais.financeiro.completo, true, 'tudo real → completo'); assert.strictEqual(a2.totais.financeiro.pedidos_nao_reais, 0);
      const src = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'historico.js'), 'utf8');
      assert.strictEqual((src.match(/,margem,uf,comissao_fonte,frete_fonte'/g) || []).length, 3, 'as três leituras (lista, longo, busca) têm que pedir as duas colunas');
      /* lista: a pior fonte do pedido */
      roteiro = [[{ numero_pedido: '1001' }, { numero_pedido: '1002' }, { numero_pedido: '1003' }, { numero_pedido: '1004' }], L]; const b = await chama('/historico-linhas', 'de=2026-10-01&ate=2026-10-13&pagina=1');
      const pd = Object.fromEntries(b.pedidos.map((p) => [p.numero, p]));
      assert.strictEqual(pd['1001'].financeiro, 'real'); assert.strictEqual(pd['1002'].financeiro, 'estimado', 'uma linha estimada marca o pedido'); assert.strictEqual(pd['1003'].financeiro, 'ausente'); assert.strictEqual(pd['1004'].financeiro, 'ausente', 'sem a coluna = ausente');
      assert.strictEqual(pd['1003'].margem_incompleta, true, 'comissão nula continua tirando a margem do total (como já era)');
      /* busca */
      roteiro = [[{ numero_pedido: '1002' }], [], [], L.filter((l) => l.numero_pedido === '1002')]; const c = await chama('/buscar-lucro', 'q=1002');   /* exato, id-fuzzy, produto, e as linhas */
      assert.ok(c && c.pedidos && c.pedidos[0], 'busca: ' + JSON.stringify(c).slice(0, 200)); assert.strictEqual(c.pedidos[0].financeiro, 'estimado');
    }

    /* ───── 5) painel, chat, rotina ───── */
    {
      const dash = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'painel', 'dashboard.html'), 'utf8');
      assert.ok(/HIST\.totais\.financeiro/.test(dash) && /margem N\\u00c3O fechada/.test(dash) && /pedidos_nao_reais/.test(dash), 'o card do lucro tem que avisar quando a margem não está fechada');
      assert.ok(/o\.financeiro==='ausente'/.test(dash) && /o\.financeiro==='estimado'/.test(dash), 'a lista de pedidos tem que marcar estimado/ausente');
      assert.ok(/'Margem %','Fonte comissao\/frete'\]/.test(dash) && /pcm,\n\s*\(o\.financeiro\|\|''\)/.test(dash), 'a exportação CSV leva a coluna da fonte, na posição do cabeçalho');
      /* o trecho do card roda de verdade (é uma IIFE dentro do HTML): com margem não fechada avisa; com tudo real, nada */
      { const ini = dash.indexOf("(function(){ const f=(usaHist&&HIST.totais&&HIST.totais.financeiro)||null;"); assert.ok(ini > 0, 'cadê a IIFE do aviso?');
        const fim = dash.indexOf('})()', ini) + 4; const iife = dash.slice(ini, fim);
        const roda = (financeiro) => new Function('usaHist', 'HIST', 'N', 'return ' + iife + ';')(true, { totais: { financeiro } }, (x) => String(x));
        const aviso = roda({ linhas: 50, por_linha: { real: 40, estimado: 7, ausente: 3 }, completo: false, pedidos_nao_reais: 6, por_canal: { magalu: { estimado: 7, ausente: 3 } } });
        assert.ok(/margem N\u00c3O fechada: 6 pedido\(s\)/.test(aviso) && /AUSENTE \(3 linha/.test(aviso) && /ESTIMADO \(7 linha/.test(aviso) && /magalu 10/.test(aviso), 'o card: ' + aviso);
        assert.strictEqual(roda({ linhas: 50, por_linha: { real: 50, estimado: 0, ausente: 0 }, completo: true, pedidos_nao_reais: 0, por_canal: {} }), '', 'tudo real: sem aviso');
        assert.ok(/ESTIMADO \(2 linha/.test(roda({ linhas: 5, por_linha: { real: 3, estimado: 2, ausente: 0 }, completo: false, pedidos_nao_reais: 1, por_canal: {} })), 'só estimado também avisa');
        assert.strictEqual(roda(null), ''); }
      /* o chat de análise: o resumo do período avisa a margem não fechada (com o agregado de mentira, pela ferramenta real) */
      const C = require('../lib/checkout/chat-analise');
      const dChat = (financeiro) => ({ ok: true, totais: { faturamento: 1000, pedidos: 10, unidades: 10, margem: 100, financeiro }, canais: {}, dias: {}, skus: [], skus_total: 0 });
      const per = { de: '2026-10-01', ate: '2026-10-31' };
      let { F: FC } = C.criarFerramentas({ hoje: '2026-11-16', consultarHistorico: async () => dChat({ linhas: 50, por_linha: { real: 40, estimado: 7, ausente: 3 }, completo: false, pedidos_nao_reais: 6 }) });
      let rc = await FC.resumo_periodo(per);
      assert.ok(rc.avisos.some((a) => /6 pedido\(s\) de 2026-10-01 a 2026-10-31 estão com comissão ou frete AUSENTE \(3 linha\(s\).*INFLADA\) ou ESTIMADO \(7 linha\(s\).*: a margem desse período NÃO está fechada/.test(a)), 'faltou o aviso do chat: ' + JSON.stringify(rc.avisos));
      ({ F: FC } = C.criarFerramentas({ hoje: '2026-11-16', consultarHistorico: async () => dChat({ linhas: 50, por_linha: { real: 48, estimado: 2, ausente: 0 }, completo: false, pedidos_nao_reais: 1 }) }));
      rc = await FC.resumo_periodo(per);
      assert.ok(rc.avisos.some((a) => /1 pedido\(s\).*ESTIMADO \(2 linha\(s\).*NÃO está fechada/.test(a) && !/AUSENTE/.test(a)), 'só estimado também avisa: ' + JSON.stringify(rc.avisos));
      ({ F: FC } = C.criarFerramentas({ hoje: '2026-11-16', consultarHistorico: async () => dChat({ linhas: 50, por_linha: { real: 50, estimado: 0, ausente: 0 }, completo: true, pedidos_nao_reais: 0 }) }));
      rc = await FC.resumo_periodo(per);
      assert.ok(!rc.avisos.some((a) => /NÃO está fechada/.test(a)), 'com tudo real não há aviso');
      for (const [arq, acc] of [['girassol-backup-offline/gbo-app.js', '_cacaMgGir'], ['amb-checkout-offline/index.js', '_cacaMgAmb'], ['good-checkout-offline/index.js', '_cacaMgGood']]) {
        const mod = require(path.join(raiz, arq)); const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
        assert.strictEqual(typeof mod.rotinas.cacaMagaluProvisorios, 'function', arq + ': falta a rotina dos provisórios');
        assert.ok(/^(\d+) (\d) \* \* \*$/.test(mod.crons.cacaMagaluProvisorios) && Number(mod.crons.cacaMagaluProvisorios.split(' ')[1]) <= 4, arq + ': a rotina dos provisórios é de madrugada: ' + mod.crons.cacaMagaluProvisorios);
        assert.ok(s.includes('cacaMagaluProvisorios: () => ' + acc + '.cacaMagaluProvisorios()'), arq + ': a rotina tem que ser a da peça da empresa');
      }
    }
  } catch (e) { falhou = e; }
  finally { console.log = _log; console.error = _err; global.setTimeout = _st; }
  if (falhou) { console.error('FALHOU:', falhou.stack || falhou.message); process.exit(1); }
  console.log('ok — a fonte da comissão e do frete vai gravada em cada linha (real | estimado | ausente); parcela ausente é NULA e tira a margem do total; a caça da Magalu não engole a falha do financeiro, avisa, e refaz os provisórios de madrugada quando o financeiro chega; agregado, lista, busca, painel e chat dizem quando a margem não está fechada');
})();
