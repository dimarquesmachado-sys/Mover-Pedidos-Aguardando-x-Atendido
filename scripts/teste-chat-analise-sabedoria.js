'use strict';
/* 14/11 — CHAT DE ANÁLISE: O DIA CONTRA O MESMO DIA DA SEMANA, O CALENDÁRIO COMERCIAL E O AVISO DOS DIAS RECENTES.

   Vieram da 1ª resposta do chat em produção (AMB, pergunta sobre a sexta 13/11). O dono: "essa resposta meio fraca… ele
   puxou só mês 10 em diante, podia no mínimo considerar 3 meses"; "11/11 foi data promocional mesmo, tem o ano todo 1/1
   2/2 3/3 etc até 12/12"; "como assim, tem divergência de dados do faturamento?!" (o card Ontem dizia R$ 3.490,91 · 32
   pedidos, a consulta leu R$ 3.158,22 · 30 — e o modelo mandou o dono "conferir de onde vem o seu número").

   O que se prova, com as funções de PRODUÇÃO (as consultas de lib/checkout/chat-analise.js lendo o `/historico-longo`
   de verdade, pela fachada da GOOD; só o banco e a API da Anthropic são de mentira):
   A. CALENDÁRIO (lib/checkout/chat-calendario.js): Páscoa, Carnaval, Corpus Christi, Black Friday, Dia das Mães/Pais e
      as 12 datas duplas caem nos dias certos (datas conhecidas de vários anos); o que fica perto de um dia.
   B. comparar_mesmo_dia_da_semana: pega SÓ o mesmo dia da semana, 13 semanas por padrão; média, mediana, ticket, posição
      e as diferenças batem com a conta feita à mão sobre as vendas; dia sem venda é zero de verdade; com a leitura
      cortada, o que ficou depois do corte é "não disponível" (nunca zero) e o dia analisado fora da leitura é erro.
   C. calendario_comercial: datas do período, inclusive futuras; não lê a base.
   D. resumo e comparação de períodos levam as datas do calendário de dentro de cada período.
   E. AVISO DOS DIAS RECENTES: período que encosta nos últimos 3 dias avisa das duas fontes; período mais antigo, não.
   F. Pela rota: as duas consultas novas vão na lista pra API, as regras novas estão no prompt, o passo aparece na tela,
      o calendário não conta como consulta à base. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let _chegouAoFim = false;
process.on('exit', (code) => { if (!_chegouAoFim && code === 0) { console.error('FALHOU: o teste acabou SEM chegar ao fim (alguma espera nunca terminou)'); process.exitCode = 1; } });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-sabedoria-'));
process.env.ADMIN_KEY = 'chave-adm';
process.env.GOODBKP_ADMIN = 'dono';
process.env.GOODBKP_CACHE_DIR = TMP;
process.env.ANTHROPIC_API_KEY_DASHBOARD_CHAT = 'sk-ant-teste-123';
delete process.env.DASHBOARD_CHAT_MODELO; delete process.env.DASHBOARD_CHAT_MAX_DIA;

let LINHAS = [];
const api = { pedidos: [], roteiro: [] };
const supa = { pedidos: 0 };
function sse(evs) { return evs.map((e) => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join(''); }
function turno({ texto, usos, entrada, saida }) {
  const evs = [{ type: 'message_start', message: { usage: { input_tokens: entrada, output_tokens: 1 } } }];
  let i = 0;
  if (texto) { evs.push({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: texto } }, { type: 'content_block_stop', index: i }); i++; }
  for (const u of (usos || [])) {
    evs.push({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: u.id, name: u.name, input: {} } }, { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(u.input) } }, { type: 'content_block_stop', index: i }); i++;
  }
  evs.push({ type: 'message_delta', delta: { stop_reason: (usos || []).length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: saida } }, { type: 'message_stop' });
  const b = Buffer.from(sse(evs), 'utf8');
  return { ok: true, status: 200, text: async () => '', body: (async function* () { for (let k = 0; k < b.length; k += 61) yield b.subarray(k, k + 61); })() };
}
const fakeFetch = async (url, opts) => {
  url = String(url);
  if (url.startsWith('https://api.anthropic.com/')) {
    const corpo = JSON.parse(opts.body);
    api.pedidos.push({ corpo });
    const passo = api.roteiro.shift();
    if (!passo) throw new Error('a API foi chamada mais vezes do que o roteiro previa');
    return passo;
  }
  let r = [];
  const m = /vendas_historico.*data_venda=gte\.(\d{4}-\d{2}-\d{2})&data_venda=lte\.(\d{4}-\d{2}-\d{2}).*offset=(\d+)/.exec(url);
  if (m) { supa.pedidos++; r = m[3] === '0' ? LINHAS.filter((l) => l.data_venda >= m[1] && l.data_venda <= m[2]) : []; }
  return { ok: true, status: 200, json: async () => r, text: async () => JSON.stringify(r) };
};
require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: fakeFetch };

/* 1 linha = 1 pedido de 1 unidade */
let _n = 0;
function vender(dia, preco, vezes, canal) {
  for (let i = 0; i < vezes; i++) LINHAS.push({ numero_pedido: 'PED' + (800000 + (++_n)), numero_loja: 'LOJA-' + _n, canal: canal || 'ml', data_venda: dia, sku: 'ITEM-1', descricao: 'Item de teste', quantidade: 1,
    valor_produto: preco, valor_nota: preco, custo: Math.round(preco * 0.4 * 100) / 100, comissao: Math.round(preco * 0.15 * 100) / 100, frete_vendedor: 0, imposto: Math.round(preco * 0.05 * 100) / 100,
    margem: Math.round(preco * 0.4 * 100) / 100, uf: 'SP' });
}
/* AS SEXTAS: a analisada (13/11) e as 13 anteriores, da mais recente pra mais antiga — [dia, preço, pedidos] */
const SEXTAS = [['2026-11-13', 100, 3],
  ['2026-11-06', 100, 6], ['2026-10-30', 100, 7], ['2026-10-23', 100, 5], ['2026-10-16', 100, 4], ['2026-10-09', 100, 6], ['2026-10-02', 100, 8], ['2026-09-25', 100, 0],
  ['2026-09-18', 100, 5], ['2026-09-11', 200, 10], ['2026-09-04', 100, 5], ['2026-08-28', 100, 6], ['2026-08-21', 100, 5], ['2026-08-14', 100, 4]];
for (const [dia, preco, n] of SEXTAS) vender(dia, preco, n);
/* o que NÃO pode entrar na conta das sextas: os outros dias da semana (o 11.11 enorme, a quinta, o sábado) e a 14ª sexta pra trás */
vender('2026-11-11', 100, 20); vender('2026-11-12', 100, 5); vender('2026-11-07', 100, 9); vender('2026-11-14', 100, 2); vender('2026-08-07', 900, 30);
/* AS SEGUNDAS de outubro pra trás (o 12/10 é feriado e Dia das Crianças; o 07/09 é feriado) */
for (const [dia, n] of [['2026-10-12', 9], ['2026-10-05', 4], ['2026-09-28', 4], ['2026-09-21', 4], ['2026-09-14', 4], ['2026-09-07', 2]]) vender(dia, 50, n, 'shopee');

const C = require('../lib/checkout/chat-analise');
const CAL = require('../lib/checkout/chat-calendario');
const histCache = {};
const sessao = (ck) => (ck === 'sess=dono' ? 'dono' : null);
const h = require('../good-checkout-offline/historico-good').rotasHistorico({ validarSessao: sessao, supaCfg: () => ({ url: 'https://supa.test', key: 'k' }), histCache, CACHE_DIR: TMP,
  json: (res, st, o) => { res._json = [st, o]; } });
const P = '/good-checkout-offline';
const novoRes = () => ({ _json: null, _cab: null, _txt: '', writeHead(s, c) { this._cab = [s, c]; }, setHeader() {}, write(x) { this._txt += String(x); return true; }, end(x) { if (x != null) this._txt += String(x); }, on() {} });
/* o `/historico-longo` de produção, do jeito que a rota do chat pede (por dentro, com a lista inteira de itens) */
const porDentro = async (de, ate) => { const res = novoRes(); await h({ method: 'GET', headers: { 'x-admin-key': 'chave-adm' } }, res, new URL('http://x' + P + '/historico-longo?de=' + de + '&ate=' + ate + '&skus=todos')); return res._json[1]; };
const HOJE = '2026-11-14';   /* sábado */
const novasF = (consultar) => C.criarFerramentas({ hoje: HOJE, consultarHistorico: consultar || porDentro });
const r2 = (v) => Math.round(v * 100) / 100;
const rejeita = async (p, re, msg) => { let e = null; try { await p; } catch (x) { e = x; } assert.ok(e && re.test(e.message), msg + ' — veio: ' + (e ? e.message : 'sem erro')); };

(async () => {
  const _log = console.log, _err = console.error; console.log = () => {}; console.error = () => {};
  try {
    /* ═══ A. O CALENDÁRIO ═══ */
    {
      assert.deepStrictEqual([2024, 2025, 2026, 2027, 2030].map(CAL.pascoa), ['2024-03-31', '2025-04-20', '2026-04-05', '2027-03-28', '2030-04-21'], 'domingo de Páscoa');
      const nomes = (dia) => CAL.eventosDoDia(dia).map((e) => e.nome);
      const tem = (dia, re) => nomes(dia).some((n) => re.test(n));
      for (const [dia, re] of [['2024-11-29', /^Black Friday$/], ['2025-11-28', /^Black Friday$/], ['2026-11-27', /^Black Friday$/], ['2027-11-26', /^Black Friday$/], ['2026-11-30', /^Cyber Monday$/],
        ['2026-05-10', /^Dia das Mães$/], ['2025-05-11', /^Dia das Mães$/], ['2026-08-09', /^Dia dos Pais$/], ['2025-08-10', /^Dia dos Pais$/], ['2026-02-17', /^Carnaval \(terça-feira\)$/], ['2026-02-16', /^Carnaval \(segunda-feira\)$/],
        ['2025-03-04', /^Carnaval \(terça-feira\)$/], ['2026-04-03', /^Sexta-feira Santa$/], ['2026-06-04', /^Corpus Christi$/], ['2026-03-15', /^Dia do Consumidor$/], ['2026-06-12', /^Dia dos Namorados$/],
        ['2026-10-12', /^Dia das Crianças$/], ['2026-10-12', /^Nossa Senhora Aparecida$/], ['2026-11-20', /^Dia da Consciência Negra$/], ['2026-11-15', /^Proclamação da República$/], ['2026-12-25', /^Natal$/], ['2026-01-01', /Ano-Novo/]]) {
        assert.ok(tem(dia, re), dia + ' tinha que ser ' + re + ' — veio ' + JSON.stringify(nomes(dia)));
      }
      /* as 12 datas duplas do ano, e SÓ elas */
      const duplas = CAL.calendario('2026-01-01', '2026-12-31').filter((x) => x.eventos.some((e) => e.tipo === 'data dupla')).map((x) => x.dia);
      assert.deepStrictEqual(duplas, ['2026-01-01', '2026-02-02', '2026-03-03', '2026-04-04', '2026-05-05', '2026-06-06', '2026-07-07', '2026-08-08', '2026-09-09', '2026-10-10', '2026-11-11', '2026-12-12']);
      assert.ok(/^11\.11 — data dupla/.test(nomes('2026-11-11')[0]) && nomes('2026-11-13').length === 0 && nomes('2026-11-28').length === 0, 'dia comum não tem evento; a véspera/o dia seguinte da Black Friday não são a Black Friday');
      assert.deepStrictEqual(CAL.eventosDoDia('lixo'), []);
      /* o período: em ordem, com o dia da semana certo, atravessando a virada do ano */
      const virada = CAL.calendario('2026-12-20', '2027-01-05');
      assert.deepStrictEqual(virada.map((x) => [x.dia, x.dia_da_semana]), [['2026-12-25', 'sexta-feira'], ['2027-01-01', 'sexta-feira']]);
      assert.deepStrictEqual(CAL.calendario('2026-11-12', '2026-11-14'), []);
      assert.deepStrictEqual(CAL.calendario('2026-11-15', '2026-11-11'), [], 'período invertido não devolve nada');
      /* o que fica perto de um dia (sem o próprio dia): a sexta 13/11 tinha o 11.11 dois dias antes e o feriado dois depois */
      assert.deepStrictEqual(CAL.proximos('2026-11-13', 3).map((x) => [x.dia, x.dias_de_distancia, x.eventos[0].tipo]), [['2026-11-11', -2, 'data dupla'], ['2026-11-15', 2, 'feriado nacional']]);
      assert.deepStrictEqual(CAL.proximos('2026-11-11', 3).map((x) => x.dia), [], 'o próprio dia não é "perto" dele mesmo');
      assert.deepStrictEqual(CAL.proximos('2026-11-13', 1), []);
    }

    /* ═══ B. O DIA CONTRA O MESMO DIA DA SEMANA ═══ */
    {
      const F = novasF().F;
      const r = await F.comparar_mesmo_dia_da_semana({ dia: '2026-11-13' });
      /* a conta à mão, direto da lista das sextas */
      const ant = SEXTAS.slice(1).map(([dia, preco, n]) => ({ dia, fat: preco * n, ped: n }));
      const fats = ant.map((x) => x.fat), peds = ant.map((x) => x.ped);
      const media = (a) => a.reduce((t, x) => t + x, 0) / a.length;
      const mediana = (a) => { const o = a.slice().sort((x, y) => x - y); return o[(o.length - 1) / 2]; };   /* 13 valores: o do meio */
      assert.strictEqual(ant.length, 13);
      const base = await porDentro('2026-08-14', '2026-11-13');
      assert.deepStrictEqual(r.dia_analisado, { dia_da_semana: 'sexta-feira', dia: '2026-11-13', faturamento: 300, pedidos: 3, ticket_medio: 100, margem: r2(base.dias['2026-11-13'].mar), sem_venda_no_dia: undefined, calendario: undefined });
      assert.ok(r.dia_analisado.margem > 0 && base.dias['2026-11-13'].fat === 300 && base.dias['2026-11-13'].pedidos === 3, 'os números do dia são os do /historico-longo');
      assert.strictEqual(r.comparado_com, '13 sexta-feira(s) anteriores, de 2026-08-14 a 2026-11-06');
      assert.deepStrictEqual(r.semana_a_semana_da_mais_recente_pra_mais_antiga.map((x) => [x.dia, x.faturamento, x.pedidos]), ant.map((x) => [x.dia, x.fat, x.ped]), 'só as 13 sextas anteriores, da mais recente pra mais antiga — nenhum outro dia da semana, nem a 14ª');
      assert.deepStrictEqual(r.nas_anteriores, { faturamento_medio: r2(media(fats)), faturamento_mediano: mediana(fats), pedidos_medio: r2(media(peds)), pedidos_mediano: mediana(peds), ticket_medio: r2(8100 / 71),
        menor_faturamento: { dia: '2026-09-25', faturamento: 0 }, maior_faturamento: { dia: '2026-09-11', faturamento: 2000 }, dias_sem_venda: 1 });
      assert.deepStrictEqual([r.nas_anteriores.faturamento_medio, r.nas_anteriores.faturamento_mediano, r.nas_anteriores.pedidos_medio, r.nas_anteriores.pedidos_mediano, r.nas_anteriores.ticket_medio], [623.08, 500, 5.46, 5, 114.08]);
      assert.deepStrictEqual(r.o_dia_contra_a_media.faturamento, { antes: 623.08, depois: 300, diferenca: r2(300 - 8100 / 13), diferenca_pct: r2(((300 - 8100 / 13) / (8100 / 13)) * 100) });
      assert.deepStrictEqual([r.o_dia_contra_a_media.faturamento.diferenca, r.o_dia_contra_a_media.faturamento.diferenca_pct], [-323.08, -51.85]);
      assert.deepStrictEqual(r.o_dia_contra_a_media.pedidos, { antes: 5.46, depois: 3, diferenca: r2(3 - 71 / 13), diferenca_pct: r2(((3 - 71 / 13) / (71 / 13)) * 100) });
      assert.deepStrictEqual(r.o_dia_contra_a_media.ticket_medio, { antes: 114.08, depois: 100, diferenca: r2(100 - 8100 / 71), diferenca_pct: r2(((100 - 8100 / 71) / (8100 / 71)) * 100) });
      assert.deepStrictEqual(r.o_dia_contra_a_mediana, { faturamento: { antes: 500, depois: 300, diferenca: -200, diferenca_pct: -40 }, pedidos: { antes: 5, depois: 3, diferenca: -2, diferenca_pct: -40 } });
      assert.deepStrictEqual(r.o_dia_contra_a_semana_anterior, { dia: '2026-11-06', faturamento: { antes: 600, depois: 300, diferenca: -300, diferenca_pct: -50 }, pedidos: { antes: 6, depois: 3, diferenca: -3, diferenca_pct: -50 } });
      /* posição: 12 sextas venderam mais, 1 (a sem venda) vendeu menos → 13ª de 14; não foi a menor nem a maior */
      assert.deepStrictEqual([r.posicao_do_dia.posicao, r.posicao_do_dia.de, r.posicao_do_dia.foi_o_menor, r.posicao_do_dia.foi_o_maior], [13, 14, false, false]);
      /* a sexta sem venda é ZERO de verdade, marcada */
      const semVenda = r.semana_a_semana_da_mais_recente_pra_mais_antiga.find((x) => x.dia === '2026-09-25');
      assert.deepStrictEqual(semVenda, { dia: '2026-09-25', faturamento: 0, pedidos: 0, ticket_medio: null, margem: 0, sem_venda_no_dia: true, calendario: undefined });
      /* o calendário perto do dia: o 11.11 dois dias antes */
      assert.deepStrictEqual(r.datas_do_calendario_perto_do_dia.map((x) => [x.dia, x.dias_de_distancia]), [['2026-11-11', -2], ['2026-11-15', 2]]);
      assert.strictEqual(r.ressalva_do_calendario, CAL.RESSALVA);
      assert.ok(/NÃO diz/.test(CAL.RESSALVA) && /hipótese/.test(CAL.RESSALVA));
      /* UMA leitura da base pra tudo isso */
      assert.strictEqual(novasF().consultas(), 0);
      { const ff = novasF(); await ff.F.comparar_mesmo_dia_da_semana({ dia: '2026-11-13' }); assert.strictEqual(ff.consultas(), 1, 'a comparação das 13 semanas é uma leitura só'); }

      /* quantas semanas: padrão 13; fora da faixa é trazido pra faixa (4 a 26); lixo cai no padrão */
      const de = async (semanas) => { const ff = novasF(async (d1, d2) => { de.visto = [d1, d2]; return porDentro(d1, d2); }); await ff.F.comparar_mesmo_dia_da_semana({ dia: '2026-11-13', semanas }); return de.visto; };
      assert.deepStrictEqual([C.SEMANAS_PADRAO, C.SEMANAS_MIN, C.SEMANAS_MAX], [13, 4, 26], 'o padrão é 3 meses (pedido do dono: "no mínimo 3 meses")');
      assert.deepStrictEqual(await de(undefined), ['2026-08-14', '2026-11-13']);
      assert.deepStrictEqual(await de('abc'), ['2026-08-14', '2026-11-13']);
      assert.deepStrictEqual(await de(2), ['2026-10-16', '2026-11-13']);
      assert.deepStrictEqual(await de(99), ['2026-05-15', '2026-11-13']);
      assert.deepStrictEqual(await de(8), ['2026-09-18', '2026-11-13']);
      const r8 = await F.comparar_mesmo_dia_da_semana({ dia: '2026-11-13', semanas: 6 });
      assert.deepStrictEqual([r8.semana_a_semana_da_mais_recente_pra_mais_antiga.length, r8.nas_anteriores.faturamento_medio, r8.posicao_do_dia.foi_o_menor, r8.posicao_do_dia.posicao, r8.posicao_do_dia.de], [6, 600, true, 7, 7], 'com 6 semanas: média de 600+700+500+400+600+800, e a sexta 13 é a menor');

      /* dia com evento e semana anterior com evento: aparecem */
      const seg = await F.comparar_mesmo_dia_da_semana({ dia: '2026-10-12', semanas: 5 });
      assert.deepStrictEqual(seg.dia_analisado.calendario, [{ tipo: 'data do varejo', nome: 'Dia das Crianças' }, { tipo: 'feriado nacional', nome: 'Nossa Senhora Aparecida' }]);
      assert.deepStrictEqual([seg.dia_analisado.dia_da_semana, seg.dia_analisado.faturamento, seg.posicao_do_dia.foi_o_maior, seg.posicao_do_dia.posicao], ['segunda-feira', 450, true, 1]);
      assert.deepStrictEqual(seg.semana_a_semana_da_mais_recente_pra_mais_antiga.map((x) => [x.dia, x.faturamento, (x.calendario || []).map((e) => e.nome)]),
        [['2026-10-05', 200, []], ['2026-09-28', 200, []], ['2026-09-21', 200, []], ['2026-09-14', 200, []], ['2026-09-07', 100, ['Independência do Brasil']]]);
      assert.deepStrictEqual(seg.datas_do_calendario_perto_do_dia.map((x) => x.dia), ['2026-10-10']);

      /* dia de HOJE: vale, com o aviso de dia parcial; dia futuro e dia ilegível: recusa */
      const hj = await F.comparar_mesmo_dia_da_semana({ dia: HOJE });
      assert.ok(hj.dia_analisado.faturamento === 200 && hj.avisos.some((a) => /inclui hoje/.test(a)));
      await rejeita(F.comparar_mesmo_dia_da_semana({ dia: '2026-11-15' }), /período no futuro/, 'dia futuro');
      await rejeita(F.comparar_mesmo_dia_da_semana({ dia: '13/11/2026' }), /período inválido/, 'dia ilegível');
      await rejeita(F.comparar_mesmo_dia_da_semana({}), /período inválido/, 'sem dia');

      /* LEITURA CORTADA (o período passou do teto de linhas; elas vêm das mais antigas pras mais novas, então o que falta
         é o FIM — o dia analisado): recusa e pede menos semanas. Nunca "vendeu zero", nunca "foi o pior dia". */
      const cortado = (ultimo) => async (d1, d2) => { const d = await porDentro(d1, d2); const dias = {}; for (const k of Object.keys(d.dias)) if (k <= ultimo) dias[k] = d.dias[k]; return Object.assign({}, d, { truncado: true, dias }); };
      await rejeita(novasF(cortado('2026-10-20')).F.comparar_mesmo_dia_da_semana({ dia: '2026-11-13' }), /de 2026-08-14 a 2026-11-13 foi cortada.*2026-11-13 ficou de fora ou pela metade.*menos semanas/, 'o dia analisado depois do corte');
      await rejeita(novasF(cortado('2026-11-13')).F.comparar_mesmo_dia_da_semana({ dia: '2026-11-13' }), /foi cortada/, 'o dia analisado é o último lido — pode estar pela metade');
      /* e a mesma pergunta com MENOS semanas (leitura inteira) responde */
      const menos = await F.comparar_mesmo_dia_da_semana({ dia: '2026-11-13', semanas: 4 });
      assert.deepStrictEqual([menos.semana_a_semana_da_mais_recente_pra_mais_antiga.length, menos.nas_anteriores.faturamento_medio, menos.nas_anteriores.faturamento_mediano], [4, 550, 550]);
    }

    /* ═══ C. calendario_comercial ═══ */
    {
      const ff = novasF(); const F = ff.F;
      const c = await F.calendario_comercial({ de: '2026-11-01', ate: '2026-12-31' });
      assert.deepStrictEqual(c.datas.map((x) => [x.dia, x.dia_da_semana, x.ja_passou, x.eventos.map((e) => e.nome).join('+')]), [
        ['2026-11-02', 'segunda-feira', true, 'Finados'], ['2026-11-11', 'quarta-feira', true, '11.11 — data dupla, dia de campanha promocional dos marketplaces'],
        ['2026-11-15', 'domingo', false, 'Proclamação da República'], ['2026-11-20', 'sexta-feira', false, 'Dia da Consciência Negra'], ['2026-11-27', 'sexta-feira', false, 'Black Friday'],
        ['2026-11-30', 'segunda-feira', false, 'Cyber Monday'], ['2026-12-12', 'sábado', false, '12.12 — data dupla, dia de campanha promocional dos marketplaces'], ['2026-12-25', 'sexta-feira', false, 'Natal']]);
      assert.deepStrictEqual([c.periodo, c.hoje, c.total_de_datas, c.ressalva], [{ de: '2026-11-01', ate: '2026-12-31', dias: 61 }, HOJE, 8, CAL.RESSALVA]);
      assert.strictEqual(ff.consultas(), 0, 'o calendário não lê a base de vendas');
      const hojeEvento = await C.criarFerramentas({ hoje: '2026-11-11', consultarHistorico: porDentro }).F.calendario_comercial({ de: '2026-11-11', ate: '2026-11-11' });
      assert.deepStrictEqual([hojeEvento.datas[0].e_hoje, hojeEvento.datas[0].ja_passou], [true, false]);
      await rejeita(F.calendario_comercial({ de: '2026-11-20', ate: '2026-11-01' }), /é depois de/, 'período invertido');
      await rejeita(F.calendario_comercial({ de: '2025-01-01', ate: '2026-12-31' }), /grande demais/, 'mais de 400 dias');
      await rejeita(F.calendario_comercial({ de: 'ontem', ate: '2026-12-31' }), /período inválido/, 'data ilegível');
      await rejeita(F.calendario_comercial({ de: '2026-02-30', ate: '2026-12-31' }), /período inválido/, 'dia que não existe');
    }

    /* ═══ D. o resumo e a comparação levam o calendário de dentro de cada período ═══ */
    {
      const F = novasF().F;
      const r = await F.resumo_periodo({ de: '2026-11-09', ate: '2026-11-13' });
      assert.deepStrictEqual(r.calendario_do_periodo, [{ dia: '2026-11-11', dia_da_semana: 'quarta-feira', eventos: ['11.11 — data dupla, dia de campanha promocional dos marketplaces'] }]);
      assert.deepStrictEqual((await F.resumo_periodo({ de: '2026-11-03', ate: '2026-11-10' })).calendario_do_periodo, []);
      const c = await F.comparar_periodos({ antes_de: '2026-11-02', antes_ate: '2026-11-08', depois_de: '2026-11-09', depois_ate: '2026-11-13' });
      assert.deepStrictEqual([c.antes.calendario_do_periodo.map((x) => x.dia + ' ' + x.eventos.join('+')), c.depois.calendario_do_periodo.map((x) => x.dia)], [['2026-11-02 Finados'], ['2026-11-11']]);
    }

    /* ═══ E. O AVISO DOS DIAS RECENTES (duas fontes: a base histórica × o cache ao vivo do card) ═══ */
    {
      const F = novasF().F;
      const rec = (r) => r.avisos.filter((a) => /^DIAS RECENTES/.test(a));
      assert.strictEqual(C.DIAS_RECENTES, 3);
      /* hoje = 14/11 → recentes = 11/11 em diante */
      const ontem = await F.resumo_periodo({ de: '2026-11-13', ate: '2026-11-13' });
      assert.strictEqual(rec(ontem).length, 1);
      assert.ok(/^DIAS RECENTES: de 2026-11-13 em diante/.test(rec(ontem)[0]) && /base histórica/.test(rec(ontem)[0]) && /cache ao vivo/.test(rec(ontem)[0]) && /NÃO trate o número dele como errado/.test(rec(ontem)[0]) && /mostre os dois/.test(rec(ontem)[0]), rec(ontem)[0]);
      assert.ok(/^DIAS RECENTES: de 2026-11-11 em diante/.test(rec(await F.resumo_periodo({ de: '2026-10-01', ate: '2026-11-12' }))[0]), 'período longo que termina num dia recente: diz A PARTIR de qual dia');
      assert.strictEqual(rec(await F.resumo_periodo({ de: '2026-11-01', ate: '2026-11-11' })).length, 1, 'o 3º dia pra trás ainda é recente');
      assert.strictEqual(rec(await F.resumo_periodo({ de: '2026-11-01', ate: '2026-11-10' })).length, 0, 'período que termina antes dos últimos 3 dias não leva o aviso');
      assert.strictEqual(rec(await F.resumo_periodo({ de: '2026-10-26', ate: '2026-11-01' })).length, 0);
      /* vale em toda consulta que lê período: a comparação, o ranking e a do dia da semana */
      const cmp = await F.comparar_periodos({ antes_de: '2026-11-02', antes_ate: '2026-11-08', depois_de: '2026-11-09', depois_ate: '2026-11-13' });
      assert.strictEqual(rec(cmp).length, 1, 'na comparação só o período recente avisa');
      assert.strictEqual(rec(await F.ranking_itens({ de: '2026-11-12', ate: '2026-11-13' })).length, 1);
      assert.strictEqual(rec(await F.comparar_mesmo_dia_da_semana({ dia: '2026-11-13' })).length, 1);
      assert.strictEqual(rec(await F.comparar_mesmo_dia_da_semana({ dia: '2026-11-06' })).length, 0);
    }

    /* ═══ F. PELA ROTA: as consultas novas vão pra API, as regras novas estão no prompt, o passo aparece na tela ═══ */
    {
      const ontemReal = (() => { const d = new Date(C.hojeSP() + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
      const br = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7);
      const perguntar = async (roteiro) => {
        api.pedidos.length = 0; api.roteiro = roteiro;
        const res = novoRes();
        await h({ method: 'POST', headers: { 'x-admin-key': 'chave-adm' }, body: { pergunta: 'por que caiu ontem? e comparado aos outros dias iguais?' } }, res, new URL('http://x' + P + '/chat-analise'));
        return res._txt.split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6)));
      };
      let ev = await perguntar([turno({ usos: [{ id: 't1', name: 'comparar_mesmo_dia_da_semana', input: { dia: ontemReal } }], entrada: 10, saida: 5 }), turno({ texto: 'Pronto.', entrada: 20, saida: 5 })]);
      const p1 = api.pedidos[0].corpo, tr = api.pedidos[1].corpo.messages[2].content[0];
      assert.deepStrictEqual(p1.tools.map((t) => t.name), ['resumo_periodo', 'comparar_periodos', 'comparar_mesmo_dia_da_semana', 'calendario_comercial', 'ranking_itens', 'buscar_item', 'evolucao_item']);
      const tDia = p1.tools.find((t) => t.name === 'comparar_mesmo_dia_da_semana'), tCal = p1.tools.find((t) => t.name === 'calendario_comercial');
      assert.deepStrictEqual([tDia.input_schema.required, Object.keys(tDia.input_schema.properties), tCal.input_schema.required], [['dia'], ['dia', 'semanas'], ['de', 'ate']]);
      assert.ok(/padrão 13 semanas ≈ 3 meses/.test(tDia.description) && /comparado a outras sextas/.test(tDia.description) && /datas duplas/.test(tCal.description) && /não diz se a loja participou/.test(tCal.description));
      for (const re of [/6\. CONTEXTO ANTES DE CONCLUIR.*pelo menos 13 semanas \(comparar_mesmo_dia_da_semana\)/, /pelo menos 3 meses/, /7\. CALENDÁRIO\. Datas duplas \(1\/1, 2\/2 … 11\/11, 12\/12\)/, /ANTECIPAR ou ADIAR/, /não diz se a loja participou da campanha/,
        /8\. NÚMERO DO DASHBOARD DIFERENTE DO SEU.*não diga que o número dele está errado/, /em quais campanhas a loja entrou/]) assert.ok(re.test(p1.system), 'faltou no prompt: ' + re);
      assert.ok(!tr.is_error, 'a consulta do dia da semana voltou como erro pro modelo: ' + tr.content.slice(0, 200));
      const jr = JSON.parse(tr.content);
      assert.deepStrictEqual([jr.dia_analisado.dia, jr.semana_a_semana_da_mais_recente_pra_mais_antiga.length, jr.avisos.some((a) => /^DIAS RECENTES/.test(a))], [ontemReal, 13, true]);
      assert.deepStrictEqual(ev.filter((e) => e.t === 'passo').map((e) => e.texto), ['Comparando ' + br(ontemReal) + ' com o mesmo dia da semana de 13 semanas']);
      assert.strictEqual(ev[ev.length - 1].uso.consultas, 1);
      /* o calendário: passo próprio na tela, e NÃO conta como consulta à base */
      ev = await perguntar([turno({ usos: [{ id: 't2', name: 'calendario_comercial', input: { de: '2026-11-01', ate: '2026-11-30' } }], entrada: 10, saida: 5 }), turno({ texto: 'Pronto.', entrada: 20, saida: 5 })]);
      const tc = api.pedidos[1].corpo.messages[2].content[0];
      assert.ok(!tc.is_error && JSON.parse(tc.content).datas.some((x) => x.dia === '2026-11-27'), tc.content.slice(0, 200));
      assert.deepStrictEqual([ev.filter((e) => e.t === 'passo').map((e) => e.texto), ev[ev.length - 1].uso.consultas], [['Olhando o calendário de 01/11 a 30/11'], 0]);
      /* semanas fora da faixa: o passo na tela mostra o número que VAI valer */
      ev = await perguntar([turno({ usos: [{ id: 't3', name: 'comparar_mesmo_dia_da_semana', input: { dia: ontemReal, semanas: 99 } }], entrada: 10, saida: 5 }), turno({ texto: 'Pronto.', entrada: 20, saida: 5 })]);
      assert.deepStrictEqual(ev.filter((e) => e.t === 'passo').map((e) => e.texto), ['Comparando ' + br(ontemReal) + ' com o mesmo dia da semana de 26 semanas']);
    }
  } finally { console.log = _log; console.error = _err; }
  console.log('ok — chat de análise, mais contexto: o dia contra o mesmo dia da semana (13 semanas, contas à mão), o calendário comercial (datas duplas, varejo, feriados), o calendário dentro do resumo e da comparação, o aviso dos dias recentes (duas fontes) e as regras novas no prompt');
  _chegouAoFim = true;
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
