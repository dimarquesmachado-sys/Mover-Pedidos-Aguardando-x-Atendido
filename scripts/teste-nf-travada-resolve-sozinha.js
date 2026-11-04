'use strict';
/* 04/11 — NF TRAVADA SAI DO AVISO SOZINHA QUANDO O PROBLEMA É RESOLVIDO. Caso real (Girassol): NF 130031 do pedido ML
   2000019330050780 — o Bling importou o CEP errado, o ML recusou ("CEP da NF diferente do CEP da venda") e a nota foi pra
   lista de travadas, que o checkout mostra. O dono cancela, corrige o endereço e emite OUTRA nota no Bling: a rotina F3
   já mandava essa nota nova ao ML sozinha (outro id, fora da lista) — mas o aviso da antiga ficava no checkout PRA
   SEMPRE. Prova com o F3 DE PRODUÇÃO (lib/fiscal/nfe-ml-fluxo), Bling e ML de mentira:
   · a nota nova do mesmo pedido é enviada e ACEITA → a travada antiga sai da lista; a de OUTRO pedido fica;
   · a nota nova também RECUSADA → a antiga NÃO sai (só sai o que foi resolvido de verdade);
   · o texto do aviso diz o que o sistema faz (a nota nova vai sozinha pro ML). */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nftrav-'));
process.env.CACHE_DIR = dir;
const trav = require('../lib/nf-travadas');
const { criarFluxoNFeML } = require('../lib/fiscal/nfe-ml-fluxo');

function montar(est) {
  const processados = new Set(), enviadas = [];
  const f3 = criarFluxoNFeML({ rotulo: 'TESTE', envMaxNfeMl: 'T_MAX', envNfJanelaDias: 'T_JAN', envF3MaxChecagens: 'T_CHK', dirTravadas: dir,
    pecas: {
      tokenManager: { garantirToken: async () => 'tb', renovarToken: async () => 'tb' },
      mlTokenManager: { garantirTokenML: async () => 'tml' },
      blingApi: { ME_LOJA_IDS: [7], mensagemCanalFaltando: () => 'x', enviarNFeParaLojaVirtual: async () => ({}),
        getNFesAutorizadas: async () => est.janela.map((id) => ({ id })),
        getNFeDetalhe: async (tk, id) => (est.notas[String(id)] ? JSON.parse(JSON.stringify(est.notas[String(id)])) : null),
        jaProcessado: (f, id) => processados.has(String(id)), marcarProcessado: (f, id) => processados.add(String(id)) },
      mlApi: { enviarNFeParaML: async (tk, pedido, nf) => { const e = est.ml[String(pedido)]; if (e && e.erro) throw e.erro; enviadas.push(nf.numero); } } } });
  return { f3, enviadas };
}
const nota = (id, numero, pedido) => ({ id, numero, numeroPedidoLoja: pedido, xml: 'http://x', loja: { id: 7 }, situacao: 5 });
/* o arquivo que o checkout lê (_nf_travadas.json no cache da empresa) */
const lerArq = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, '_nf_travadas.json'), 'utf8')); } catch (e) { return {}; } };
const RECUSA_CEP = new Error('NFe receiver zipcode must be the same as the sale (wrong_receiver_zipcode)');

(async () => {
  /* a travada do caso real + uma de outro pedido */
  assert.ok(trav.registrar(dir, { nfeId: 9001, numero: 130031, pedidoML: '2000019330050780', erro: RECUSA_CEP.message }).gravou);
  assert.ok(trav.registrar(dir, { nfeId: 9500, numero: 130500, pedidoML: '2000000000000555', erro: RECUSA_CEP.message }).gravou);
  assert.ok(/vai SOZINHA pro ML/.test(lerArq()['9001'].como_resolver), 'o aviso tinha que dizer que a nota nova vai sozinha pro ML');

  /* 1) a nota nova do mesmo pedido também é RECUSADA → a antiga fica */
  let m = montar({ janela: [9002], notas: { 9002: nota(9002, 130098, '2000019330050780') }, ml: { '2000019330050780': { erro: RECUSA_CEP } } });
  await m.f3.rotinaNFeML();
  assert.ok(lerArq()['9001'], 'a nota nova foi recusada de novo — a travada antiga não podia sair');

  /* 2) o dono corrigiu o endereço e emitiu outra: o ML ACEITA → a antiga sai; a do outro pedido fica */
  m = montar({ janela: [9003], notas: { 9003: nota(9003, 130099, '2000019330050780') }, ml: {} });
  await m.f3.rotinaNFeML();
  assert.deepStrictEqual(m.enviadas, [130099], 'a nota nova tinha que ir sozinha pro ML');
  const depois = lerArq();
  assert.ok(!depois['9001'], 'o ML aceitou a nota nova e a travada antiga do mesmo pedido continuou no aviso');
  assert.ok(depois['9500'], 'a travada de OUTRO pedido não podia sair');
  /* a nota que foi recusada no passo 1 (9002) também é deste pedido e sai junto — o pedido está resolvido */
  assert.ok(!depois['9002'], 'a outra nota recusada do mesmo pedido tinha que sair junto');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok — NF travada sai do aviso sozinha quando o ML aceita a nota nova do mesmo pedido (e só nesse caso); o aviso diz que a nota nova vai sozinha');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
