/* 02/10 — FERRAMENTAS DE CUSTO no painel, peça compartilhada.

   Junta o que o dono usou de verdade hoje e a GOOD não tinha na tela: o DE-PARA DE SKU (que
   liga o código renomeado no Bling ao do histórico — sem ele o produto fica "sem custo" pra
   sempre) e o acesso aos CUSTOS MANUAIS.

   ⚠️ `/custos-manuais` já serve uma TELA própria, então aqui é só o link. Card que refaz uma
   tela existente é duplicação, e duplicação diverge — foi o que este trabalho inteiro veio
   combater.

   Mesma forma do plano de compra (#582): gera markup, empresa como parâmetro, sem onclick
   inline — e o teste EXERCITA o script, porque script que não compila não dá erro: a seção
   simplesmente não aparece. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const { scriptDeCusto } = require(path.join(raiz, 'lib', 'checkout', 'painel-ferramentas-custo'));

const PREFIXOS = ['/good-checkout-offline', '/amb-checkout-offline', '/girassol-backup-offline'];
for (const base of PREFIXOS) {
  const s = scriptDeCusto(base);
  assert.doesNotThrow(() => new Function(s), 'o script de ' + base + ' não compila');
  assert.ok(s.includes(base), base + ': sem o prefixo da empresa');
  for (const outra of PREFIXOS) {
    if (outra !== base) assert.ok(!s.includes(outra), base + ' carrega o prefixo de ' + outra);
  }
  assert.ok(!/onclick=/.test(s), base + ': onclick inline');
}

/* desenha? */
{
  const els = {};
  const novo = (id) => ({ id, innerHTML: '', textContent: '', disabled: false, _ev: {},
    addEventListener(e, f) { this._ev[e] = f; }, click() { this._ev.click && this._ev.click(); } });
  els['ferramentasCustoAqui'] = novo('ferramentasCustoAqui');
  global.document = { getElementById: (id) => els[id] || (els[id] = novo(id)) };
  global.window = { location: { search: '?k=teste-ci' } };
  global.URLSearchParams = URLSearchParams;
  /* ⚠️ A FORMA REAL: `pares` é uma LISTA de {de, para, em}. Eu tinha montado um mapa no teste e
     ele passou — inventar a forma do dado no teste é não testar nada, e foi o que deixou o
     Object.keys() quebrado chegar no PR (#585). */
  global.fetch = async () => ({ json: async () => ({ ok: true, total: 2,
    pares: [{ de: '261', para: 'PT-06-PRETO', em: '2026-09-30T10:00:00Z' },
            { de: '262', para: 'PT-06-AZUL', em: null }] }) });

  new Function(scriptDeCusto('/good-checkout-offline'))();
  const html = els['ferramentasCustoAqui'].innerHTML;
  assert.ok(/Ferramentas de custo/.test(html), 'a seção não foi montada');
  assert.ok(/custos-manuais/.test(html), 'sumiu o acesso aos custos manuais');
  assert.ok(/target="_blank"/.test(html) && /rel="noopener"/.test(html),
    'o link abre na mesma aba ou sem noopener — tiraria o dono do painel no meio da análise');

  els['fcDepara'].click();
  module.exports = new Promise(r => setTimeout(r, 50)).then(() => {
    const t = els['fcTab'].innerHTML;
    assert.ok(/<table/.test(t), 'não desenhou a tabela do de-para');
    assert.ok(/261/.test(t) && /PT-06-PRETO/.test(t), 'faltam os pares na tabela');
    assert.ok(/2 par\(es\)/.test(els['fcInfo'].textContent), 'não diz quantos pares existem');
    /* Codex #585 (P2): SÓ LISTAR NÃO RESOLVIA O CASO QUE MOTIVOU A SEÇÃO. O `261`/`262` não
       tem par cadastrado — ver a lista vazia não conserta nada. A seção precisa CRIAR. */
    const montado = els['ferramentasCustoAqui'].innerHTML;
    assert.ok(/id="fcDe"/.test(montado) && /id="fcPara"/.test(montado) && /id="fcLigar"/.test(montado),
      'sumiram os campos de cadastro — a seção voltaria a só listar, sem resolver o 261/262');
    const src2 = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'painel-ferramentas-custo.js'), 'utf8');
    assert.ok(/\?de=' \+ encodeURIComponent/.test(src2), 'não manda `de` pra rota, ou manda sem escapar');
    assert.ok(/&para=' \+ encodeURIComponent/.test(src2), 'não manda `para` pra rota, ou manda sem escapar');
    /* ⚠️ a trava (de = para, ciclo) fica no SERVIDOR e a tela só mostra o motivo — duas cópias
       da mesma regra divergem, que é o que este trabalho inteiro veio combater */
    assert.ok(/d\.erro\) \|\| 'não consegui ligar'/.test(src2),
      'a tela deixou de mostrar o motivo da recusa da rota');

    console.log('OK: ferramentas de custo desenham, listam e CRIAM o de-para');
  });
}

/* fábrica serve e a tela da GOOD inclui */
{
  const fab = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'fabrica-rotas-painel.js'), 'utf8');
  assert.ok(/'\/js\/ferramentas-custo\.js'/.test(fab), 'a fábrica não serve o script');
  assert.ok(/ferramentas-custo indisponível/.test(fab), 'erro ao gerar derrubaria o painel');

  const tela = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'dashboard.html'), 'utf8');
  assert.ok(/id="ferramentasCustoAqui"/.test(tela), 'a tela da GOOD não abre o espaço');
  assert.ok(/js\/ferramentas-custo\.js/.test(tela), 'a tela da GOOD não inclui o script');

  /* ⚠️ o script é interface e precisa carregar por `?k=` também: o <script src> não leva a
     querystring da página, e sem liberar na guarda daria 401 (lição do #582) */
  const idx = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
  assert.ok(/js\/ferramentas-custo\.js' \|\|/.test(idx),
    'o script não está liberado na guarda de sessão — quem abre o painel por ?k= não veria a seção');
}
