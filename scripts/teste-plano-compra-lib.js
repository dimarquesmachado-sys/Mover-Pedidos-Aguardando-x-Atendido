/* 02/10 — PLANO DE COMPRA, peça compartilhada (v2).

   ⚠️ A v1 (#581) FOI FECHADA E A CAUSA ESTÁ TRAVADA AQUI: eu tentei EXTRAIR o bloco do painel
   da AMB, que monta a tela concatenando strings dentro do JavaScript. Não existe markup pra
   recortar — o que eu ia jogar no `innerHTML` era código-fonte, com `'+` e `//` no meio, e a
   tela mostraria fragmentos. Antes disso, colar o bloco direto no painel da GOOD falhou três
   vezes (onclick sem função, função em outro <script>, variável fantasma).

   Esta versão NÃO EXTRAI NADA: escreve a seção contra a resposta REAL da rota, e o teste
   EXERCITA o script num DOM de mentira — se ele não desenhar, o teste acusa. Era o que faltava:
   na v1 tudo "passava" e a tela mostraria lixo. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const { scriptDoPlano } = require(path.join(raiz, 'lib', 'checkout', 'painel-plano-compra'));

const PREFIXOS = ['/good-checkout-offline', '/amb-checkout-offline', '/girassol-backup-offline'];

for (const base of PREFIXOS) {
  const s = scriptDoPlano(base);
  assert.doesNotThrow(() => new Function(s), 'o script de ' + base + ' não compila');
  assert.ok(s.includes(base), 'o script de ' + base + ' não leva o prefixo da empresa');
  for (const outra of PREFIXOS) {
    if (outra === base) continue;
    assert.ok(!s.includes(outra), base + ' carrega o prefixo de ' + outra + ' — misturaria empresas');
  }
  /* ⚠️ sem onclick inline: foi um dos furos da v1 (HTML chamando função fora do escopo) */
  assert.ok(!/onclick=/.test(s), base + ': voltou o onclick inline');
}

/* ════ O TESTE QUE FALTAVA NA v1: o script DESENHA? ════ */
{
  const els = {};
  const novo = (id) => ({ id, innerHTML: '', textContent: '', value: '', _ev: {},
    addEventListener(e, f) { this._ev[e] = f; }, click() { this._ev.click && this._ev.click(); } });
  els['planoCompraAqui'] = novo('planoCompraAqui');
  global.document = { getElementById: (id) => els[id] || (els[id] = novo(id)),
    createElement: () => ({ click() {}, set href(v) {}, set download(v) {} }) };
  global.URL = { createObjectURL: () => 'blob:x' };
  global.Blob = function () {};
  global.fetch = async () => ({ json: async () => ({
    ok: true, skus: 2, skus_sem_saldo: 1,
    totais: { investir: 1234.5, risco: 900, skus_a_comprar: 2 },
    itens: [
      { sku: 'PT-06', nome: 'Abajur Flex', curva: 'A', saldo: 3, un30: 30, acaba_em: '12/10', un: 42, investir: 900, risco: 700 },
      { sku: 'GLOBO12', nome: 'Globo 12cm', curva: 'B', sem_saldo: true, un30: 10, un: 0, investir: 0, risco: 200 },
    ] }) });

  new Function(scriptDoPlano('/good-checkout-offline'))();
  const montado = els['planoCompraAqui'].innerHTML;
  assert.ok(/Plano de Compra/.test(montado), 'a seção não foi montada na tela');
  assert.ok(/pcCalc/.test(montado) && /pcFiltro/.test(montado), 'faltam os controles');
  /* ⚠️ nada de fonte serializada: o erro exato da v1 */
  assert.ok(!/'\+/.test(montado), 'o markup contém código-fonte (`\'+`) — era o bug da v1');

  els['pcCalc'].click();
  const pronto = new Promise(r => setTimeout(r, 60));
  module.exports = pronto.then(() => {
    const t = els['pcTab'].innerHTML;
    assert.ok(/<table/.test(t), 'não desenhou a tabela depois de carregar');
    assert.ok(/PT-06/.test(t) && /GLOBO12/.test(t), 'faltam itens na tabela');
    assert.ok(/sem saldo/.test(t), 'não marca o item sem saldo no Bling');
    assert.ok(/1\.234,50/.test(els['pcInfo'].textContent), 'o resumo não traz o total a investir');

    els['pcFiltro']._ev.input({ target: { value: 'globo' } });
    const t2 = els['pcTab'].innerHTML;
    assert.ok(/GLOBO12/.test(t2) && !/PT-06/.test(t2), 'o filtro por SKU/nome não funciona');

    /* Codex #582 r2 (P1): `comprar: null` é "a rota não conseguiu o saldo", não zero —
       mostrar 0 diz pra não comprar nada, recomendação que ninguém fez. Mesma classe do
       `investir`, que eu já tinha consertado e deixei passar aqui. */
    assert.ok(!/comprar.*>0</.test(t) || /\?/.test(t), 'quantidade desconhecida virou 0');

    els['pcCsv'].click();   /* não pode estourar */
    console.log('OK: plano de compra DESENHA, filtra e exporta — peca unica pras tres empresas');
  });
}

/* a fábrica serve, e as TRÊS telas incluem — era o P2 que dizia "só a GOOD usaria" */
{
  const fab = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'fabrica-rotas-painel.js'), 'utf8');
  assert.ok(/'\/js\/plano-compra\.js'/.test(fab), 'a fábrica não serve o script');
  assert.ok(/plano-compra indisponível/.test(fab), 'erro ao gerar derrubaria o painel inteiro');
  /* ⚠️ A GOOD ESTÁ LIGADA; A AMB E A GIRASSOL AINDA NÃO, e o teste diz a verdade em vez de
     fingir. O Codex apontou (#582 P2) que só a GOOD monta `criarRotasPainel` — nas outras duas
     o `<script src>` daria 404 e a seção apareceria quebrada. Entregar quebrado em duas de três
     é pior que entregar numa e dizer. Quando elas montarem a fábrica, o include entra e este
     teste passa a cobrá-lo. */
  const telaGood = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'dashboard.html'), 'utf8');
  assert.ok(/id="planoCompraAqui"/.test(telaGood), 'GOOD: sem o espaço da seção');
  assert.ok(/js\/plano-compra\.js/.test(telaGood), 'GOOD: não inclui o script');

  for (const [emp, arq, idx] of [['AMB', 'amb-checkout-offline/index.js', 'amb-checkout-offline/amb-dashboard.html'],
                                 ['Girassol', 'girassol-backup-offline/gbo-app.js', 'girassol-backup-offline/dashboard.html']]) {
    const monta = /criarRotasPainel/.test(fs.readFileSync(path.join(raiz, arq), 'utf8'));
    const inclui = /js\/plano-compra\.js/.test(fs.readFileSync(path.join(raiz, idx), 'utf8'));
    assert.ok(monta || !inclui,
      emp + ' inclui o script mas NÃO monta a fábrica — o <script src> daria 404 e a seção ' +
      'apareceria quebrada. Ligar a tela só depois de a empresa montar `criarRotasPainel`.');
  }
}
