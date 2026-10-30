'use strict';
/* 30/10 — o CICLO do checkout em peça única, passo 3: a GIRASSOL passa a usar lib/checkout/ciclo-empresa. Nivelar por cima:
   ela ganha a reconciliação da AMB (o 404 do Bling = pedido apagado, que antes ficava preso no cache pra sempre; conferência
   um a um acima do limite em vez de abortar; prazo por fora — docs/fase3-diferencas-ciclo.md item 1), o freio e o
   diagnóstico da Shopee, o "aguardando disponibilidade" do ML, a fila do Full despachado (vazia, com o despacho desligado);
   e a peça ganhou dela o índice do catálogo com FOTO e nome composto da variação e o log da NF corrigida. O filtro de Full
   pela UNIDADE fica DESLIGADO (fullAtivo: false) até o dono decidir — a venda que o próprio ML diz ser Full segue saindo da
   fila, como ela já fazia. O conferido segue pro VERIFICADO (a fila da Expedição). Prova (scripts/_ciclo-origem.js):
   · toda linha nova vem do ciclo de outra empresa (com os nomes da Girassol) ou da lista revisada da peça;
   · toda linha que saiu está na lista revisada (scripts/fixtures/ciclo-girassol-trocadas.json);
   · o que é da Girassol continua; ela exporta tudo o que exportava. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const { conferir } = require('./_ciclo-origem');
const r = conferir(raiz, 'girassol', 'girassol-backup-offline');
assert.ok(r.novas.length > 100, 'quase nada mudou — a comparação não está olhando o ciclo novo');
const txt = require('./_fonte-ciclo').ler(raiz, 'girassol-backup-offline/ciclo.js');
for (const [o, por] of [["require('../girassol-mm-etiquetas')", 'Madeira Madeira'], ["SH_URL + '/girassol/interno/etiqueta", 'a loja /girassol na Shopee'],
  ["_agF3.registrar('girassol',", 'a chave fiscal'], ["require('../girassol/mlTokenManager')", 'o token do ML dela'], ["require('../girassol/mlApi')", 'a API do ML dela'],
  ["if (_logiML === 'fulfillment') {", 'a venda Full do ML fora da fila (ela já fazia)'], ['const UN_FULL = [];', 'o filtro de Full por unidade DESLIGADO'],
  ['const UN_FULL_REC = [];', 'a reconciliação sem unidade de Full'], ['process.env.GIRABKP_PAUSA_MS', 'as variáveis GIRABKP_'],
  ['detalheParaReconciliacao', 'a reconciliação com o 404 do Bling'], ['idxStatus.nomes_compostos = compostos;', 'o índice com nome composto'],
  /* Codex #774: (P1) ela confere CADA pedido que sumiu da lista antes de apagar a pasta; (P2) sem despacho configurado, o
     conferido do Full segue pro VERIFICADO no sincronizar */
  ['if (true || aRemover.length > limiteSeguro', 'a confirmação de cada pedido antes de apagar a pasta'],
  ['sincronizarConferidos(Number(SIT_DESPACHADOS) ? new Set(', 'o conferido do Full seguindo pro VERIFICADO sem despacho']]) {
  assert.ok(txt.includes(o), 'a Girassol perdeu/não ganhou ' + por + ' (' + o + ')');
}
assert.ok(!/AMBBKP|ambtotal|GOODBKP|'\/amb\/|'\/good\//.test(require('./_codigo-ciclo')(txt).join('\n')), 'sobrou nome de outra empresa no código do ciclo da Girassol');
const mod = require(path.join(raiz, 'girassol-backup-offline', 'ciclo.js'));
const exportsAntes = /module\.exports = \{([^}]*)\}/.exec(fs.readFileSync(path.join(__dirname, 'fixtures', 'ciclo-girassol-antes.js'), 'utf8'))[1].split(',').map((x) => x.trim().split(':')[0].trim()).filter(Boolean);
for (const k of exportsAntes) assert.ok(typeof mod[k] !== 'undefined', 'a Girassol não exporta mais ' + k);
assert.deepStrictEqual(mod.unsFullEfetivas(), [], 'com o Full desligado e sem unidade da casa, a lista de unidades Full tinha que vir vazia');
console.log('ok — ciclo da Girassol na peça: ' + r.novas.length + ' linha(s) novas, todas de origem conhecida; ' + r.sumiram.length + ' trocadas (lista revisada); Full por unidade desligado; o que é dela continua');
