/* 05/10 — COMPLETAR PEDIDOS PELA NOTA, no painel.

   Lê as notas já em disco e preenche produtos e frete EXATOS nos pedidos sem esses dados — a
   margem deles deixa de ser estimativa. É leitura LOCAL, sem API (o próprio handler diz), então
   pode rodar com o galpão operando: não consome cota do Bling.

   ⚠️ O CASO QUE ESTE TESTE EXISTE PRA TRAVAR: "nada preenchido" tem DOIS significados muito
   diferentes — ou está tudo completo, ou havia pedidos pendentes e a nota deles ainda não está em
   disco. Dizer só "nada novo" esconde o segundo, e o dono fica achando que a margem está apurada
   quando ela ainda é estimativa.

   ⚠️ E o botão é EXPLÍCITO: a rota ALTERA dados. Seção que dispara escrita sozinha ao abrir a
   tela é o tipo de coisa que ninguém pede e todo mundo descobre tarde.

   Marcador estável [NF-LOCAL]. */
const assert = require('assert');
const path = require('path');

const raiz = path.join(__dirname, '..');
const { scriptDaNfLocal } = require(path.join(raiz, 'lib', 'checkout', 'painel-nf-local'));

const PREFIXOS = ['/good-checkout-offline', '/amb-checkout-offline', '/girassol-backup-offline'];
for (const base of PREFIXOS) {
  const s = scriptDaNfLocal(base);
  assert.doesNotThrow(() => new Function(s), '[NF-LOCAL] o script de ' + base + ' não compila');
  for (const outra of PREFIXOS) {
    if (outra !== base) assert.ok(!s.includes(outra),
      '[NF-LOCAL] ' + base + ' carrega o prefixo de ' + outra + ' — completaria pedidos da loja errada');
  }
  assert.ok(!/onclick=/.test(s), '[NF-LOCAL] ' + base + ': onclick inline');
}

function montar(corpo) {
  const els = {};
  const novo = (id) => ({
    id, innerHTML: '', textContent: '', value: '', disabled: false, _ev: {},
    addEventListener(e, f) { this._ev[e] = f; },
    click() { this._ev.click && this._ev.click(); },
  });
  els['nfLocalAqui'] = novo('nfLocalAqui');
  global.document = { getElementById: (id) => els[id] || (els[id] = novo(id)) };
  global.window = { location: { search: '?k=teste' } };
  global.URLSearchParams = URLSearchParams;
  const chamadas = [];
  global.fetch = async (url) => { chamadas.push(url); return { json: async () => corpo }; };
  new Function(scriptDaNfLocal('/good-checkout-offline'))();
  return { els, chamadas };
}

module.exports = (async () => {
  /* ⚠️ 1) NÃO pode rodar sozinho ao abrir: a rota ALTERA dados */
  {
    const { chamadas } = montar({ ok: true });
    await new Promise((r) => setTimeout(r, 60));
    assert.deepStrictEqual(chamadas, [],
      '[NF-LOCAL] a seção chamou a rota SEM o dono clicar — e essa rota ALTERA pedidos. Seção que ' +
      'dispara escrita ao abrir a tela é o tipo de coisa que ninguém pede e todo mundo descobre tarde.');
  }

  /* 2) com pedidos preenchidos: diz quantos e o que mudou */
  {
    const { els } = montar({ ok: true, candidatos: 12, preenchidos_pela_nf: 9 });
    els['nfRodar'].click();
    await new Promise((r) => setTimeout(r, 60));
    const t = String(els['nfInfo'].innerHTML || els['nfInfo'].textContent || '');
    assert.ok(/9 pedido/.test(t), '[NF-LOCAL] não diz quantos pedidos foram completados → ' + t.slice(0, 110));
    assert.ok(/registro local/.test(t),
      '[NF-LOCAL] não diz que o ganho é só no registro local (o histórico do painel lê outra base)');
  }

  /* ⚠️ 3) O CASO CENTRAL: havia pendentes e NADA foi preenchido */
  {
    const { els } = montar({ ok: true, candidatos: 12, sem_vprod_nf: 12, preenchidos_pela_nf: 0 });
    els['nfRodar'].click();
    await new Promise((r) => setTimeout(r, 60));
    const t = String(els['nfInfo'].innerHTML || els['nfInfo'].textContent || '');

    assert.ok(!/nenhum pedido pendente/.test(t),
      '[NF-LOCAL] havia 12 pedidos pendentes e a seção disse que não há pendência — o dono ' +
      'acharia a margem apurada quando ela segue por ESTIMATIVA');
    assert.ok(/12/.test(t),
      '[NF-LOCAL] não diz quantos continuam sem os dados da nota → ' + t.slice(0, 110));
    assert.ok(/rgba\(220,160,40/.test(t),
      '[NF-LOCAL] o caso "sobrou pendência" aparece com a mesma cara de "tudo certo"');
  }

  /* 3b) candidatos só por falta de numero_loja/UF (vprod_nf já presente): sem alarme falso */
  {
    const { els } = montar({ ok: true, candidatos: 5, sem_vprod_nf: 0, preenchidos_pela_nf: 0 });
    els['nfRodar'].click();
    await new Promise((r) => setTimeout(r, 60));
    const t = String(els['nfInfo'].innerHTML || els['nfInfo'].textContent || '');
    assert.ok(!/rgba\(220,160,40/.test(t),
      '[NF-LOCAL] avisou falta de nota em pedido que só faltava numero_loja/UF');
  }

  /* 4) tudo completo: não inventa alarme */
  {
    const { els } = montar({ ok: true, candidatos: 0, preenchidos_pela_nf: 0 });
    els['nfRodar'].click();
    await new Promise((r) => setTimeout(r, 60));
    const t = String(els['nfInfo'].innerHTML || els['nfInfo'].textContent || '');
    assert.ok(!/rgba\(220,160,40/.test(t),
      '[NF-LOCAL] sem pendência nenhuma a seção mostra aviso — alarme falso ensina a ignorar o aviso real');
  }

  /* 5) resposta sem ok:true é falha, não "nada a fazer" */
  {
    const { els } = montar({ error: 'not found' });
    els['nfRodar'].click();
    await new Promise((r) => setTimeout(r, 60));
    const t = String(els['nfInfo'].innerHTML || els['nfInfo'].textContent || '');
    assert.ok(!/nenhum pedido pendente/.test(t),
      '[NF-LOCAL] 404 por chave vencida virou "nenhum pedido pendente" — o dono acharia que ' +
      'conferiu e não conferiu nada');
  }

  console.log('OK: nf-local so roda no clique, separa "tudo completo" de "faltou nota" e nao mente na falha');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
