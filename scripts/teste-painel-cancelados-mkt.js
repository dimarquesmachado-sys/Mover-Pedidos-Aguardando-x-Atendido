/* 04/10 — CANCELADOS NO MARKETPLACE no painel, peça compartilhada.

   Confere se o marketplace cancelou pedido que o Bling ainda conta como venda. Cancelamento não
   abatido INFLA faturamento e margem do período.

   ⚠️ O CUIDADO CENTRAL, e o motivo deste teste existir: "0 cancelados" NÃO pode ter a mesma cara
   de "tudo conferido". Se Magalu/Amazon não têm cobertura, ou se parte dos pedidos do ML não foi
   verificada, isso precisa aparecer com destaque — senão o dono lê "nenhum cancelamento" como
   "está tudo certo", quando o certo é "ninguém olhou".

   ⚠️ E resposta sem `ok:true` é FALHA, não "nada encontrado": 404 por chave vencida resolve o
   fetch e viraria "nenhum cancelamento pendente" — a leitura mais perigosa possível aqui.

   ⚠️ MEDI ANTES DE ESCREVER: das 13 rotas que faltavam, só `/status-mkt` e `/historico` respondem
   de verdade na GOOD — e `/historico` ela JÁ TEM (a "Análise de Vendas", que eu quase dupliquei
   no #613). As outras não são tratadas, exigem sessão ou recusam por falta de peça.

   Marcador estável [CANC-MKT]. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
const { scriptDoStatusMkt } = require(path.join(raiz, 'lib', 'checkout', 'painel-status-mkt'));

const PREFIXOS = ['/good-checkout-offline', '/amb-checkout-offline', '/girassol-backup-offline'];
for (const base of PREFIXOS) {
  const s = scriptDoStatusMkt(base);
  assert.doesNotThrow(() => new Function(s), '[CANC-MKT] o script de ' + base + ' não compila');
  assert.ok(s.includes(base), '[CANC-MKT] ' + base + ': sem o prefixo da empresa');
  for (const outra of PREFIXOS) {
    if (outra !== base) assert.ok(!s.includes(outra),
      '[CANC-MKT] ' + base + ' carrega o prefixo de ' + outra + ' — conferiria a loja errada');
  }
  assert.ok(!/onclick=/.test(s), '[CANC-MKT] ' + base + ': onclick inline');
}

function montar(corpo) {
  const els = {};
  const novo = (id) => ({
    id, innerHTML: '', textContent: '', value: '', disabled: false, _ev: {},
    addEventListener(e, f) { this._ev[e] = f; },
    click() { this._ev.click && this._ev.click(); },
  });
  els['canceladosMktAqui'] = novo('canceladosMktAqui');
  global.document = { getElementById: (id) => els[id] || (els[id] = novo(id)) };
  global.window = { location: { search: '?k=teste' } };
  global.URLSearchParams = URLSearchParams;
  /* o dashboard expõe `janela(PERIODO)`; o script lê o período dali, não do mês corrente */
  global.PERIODO = 'ontem';
  global.janela = () => ({ de: '2026-10-03', ate: '2026-10-03' });
  global.setInterval = () => 0;
  global.__urls = [];
  global.fetch = async (u) => { global.__urls.push(u); return { json: async () => corpo }; };
  new Function(scriptDoStatusMkt('/good-checkout-offline'))();
  return els;
}

module.exports = (async () => {
  /* 1) COM cancelamento pendente: número e pedidos aparecem */
  {
    const els = montar({ ok: true, checados: 120, numeros: ['123037', '123048'],
      canais_checados: ['ml', 'shopee'], sem_cobertura: [] });
    els['cmChecar'].click();
    await new Promise((r) => setTimeout(r, 40));
    const c = String(els['cmCorpo'].innerHTML || '');
    assert.ok(/123037/.test(c) && /123048/.test(c),
      '[CANC-MKT] os pedidos cancelados não aparecem — é por eles que se acha no Bling');
    assert.ok(/INFLADOS|inflad/i.test(c),
      '[CANC-MKT] não explica o efeito: cancelamento não abatido infla faturamento e margem');
  }

  /* 2) ⚠️ ZERO cancelados MAS com buraco de cobertura: o buraco tem que aparecer destacado */
  {
    const els = montar({ ok: true, checados: 80, numeros: [],
      canais_checados: ['ml'], sem_cobertura: ['magalu', 'amazon'],
      ml_nao_verificados: 15 });
    els['cmChecar'].click();
    await new Promise((r) => setTimeout(r, 40));
    const c = String(els['cmCorpo'].innerHTML || '');
    assert.ok(/magalu/.test(c),
      '[CANC-MKT] não diz que Magalu/Amazon ficaram SEM conferência — o dono leria "0 cancelados" ' +
      'como "tudo certo", quando o certo é "ninguém olhou esse canal"');
    assert.ok(/15/.test(c),
      '[CANC-MKT] não diz quantos pedidos do ML ficaram sem verificar');
    assert.ok(/border:1px solid rgba\(220,160,40/.test(c),
      '[CANC-MKT] o buraco de cobertura aparece sem destaque — tem a mesma cara de "tudo certo"');
  }

  /* 3) tudo conferido e nada pendente: NÃO pode inventar alarme */
  {
    const els = montar({ ok: true, checados: 200, candidatos: 200, numeros: [],
      canais_checados: ['ml', 'shopee', 'tiktok'], sem_cobertura: [],
      ml_nao_verificados: 0, shopee_nao_verificados: 0, tiktok_sem_financeiro: 0 });
    els['cmChecar'].click();
    await new Promise((r) => setTimeout(r, 40));
    const c = String(els['cmCorpo'].innerHTML || '');
    assert.ok(!/rgba\(220,160,40/.test(c) && !/rgba\(220,70,70/.test(c),
      '[CANC-MKT] sem pendência e sem buraco, a seção ainda mostra alarme — alarme falso ensina ' +
      'a ignorar o aviso de verdade');
    assert.ok(/nenhum cancelamento/.test(c), '[CANC-MKT] não diz que está limpo');
  }

  /* 4) ⚠️ resposta SEM ok:true é falha, não "nada encontrado" */
  {
    const els = montar({ error: 'not found' });
    els['cmChecar'].click();
    await new Promise((r) => setTimeout(r, 40));
    const c = String(els['cmCorpo'].innerHTML || '');
    assert.ok(!/nenhum cancelamento/.test(c),
      '[CANC-MKT] 404 por chave vencida virou "nenhum cancelamento pendente" — é a leitura mais ' +
      'perigosa possível: o dono acharia que conferiu e não conferiu nada');
    assert.ok(/⚠️|não consegui/.test(c), '[CANC-MKT] a falha não é avisada');
  }

  /* 5) Codex #614: o período pedido é o do dashboard (janela/PERIODO), não o mês corrente */
  {
    const els = montar({ ok: true, checados: 5, candidatos: 5, numeros: [], canais_checados: ['ml'], sem_cobertura: [] });
    els['cmChecar'].click();
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(/de=2026-10-03&ate=2026-10-03/.test(global.__urls[0]),
      '[CANC-MKT] não usou o período mostrado no dashboard: ' + global.__urls[0]);
    assert.ok(/2026-10-03/.test(els['cmCorpo'].innerHTML), '[CANC-MKT] o resultado não diz a que período se refere');
  }

  /* 6) Codex #614: sem período legível, recusa — não adivinha o mês corrente */
  {
    const els = montar({ ok: true });
    global.janela = undefined;
    els['cmChecar'].click();
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(global.__urls.length, 0, '[CANC-MKT] consultou sem saber o período');
    assert.ok(/nada foi conferido/.test(els['cmCorpo'].innerHTML), '[CANC-MKT] não avisa que não conferiu');
  }

  /* 7) Codex #614: total vem de cancelados_agora (numeros é cortado em 30), e lista parcial é dita */
  {
    const nums = Array.from({ length: 30 }, (_, i) => String(1000 + i));
    const els = montar({ ok: true, checados: 90, candidatos: 90, cancelados_agora: 45, numeros: nums, canais_checados: ['ml'], sem_cobertura: [] });
    els['cmChecar'].click();
    await new Promise((r) => setTimeout(r, 40));
    const c = String(els['cmCorpo'].innerHTML || '');
    assert.ok(/<b>45 pedido/.test(c), '[CANC-MKT] mostra 30 em vez do total real de 45');
    assert.ok(/lista parcial/.test(c), '[CANC-MKT] não diz que a lista de números está cortada');
  }

  /* 8) Codex #614: ZERO candidatos (GOOD sem índice local) não é "limpo" */
  {
    const els = montar({ ok: true, checados: 0, candidatos: 0, numeros: [], canais_checados: ['ml', 'shopee'], sem_cobertura: ['magalu'] });
    els['cmChecar'].click();
    await new Promise((r) => setTimeout(r, 40));
    const c = String(els['cmCorpo'].innerHTML || '');
    assert.ok(!/nenhum cancelamento pendente/.test(c), '[CANC-MKT] declarou "limpo" sem ter olhado pedido algum');
    assert.ok(/nada foi conferido/.test(c), '[CANC-MKT] não avisa que nada foi conferido');
  }

  /* 9) Codex #614: cancelamento já detectado antes continua aparecendo (os cards vêm do Supabase) */
  {
    const els = montar({ ok: true, checados: 10, candidatos: 10, numeros: [], ja_marcados: ['777'], ja_marcados_total: 1,
      canais_checados: ['ml'], sem_cobertura: [] });
    els['cmChecar'].click();
    await new Promise((r) => setTimeout(r, 40));
    const c = String(els['cmCorpo'].innerHTML || '');
    assert.ok(/777/.test(c) && !/nenhum cancelamento pendente/.test(c),
      '[CANC-MKT] cancelamento já marcado sumiu e o período foi dado como limpo');
  }

  /* 10) Codex #614: o endpoint conta pedido cortado (80 ML / 60 Shopee) como NÃO verificado */
  {
    const fab = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'fabrica-rotas-painel.js'), 'utf8');
    assert.ok(/mlFalhas \+= mlCortados/.test(fab) && /shFalhas \+= shCortados/.test(fab),
      '[CANC-MKT] pedidos cortados pelo slice entram como conferidos');
  }

  /* a fábrica serve, a tela inclui e a guarda libera */
  {
    const fab = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'fabrica-rotas-painel.js'), 'utf8');
    assert.ok(/'\/js\/cancelados-mkt\.js'/.test(fab), '[CANC-MKT] a fábrica não serve o script');
    const tela = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'dashboard.html'), 'utf8');
    assert.ok(/id="canceladosMktAqui"/.test(tela), '[CANC-MKT] a tela da GOOD não abre o espaço');
    assert.ok(/js\/cancelados-mkt\.js/.test(tela), '[CANC-MKT] a tela não inclui o script');
    const idx = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
    assert.ok(idx.indexOf("js/cancelados-mkt.js' ||") >= 0,
      '[CANC-MKT] o script não está liberado na guarda — quem abre por ?k= tomaria 401');
  }

  console.log('OK: cancelados do mkt destaca pendencia E buraco de cobertura, sem inventar alarme');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
