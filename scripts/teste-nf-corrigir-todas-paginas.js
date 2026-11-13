'use strict';
/* 05/11 — A CORREÇÃO FISCAL OLHA TODAS AS PÁGINAS (auditoria do Codex no SHA 208fdb7d, achado F08). As buscas das NFs a
   corrigir (situações 1, 4 e 9) e das NFs em "Consultar situação" (10) pediam SÓ a 1ª página (100 NFs) e filtravam a
   data na mão: com mais de 100 NFs numa situação, as da página 2 em diante — as recentes, se a lista vem da mais antiga —
   nunca eram vistas. Prova com as funções DE PRODUÇÃO (lib/fiscal/nf-bling-api) e o Bling de mentira (a rede trocada):
   · 250 NFs na situação → as três páginas são pedidas e as 250 voltam (antes: 100);
   · o filtro de data vai no próprio Bling (dataEmissaoInicial/Final) em todas as páginas;
   · página incompleta encerra a busca (não pede página à toa); NF fora da janela continua de fora;
   · o robô de "Consultar situação" (10) também pagina. */
const assert = require('assert');
const os = require('os');
const path = require('path');
const Module = require('module');

const pedidas = [];
const POR_SIT = { 1: 250, 4: 3, 9: 0, 10: 130 };
const hoje = new Date().toISOString().slice(0, 10);
const _load = Module._load;
Module._load = function (req) {
  if (req === 'node-fetch') return async (url) => {
    const u = new URL(String(url));
    pedidas.push(u);
    const sit = Number(u.searchParams.get('situacao')), pag = Number(u.searchParams.get('pagina')), lim = Number(u.searchParams.get('limite'));
    const total = POR_SIT[sit] || 0;
    const lista = [];
    for (let i = (pag - 1) * lim; i < Math.min(total, pag * lim); i++) lista.push({ id: sit * 100000 + i, dataEmissao: hoje + ' 10:00:00' });
    if (sit === 4 && pag === 1) lista.push({ id: 999, dataEmissao: '2020-01-01 10:00:00' });   /* fora da janela: fica de fora */
    const corpo = { data: lista };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => corpo, text: async () => JSON.stringify(corpo) };
  };
  return _load.apply(this, arguments);
};
process.env.T_PAUSA = '0';
const { criarNfBlingApi } = require('../lib/fiscal/nf-bling-api');
const api = criarNfBlingApi({ rotulo: 'TESTE', nfTokenManager: { garantirTokenNF: async () => 't', renovarTokenNF: async () => 't' }, envPausa: 'T_PAUSA',
  intermediadorCnpj: '0', intermediadorNome: 'x', pastaCacheIE: path.join(os.tmpdir(), 'ie-teste') });

(async () => {
  const nfs = await api.getNFsParaCorrigir('tok');
  const sit1 = nfs.filter((n) => Math.floor(n.id / 100000) === 1);
  assert.strictEqual(sit1.length, 250, 'situação 1 com 250 NFs: a correção só viu ' + sit1.length + ' (a 1ª página)');
  assert.ok(!nfs.some((n) => n.id === 999), 'NF fora da janela não podia entrar');
  assert.strictEqual(nfs.filter((n) => Math.floor(n.id / 100000) === 4).length, 3);
  const pags1 = pedidas.filter((u) => u.searchParams.get('situacao') === '1').map((u) => u.searchParams.get('pagina'));
  assert.deepStrictEqual(pags1, ['1', '2', '3'], 'situação 1: as páginas pedidas deviam ser 1, 2 e 3 (a 3ª incompleta encerra): ' + pags1);
  assert.ok(pedidas.every((u) => u.searchParams.get('dataEmissaoInicial') && u.searchParams.get('dataEmissaoFinal')), 'o filtro de data tem que ir no próprio Bling em todas as páginas');
  /* 12/11 (medido no Bling de verdade: uma data final SEM HORA não garante o dia inteiro — a nota das 21:35 não veio com
     inicial = final = o dia dela): a janela termina em AMANHÃ, pra as notas de HOJE nunca ficarem de fora */
  { const h0 = new Date(); h0.setHours(0, 0, 0, 0); const am = new Date(h0); am.setDate(am.getDate() + 1); const amanha = am.toISOString().split('T')[0], hoje = h0.toISOString().split('T')[0];
    assert.ok(pedidas.length > 0 && pedidas.every((u) => u.searchParams.get('dataEmissaoFinal') === amanha && u.searchParams.get('dataEmissaoInicial') < hoje), 'a data final da janela tem que ser amanhã (' + amanha + '): ' + pedidas.map((u) => u.searchParams.get('dataEmissaoFinal')).join()); }
  assert.deepStrictEqual(pedidas.filter((u) => u.searchParams.get('situacao') === '9').map((u) => u.searchParams.get('pagina')), ['1'], 'situação vazia: uma página só');
  pedidas.length = 0;
  const cons = await api.getNFsSituacaoConsulta('tok');
  assert.strictEqual(cons.length, 130, 'Consultar situação com 130 NFs: o robô só viu ' + cons.length);
  assert.deepStrictEqual(pedidas.map((u) => u.searchParams.get('pagina')), ['1', '2']);
  Module._load = _load;
  console.log('ok — a correção fiscal e o robô de consulta percorrem todas as páginas da janela (250 e 130 NFs vistas), com o filtro de data no próprio Bling');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
