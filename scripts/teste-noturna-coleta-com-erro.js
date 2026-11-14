'use strict';
/* 14/11 — A MADRUGADA NÃO DIZ "✅ TUDO CONCLUÍDO" QUANDO UMA COLETA VOLTOU COM ERRO (lib/checkout/noturna-empresa.js).

   Pego na madrugada real de 14/11, no status que o dono colou (Girassol e AMB):
     "devoluções da Shopee (45 dias)": estado "ok", detalhe "0 novas de 0 vistas · 171 no total | janela … pagina 0: sem resposta"
   e o resumo da AMB: "✅ todas as etapas concluídas". Os coletores da Shopee (lib/shopee-devolucoes.js) não lançam — devolvem
   `erro` quando uma janela fica sem resposta —, e a etapa colava o erro no fim do texto e seguia como OK.
   E, na AMB: "poda do bucket de expedição (45 dias)": "undefined arquivos, undefined MB liberados" (lá a poda só responde
   `{ pulado: … }`, porque o bucket é podado na madrugada da Girassol).

   Aqui a madrugada inteira roda (a peça de produção, com as peças da empresa de mentira) e o resultado é lido pela MESMA
   rota que o dono abre (/noturna-status):
   · coleta de devoluções OU de carteira com `erro` → etapa em ERRO, com a contagem do que leu e o motivo, e o resumo acusa;
   · sem `erro` → etapa OK, o texto de sempre, e o resumo é "✅ todas as etapas concluídas" (controle: não reprova à toa);
   · poda que responde `{ pulado }` → diz que não roda nesta empresa e por quê, sem "undefined", e NÃO vira alerta
     (é permanente e de propósito — aviso que acende toda noite ensina a ignorar aviso);
   · poda de verdade ({ apagados, mb }) → o texto de sempre. */
const assert = require('assert');
const path = require('path');
const raiz = path.join(__dirname, '..');

(async () => {
  const _st = global.setTimeout; global.setTimeout = (fn) => _st(fn, 0);
  const _log = console.log, _err = console.error; console.log = () => {}; console.error = () => {};
  /* o TikTok e a Magalu de mentira (sem rede), como em scripts/teste-noturna-empresa-peca.js */
  const falsos = {
    [require.resolve(path.join(raiz, 'tiktok-oauth', 'index.js'))]: { chamar: async () => ({ ok: true, http: 200, corpo: { code: 0, data: { return_orders: [] } } }), lerToken: () => ({ access_token: 'x' }) },
    [require.resolve(path.join(raiz, 'magalu-oauth', 'index.js'))]: { coletarCancelados: async (e) => ({ ok: true, vistos: 2, novos: 1, empresa: e }) },
  };
  const salvos = {};
  for (const [k, v] of Object.entries(falsos)) { salvos[k] = require.cache[k]; require.cache[k] = { id: k, filename: k, loaded: true, exports: v }; }
  const { criarNoturna } = require('../lib/checkout/noturna-empresa');

  const SEM_RESPOSTA = 'janela 1793342635-1794638575 pagina 0: sem resposta';
  async function madrugada(o) {
    o = o || {};
    const ctx = {
      empresa: o.empresa || 'amb', prefixo: '/emp-teste',
      mlBillingSync: async () => ({ ok: true, meses: 2 }), backfillVendas: async () => ({ ok: true }), backfillEstado: () => ({ rodando: false }),
      mlSyncFees: async () => ({ ok: 4, total: 4, falhas: 0 }), varrerCancelados: async () => ({ ok: true }), canarioCron: async () => undefined,
      podarExpedicao: async () => (o.poda || { apagados: 110, mb: 14.4 }),
      resgatarHistorico: async () => ({ ok: true, faltando: 0, candidatos: 5, resgatados: [], adiados: [] }),
      coletarDevolucoes: async () => (o.devolucoes || { novas: 1, vistas: 2, guardadas: 3, erro: null }),
      coletarCarteira: async () => (o.carteira || { novas: 0, vistas: 1, guardadas: 1, erro: null }),
      coletarAds: async () => ({ ok: true, dias_novos: 1, dias_vistos: 36 }),
      conferirMarketplaces: async () => ({ ok: true, por_canal: { ml: { verificado: true, faltando_no_bling: 0, no_marketplace: 2 } }, alertas: [] }),
      consertarDoCanario: async () => ({ tentou: 0 }), coletarFinanceiroTikTok: async () => ({ ok: true, pedidos_novos: 1, guardados: 161 }),
      completarTarifaTikTok: async () => ({ ok: true, linhas_atualizadas: 0, pedidos_corrigidos: 0, tarifa_a_mais_reconhecida: 0, sem_financeiro_ainda: 0 }), VERSAO: 'v', validarSessao: () => null, ehAdmin: () => false,
      json: (res, c, b) => { res.c = c; res.b = b; },
    };
    process.env.ADMIN_KEY = 'adm-n';
    const n = criarNoturna(ctx);
    await n.rotinaNoturna('teste');
    const res = { c: 0, b: null };
    assert.ok(await n.rotas({ method: 'GET', headers: {} }, res, new URL('http://h/emp-teste/noturna-status?k=adm-n')), 'a rota de status não respondeu');
    const st = res.b;
    return { st, etapa: (nome) => (st.etapas || []).find((e) => e.nome === nome) };
  }
  const DEV = 'devoluções da Shopee (45 dias)', CAR = 'carteira da Shopee (30 dias)', PODA = 'poda do bucket de expedição (45 dias)';

  try {
    /* controle — tudo certo: as três etapas OK, com o texto de sempre, e o resumo sem alerta */
    let m = await madrugada();
    assert.ok(m.st.etapas.length >= 10, 'a madrugada não rodou as etapas: ' + JSON.stringify(m.st).slice(0, 200));
    assert.deepStrictEqual([m.etapa(DEV).estado, m.etapa(DEV).detalhe], ['ok', '1 novas de 2 vistas · 3 no total']);
    assert.deepStrictEqual([m.etapa(CAR).estado, m.etapa(CAR).detalhe], ['ok', '0 novas de 1 vistas · 1 no total']);
    assert.deepStrictEqual([m.etapa(PODA).estado, m.etapa(PODA).detalhe], ['ok', '110 arquivos, 14.4 MB liberados']);
    assert.strictEqual(m.st.resumo, '✅ todas as etapas concluídas', 'sem erro nenhum, o resumo não pode acusar: ' + m.st.resumo);

    /* o caso real de 14/11: devoluções sem resposta → ERRO, com a contagem e o motivo, e o resumo acusa */
    m = await madrugada({ devolucoes: { janelas: 3, novas: 0, vistas: 0, guardadas: 171, erro: SEM_RESPOSTA } });
    let e = m.etapa(DEV);
    assert.strictEqual(e.estado, 'erro', 'coleta de devoluções que voltou com erro não pode sair como ok: ' + JSON.stringify(e));
    assert.ok(e.detalhe.includes('0 novas de 0 vistas · 171 no total') && e.detalhe.includes(SEM_RESPOSTA), 'o erro tem que levar a contagem e o motivo: ' + e.detalhe);
    assert.ok(/^⚠️ /.test(m.st.resumo) && m.st.resumo.includes('1 etapa(s) com erro: ' + DEV) && !/todas as etapas conclu/.test(m.st.resumo), 'o resumo tem que acusar a coleta que falhou: ' + m.st.resumo);
    assert.strictEqual(m.etapa(CAR).estado, 'ok', 'a carteira, que veio boa, segue ok');
    /* a madrugada não para na etapa que falhou: as seguintes rodam */
    assert.ok(m.st.etapas.findIndex((x) => x.nome === CAR) > m.st.etapas.findIndex((x) => x.nome === DEV) && m.st.rodando === false && m.st.fim, 'a madrugada tem que seguir depois da etapa em erro');

    /* a carteira com erro (mesmo coletor, mesmo padrão) */
    m = await madrugada({ carteira: { janelas: 2, novas: 3, vistas: 40, guardadas: 1915, erro: 'janela 1 pagina 2: sem resposta' } });
    e = m.etapa(CAR);
    assert.ok(e.estado === 'erro' && e.detalhe.includes('3 novas de 40 vistas · 1915 no total') && e.detalhe.includes('pagina 2: sem resposta'), 'carteira com erro tem que acusar, com o que leu: ' + JSON.stringify(e));
    assert.ok(m.st.resumo.includes('1 etapa(s) com erro: ' + CAR), m.st.resumo);
    /* as duas juntas: as duas no resumo */
    m = await madrugada({ devolucoes: { novas: 0, vistas: 0, guardadas: 36, erro: SEM_RESPOSTA }, carteira: { novas: 0, vistas: 0, guardadas: 9, erro: 'x' } });
    assert.ok(m.st.resumo.includes('2 etapa(s) com erro: ') && m.st.resumo.includes(DEV) && m.st.resumo.includes(CAR), m.st.resumo);

    /* a poda da AMB ({ pulado }): diz o que é, sem "undefined", e não vira alerta */
    m = await madrugada({ poda: { ok: true, pulado: 'poda do bucket roda na noturna da Girassol' } });
    e = m.etapa(PODA);
    assert.ok(e.estado === 'ok' && e.detalhe === 'não roda nesta empresa — poda do bucket roda na noturna da Girassol' && !/undefined/.test(e.detalhe), 'a poda que não roda aqui tem que dizer isso: ' + JSON.stringify(e));
    assert.strictEqual(m.st.resumo, '✅ todas as etapas concluídas', 'poda que não roda nesta empresa é permanente e de propósito: não é alerta (' + m.st.resumo + ')');
    /* nenhuma etapa da madrugada pode mostrar "undefined" pro dono */
    for (const x of m.st.etapas) assert.ok(!/undefined/.test(String(x.detalhe)), 'etapa mostrando "undefined": ' + JSON.stringify(x));

    /* e a AMB de verdade entrega exatamente esse formato (se mudar lá, este teste avisa) */
    const amb = require('fs').readFileSync(path.join(raiz, 'amb-checkout-offline', 'index.js'), 'utf8');
    assert.ok(/podarExpedicao: async \(\) => \(\{ ok: true, pulado: 'poda do bucket roda na noturna da Girassol' \}\),/.test(amb), 'a AMB mudou o que entrega como poda — conferir o texto da etapa');
  } finally {
    global.setTimeout = _st; console.log = _log; console.error = _err;
    for (const [k, v] of Object.entries(salvos)) { if (v) require.cache[k] = v; else delete require.cache[k]; }
  }
  console.log('ok — madrugada: coleta da Shopee que volta com erro vira etapa em ERRO (com a contagem e o motivo) e entra no resumo; a poda que não roda na empresa diz isso, sem "undefined"');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && e.message); process.exit(1); });
