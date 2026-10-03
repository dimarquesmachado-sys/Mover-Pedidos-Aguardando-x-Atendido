/* 02/10 — DEVOLUÇÕES DO ML no painel, peça compartilhada.

   Mesmo desenho que deu certo no Plano de Compra (#582/#583) e pelo mesmo motivo: extrair do
   painel da AMB não funciona (ele monta a tela concatenando strings dentro do JS), e colar
   entre painéis quebra os testes próprios de cada empresa. A seção é escrita contra a resposta
   REAL da rota, com a empresa como parâmetro.

   E o teste EXERCITA o script num DOM de mentira — foi o que faltou no #581 e deixou passar uma
   peça que mostraria lixo na tela. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const { scriptDasDevolucoes } = require(path.join(raiz, 'lib', 'checkout', 'painel-devolucoes-ml'));

const PREFIXOS = ['/good-checkout-offline', '/amb-checkout-offline', '/girassol-backup-offline'];
for (const base of PREFIXOS) {
  const s = scriptDasDevolucoes(base);
  assert.doesNotThrow(() => new Function(s), 'o script de ' + base + ' não compila — a seção sumiria sem erro');
  assert.ok(s.includes(base), base + ': sem o prefixo da empresa');
  for (const outra of PREFIXOS) {
    if (outra !== base) assert.ok(!s.includes(outra), base + ' carrega o prefixo de ' + outra);
  }
  assert.ok(!/onclick=/.test(s), base + ': onclick inline');
}

/* ════ desenha? ════ */
{
  const els = {};
  const novo = (id) => ({ id, innerHTML: '', textContent: '', value: '', disabled: false, _ev: {},
    addEventListener(e, f) { this._ev[e] = f; }, click() { this._ev.click && this._ev.click(); } });
  els['devolucoesMlAqui'] = novo('devolucoesMlAqui');
  els['de'] = novo('de'); els['de'].value = '2026-09-01';
  els['ate'] = novo('ate'); els['ate'].value = '2026-09-30';
  global.document = { getElementById: (id) => els[id] || (els[id] = novo(id)) };
  let urlPedida = '';
  global.fetch = async (u) => { urlPedida = u; return { json: async () => ({
    ok: true, quantidade: 7, valor_devolvido: 1850.4, custo_retorno_informado: 120,
    ainda_com_dinheiro_retido: 2, reclamacoes_sem_devolucao: 1,
    por_motivo: { 'produto com defeito': 4, 'arrependimento': 3 },
    por_status: { 'finalizada': 5, 'em análise': 2 } }) }; };

  new Function(scriptDasDevolucoes('/good-checkout-offline'))();
  assert.ok(/Devoluções do Mercado Livre/.test(els['devolucoesMlAqui'].innerHTML), 'a seção não foi montada');

  els['dvCalc'].click();
  module.exports = new Promise(r => setTimeout(r, 60)).then(() => {
    /* ⚠️ usa o MESMO período do painel, não um inventado: número de outro período ao lado dos
       cards do período escolhido é a pior forma de errar — parece certo */
    assert.ok(/de=2026-09-01/.test(urlPedida) && /ate=2026-09-30/.test(urlPedida),
      'a seção não respeita o período escolhido no painel — mostraria outro intervalo');

    const info = els['dvInfo'].textContent;
    assert.ok(/7 devolução/.test(info), 'não mostra a quantidade');
    assert.ok(/1\.850,40/.test(info), 'não mostra o valor devolvido');
    assert.ok(/frete de retorno/.test(info), 'esconde o custo do frete de retorno, que é prejuízo real');
    assert.ok(/dinheiro ainda retido/.test(info), 'não avisa das que ainda têm dinheiro retido');

    const t = els['dvTab'].innerHTML;
    assert.ok(/produto com defeito/.test(t) && /finalizada/.test(t), 'faltam os quadros por motivo/status');
    assert.ok(t.indexOf('produto com defeito') < t.indexOf('arrependimento'),
      'não ordena por quantidade — o motivo mais comum tem que vir primeiro');

    console.log('OK: devolucoes do ML desenham, respeitam o periodo do painel e ordenam por motivo');
  });
}

/* a fábrica serve e a GOOD liga */
{
  const fab = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'fabrica-rotas-painel.js'), 'utf8');
  assert.ok(/devolucoes-ml\.js/.test(fab), 'a fábrica não serve o script');
  assert.ok(/devolucoes-ml indisponível/.test(fab), 'erro ao gerar derrubaria o painel');
  const tela = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'dashboard.html'), 'utf8');
  assert.ok(/id="devolucoesMlAqui"/.test(tela), 'GOOD: sem o espaço da seção');
  assert.ok(/js\/devolucoes-ml\.js/.test(tela), 'GOOD: não inclui o script');
  const idx = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
  assert.ok(/js\/devolucoes-ml\.js' \|\|/.test(idx),
    'o script não está liberado na guarda — quem abre por ?k= tomaria 401 e a seção não carregaria');
}
