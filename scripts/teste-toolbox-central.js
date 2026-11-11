'use strict';
/* 11/11 — A CENTRAL DA TOOLBOX (2.1.14). Pedido do dono: "toda vez que subo, tenho que ficar um por um do toolbox
   validando... uma tela só que liste tudo, mostre qual precisa de senha, login, e 1 único botão que mande e valide tudo
   de uma vez — e que já deixe definir qual empresa".
   A lógica mora em toolbox-extensao/tb-acoes.js (sem tela). Prova, num navegador de mentira:
   · cada empresa vê só os módulos DELA (Girassol sem Cookie Bling; AMB sem Madeira);
   · cada ação diz o estado certo e o que falta: sem chave → 'chave'; sem login no site → 'login' com o atalho do site;
     servidor recusou a chave → 'chave'; sessão gravada e viva → 'ok'; gravada sem confirmar → 'login';
   · a sessão vai pro checkout DA EMPRESA da instalação, com a chave; o Bling manda `empresa=` certo;
   · o Madeira pede a aba aberta ('abrir'), espera o resultado do pedido DELE e trata lote ilegível como 'login';
   · o código da coleta NÃO é reenviado (só o estado) e o "já entregue" é da empresa da instalação;
   · o "atualizar tudo" roda na ordem, uma ação que quebra não derruba as outras;
   · as chaves entram num lugar só e cada módulo continua achando a sua;
   · nada de automação: a peça não abre aba, não clica; e o menu tem o cartão da Central. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const raiz = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'tb-acoes.js'), 'utf8');

function montar(o) {
  o = o || {};
  const st = Object.assign({}, o.local), sy = Object.assign({}, o.sync), chamadas = [], ouvintes = [], msgs = [], tabMsgs = [];
  const chrome = {
    storage: { local: { get: async (ks) => { const r = {}; for (const k of ks) if (k in st) r[k] = st[k]; return r; }, set: async (v) => { const mud = {}; for (const k of Object.keys(v)) { mud[k] = { newValue: v[k] }; st[k] = v[k]; } for (const f of ouvintes.slice()) f(mud, 'local'); }, remove: async (k) => { for (const x of [].concat(k)) delete st[x]; } },
      sync: { get: (ks, cb) => { const r = {}; for (const k of ks) if (k in sy) r[k] = sy[k]; cb(r); }, set: (v, cb) => { Object.assign(sy, v); if (cb) cb(); } },
      onChanged: { addListener: (f) => ouvintes.push(f), removeListener: (f) => { const i = ouvintes.indexOf(f); if (i >= 0) ouvintes.splice(i, 1); } } },
    cookies: { getAll: async (q) => (o.cookies && o.cookies[q.url]) || [] },
    permissions: { contains: async () => true, request: async () => true },
    tabs: { query: async (q) => (/madeiramadeira/.test(q.url || '') ? (o.abasMM || []) : []), sendMessage: (id, m, cb) => { tabMsgs.push([id, m]); if (o.aoPedirMM) o.aoPedirMM(m, chrome); cb(); }, create: () => { throw new Error('a peça não pode abrir aba'); } },
    runtime: { lastError: null, sendMessage: (m, cb) => { msgs.push(m); cb(o.respFragil); } },
  };
  const fetch = async (url, opt) => { chamadas.push({ url, opt: opt || {} }); const r = (o.respostas && o.respostas(url, opt)) || { status: 200, corpo: { ok: true } }; return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.corpo }; };
  const ctx = vm.createContext({ chrome, fetch, navigator: { userAgent: 'UA-teste' }, setTimeout, clearTimeout, console, Date, Math, JSON, Map, Promise, encodeURIComponent, Object, Array, String });
  ctx.self = ctx;
  vm.runInContext(SRC, ctx);
  return { T: ctx.tbAcoes, st, sy, chamadas, msgs, tabMsgs, chrome };
}

(async () => {
  let x = montar();
  const ids = (e) => x.T.itensDa(e).map((i) => i.id).join();
  assert.strictEqual(ids('girassol'), 'shopee,mm,respostas,fragil,coleta', 'Girassol: sem Cookie Bling');
  assert.strictEqual(ids('good'), 'shopee,bling,mm,respostas,fragil,coleta', 'GOOD: todos');
  assert.strictEqual(ids('amb'), 'shopee,bling,respostas,fragil,coleta', 'AMB: sem Madeira');

  /* ── Sessão Shopee ── */
  let r = await x.T.ACOES.shopee('amb');
  assert.ok(r.estado === 'chave' && x.chamadas.length === 0, 'sem a chave não pode nem tentar: ' + JSON.stringify(r));
  x = montar({ local: { sceKey: 'K' } }); r = await x.T.ACOES.shopee('amb');
  assert.ok(r.estado === 'login' && /seller\.shopee/.test(r.site) && /AMBTotal/.test(r.msg) && x.chamadas.length === 0, 'sem cookie: pede o login, com o atalho do site e o nome da empresa');
  const ck = { 'https://seller.shopee.com.br/': [{ name: 'SPC_EC', value: 'velho' }, { name: 'SPC_EC', value: 'novo' }, { name: 'SPC_U', value: '9' }] };
  x = montar({ local: { sceKey: 'K' }, cookies: ck, respostas: () => ({ status: 200, corpo: { ok: true, viva: true } }) }); r = await x.T.ACOES.shopee('amb');
  assert.ok(r.estado === 'ok' && /VIVA \(2 cookies\)/.test(r.msg), 'sessão viva: ' + JSON.stringify(r));
  assert.ok(/\/amb-checkout-offline\/shopee-sessao-cookies\?k=K$/.test(x.chamadas[0].url) && JSON.parse(x.chamadas[0].opt.body).cookie === 'SPC_EC=novo; SPC_U=9' && x.chamadas[0].opt.headers['X-Admin-Key'] === 'K', 'a sessão tem que ir pro checkout DA EMPRESA, com a chave e sem cookie repetido: ' + JSON.stringify(x.chamadas[0]));
  x = montar({ local: { sceKey: 'K' }, cookies: ck, respostas: () => ({ status: 200, corpo: { ok: true, viva: false, teste: { motivo: 'expirada' } } }) }); r = await x.T.ACOES.shopee('good');
  assert.ok(r.estado === 'login' && /expirada/.test(r.msg) && /\/good-checkout-offline\//.test(x.chamadas[0].url), 'gravada sem confirmar: pede o login de novo');
  x = montar({ local: { sceKey: 'errada' }, cookies: ck, respostas: () => ({ status: 404, corpo: { error: 'not found' } }) }); r = await x.T.ACOES.shopee('girassol');
  assert.ok(r.estado === 'chave' && /recusou a ADMIN_KEY/.test(r.msg), 'chave errada: diz que é a chave (não "erro" genérico)');
  x = montar({ local: { sceKey: 'K' }, cookies: ck, respostas: () => ({ status: 500, corpo: { ok: false, erro: 'disco cheio' } }) }); r = await x.T.ACOES.shopee('girassol');
  assert.ok(r.estado === 'erro' && /disco cheio/.test(r.msg), 'erro do servidor aparece com o motivo');

  /* ── Cookie Bling ── */
  x = montar({ local: { sceKey: 'K' } }); r = await x.T.ACOES.bling('girassol');
  assert.strictEqual(r.estado, 'info', 'Girassol não tem Cookie Bling');
  r = await x.T.ACOES.bling('amb'); assert.ok(r.estado === 'login' && /bling\.com\.br/.test(r.site), 'sem cookie do Bling: login');
  const cb = { 'https://www.bling.com.br/': [{ name: 'PHPSESSID', value: 'abc' }] };
  /* Codex #845 (2): salvar o cookie não prova a sessão — depois de salvar, o teste DE VERDADE do servidor (/cookie-testar) */
  const blingSrv = (teste) => (url) => (/cookie-testar/.test(url) ? teste : { status: 200, corpo: { ok: true, caracteres: 13, tem_phpsessid: true } });
  x = montar({ local: { tbBlingKey: 'K2' }, cookies: cb, respostas: blingSrv({ status: 200, corpo: { ok: true, viva: true } }) }); r = await x.T.ACOES.bling('amb');
  assert.ok(r.estado === 'ok' && /VIVA/.test(r.msg) && /\/magalu\/nf-full\/cookie\?empresa=amb&k=K2$/.test(x.chamadas[0].url) && /cookie: PHPSESSID=abc\nuser-agent: UA-teste/.test(JSON.parse(x.chamadas[0].opt.body).texto) && /\/magalu\/nf-full\/cookie-testar\?empresa=amb&k=K2$/.test(x.chamadas[1].url), 'Bling: salva e TESTA a sessão, com a empresa certa: ' + JSON.stringify(x.chamadas.map((c2) => c2.url)));
  x = montar({ local: { sceKey: 'K' }, cookies: cb, respostas: blingSrv({ status: 502, corpo: { ok: true, viva: false, motivo: 'o Bling mandou pra tela de login' } }) }); r = await x.T.ACOES.bling('good');
  assert.ok(r.estado === 'login' && /recusou a sessão/.test(r.msg) && /tela de login/.test(r.msg), 'sessão que o Bling recusou não pode ficar verde: ' + JSON.stringify(r));
  x = montar({ local: { sceKey: 'K' }, cookies: cb, respostas: blingSrv({ status: 502, corpo: { ok: false, viva: false, erro: 'timeout' } }) }); r = await x.T.ACOES.bling('good');
  assert.ok(r.estado === 'erro' && /não consegui testar/.test(r.msg) && /timeout/.test(r.msg), 'teste que NÃO RODOU não é "sessão ruim" nem "ok": ' + JSON.stringify(r));
  x = montar({ local: { sceKey: 'K' }, cookies: cb, respostas: () => ({ status: 200, corpo: { ok: true, caracteres: 5, tem_phpsessid: false } }) }); r = await x.T.ACOES.bling('good');
  assert.ok(r.estado === 'login' && /PHPSESSID/.test(r.msg), 'cookie sem a sessão: pede o login de novo');

  /* ── Respostas Rápidas ── */
  x = montar(); r = await x.T.ACOES.respostas('good'); assert.strictEqual(r.estado, 'chave');
  x = montar({ sync: { apiKey: 'R', apiUrl: 'https://srv/' }, respostas: () => ({ status: 200, corpo: { respostas: [1, 2, 3] } }) }); r = await x.T.ACOES.respostas('good');
  assert.ok(r.estado === 'ok' && /3 respostas para GIMPO/.test(r.msg) && x.chamadas[0].url === 'https://srv/respostas-rapidas/api/respostas?loja=GIMPO' && x.chamadas[0].opt.headers['X-API-Key'] === 'R', 'Respostas: loja da empresa e a chave: ' + JSON.stringify(x.chamadas[0]));
  x = montar({ sync: { apiKey: 'R' }, respostas: () => ({ status: 401, corpo: {} }) }); r = await x.T.ACOES.respostas('amb'); assert.strictEqual(r.estado, 'chave');
  /* Codex #845 (P1): os identificadores de loja são os do SERVIDOR (maiúsculos, os mesmos da tela das Respostas) — e a loja
     que o dono já escolheu naquela tela vale mais que a da empresa */
  assert.strictEqual(JSON.stringify(x.T.LOJA_RESPOSTAS), JSON.stringify({ girassol: 'GIRASSOL', good: 'GIMPO', amb: 'AMBTOTAL' }));
  const srcResp = fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'respostas.js'), 'utf8');
  assert.ok(srcResp.includes("const MAPA_LOJA = { girassol: 'GIRASSOL', good: 'GIMPO', amb: 'AMBTOTAL' };"), 'o mapa de lojas da tela das Respostas mudou — o da Central tem que acompanhar');
  x = montar({ sync: { apiKey: 'R', loja: 'GIRASSOL' }, respostas: () => ({ status: 200, corpo: { respostas: [] } }) }); await x.T.ACOES.respostas('amb');
  assert.ok(/loja=GIRASSOL$/.test(x.chamadas[0].url), 'a loja salva na tela das Respostas tem que valer');

  /* ── Alerta Frágil ── */
  x = montar({ respFragil: { ok: true, skus: 42 } }); r = await x.T.ACOES.fragil('amb');
  assert.ok(r.estado === 'ok' && /42 SKU/.test(r.msg) && x.st.extension_config.servidorUrl === x.T.HOST && x.msgs[0].type === 'SYNC_AGORA', 'Frágil: instalação nova ganha o servidor padrão e sincroniza');
  x = montar({ local: { extension_config: { servidorUrl: 'https://meu', intervaloMin: 9 } }, respFragil: { ok: false, erro: 'HTTP 502' } }); r = await x.T.ACOES.fragil('amb');
  assert.ok(r.estado === 'erro' && /502/.test(r.msg) && x.st.extension_config.servidorUrl === 'https://meu' && x.st.extension_config.intervaloMin === 9, 'Frágil: não mexe no servidor já configurado e mostra o erro');

  /* ── Madeira Madeira ── */
  x = montar({ local: { syncKey: 'M' } }); r = await x.T.ACOES.mm('amb'); assert.strictEqual(r.estado, 'info', 'AMB não tem Madeira');
  x = montar(); r = await x.T.ACOES.mm('good'); assert.strictEqual(r.estado, 'chave');
  x = montar({ local: { syncKey: 'M' } }); r = await x.T.ACOES.mm('good'); assert.ok(r.estado === 'abrir' && /madeiramadeira/.test(r.site), 'sem a aba do painel: pede pra abrir');
  const responde = (status) => (m, chrome) => { setTimeout(() => chrome.storage.local.set({ ultimoStatus: { motivo: 'manual', pedidos: ['outro'] } }), 5); setTimeout(() => chrome.storage.local.set({ ultimoStatus: Object.assign({ motivo: 'manual', pedidos: [m.pedido] }, status) }), 20); };
  x = montar({ local: { syncKey: 'M' }, abasMM: [{ id: 7 }], aoPedirMM: responde({ etapa: 'sync', ok: true, lidos: 5, prontos: 4, etiquetas: 2 }) }); r = await x.T.ACOES.mm('girassol', { esperaMs: 500 });
  assert.ok(r.estado === 'ok' && /lidos 5, prontos 4, etiquetas 2/.test(r.msg) && x.tabMsgs[0][0] === 7 && x.tabMsgs[0][1].tipo === 'MM_SYNC_AGORA', 'Madeira: espera o resultado do pedido DELE (o de outro pedido não vale): ' + JSON.stringify(r));
  x = montar({ local: { syncKey: 'M' }, abasMM: [{ id: 7 }], aoPedirMM: responde({ etapa: 'ler_mm', ok: false, status: 401 }) }); r = await x.T.ACOES.mm('good', { esperaMs: 500 });
  assert.ok(r.estado === 'login' && /401/.test(r.msg), 'Madeira sem conseguir ler os lotes: login');
  /* Codex #845: etiqueta não entregue NÃO é "tudo certo" (o bg-mm grava ok:true com zpl_falhas) */
  x = montar({ local: { syncKey: 'M' }, abasMM: [{ id: 7 }], aoPedirMM: responde({ etapa: 'sync', ok: true, lidos: 3, prontos: 3, zpl_falhas: [{ batch: 306783, motivo: 'veio vazio', esperando: true }] }) }); r = await x.T.ACOES.mm('good', { esperaMs: 500 });
  assert.ok(r.estado === 'pendente' && /1 etiqueta\(s\) ainda não entregue/.test(r.msg) && /306783/.test(r.msg) && /veio vazio/.test(r.msg), 'lote com etiqueta não entregue tinha que aparecer como pendente, com o lote e o motivo: ' + JSON.stringify(r));
  /* Codex #845: a rodada que passa do aviso CONTINUA sendo acompanhada — o resultado de verdade chega pelo `depois` */
  const tardios = [];
  x = montar({ local: { syncKey: 'M' }, abasMM: [{ id: 7 }], aoPedirMM: (m, chrome) => { setTimeout(() => chrome.storage.local.set({ ultimoStatus: { motivo: 'manual', pedidos: [m.pedido], etapa: 'sync', ok: true, lidos: 9, prontos: 9 } }), 150); } });
  r = await x.T.ACOES.mm('good', { esperaMs: 40, limiteMs: 2000, depois: (r2) => tardios.push(r2) });
  assert.ok(r.estado === 'pendente' && /ainda sincronizando/.test(r.msg) && tardios.length === 0, 'passou do aviso: pendente (não erro definitivo): ' + JSON.stringify(r));
  await new Promise((s2) => setTimeout(s2, 220));
  assert.ok(tardios.length === 1 && tardios[0].estado === 'ok' && /lidos 9/.test(tardios[0].msg), 'o resultado que chegou depois do aviso tinha que substituir o aviso: ' + JSON.stringify(tardios));
  /* e se nunca terminar: no limite, avisa o que conferir (uma vez) e para de ouvir */
  const fins = [];
  x = montar({ local: { syncKey: 'M' }, abasMM: [{ id: 7 }] }); r = await x.T.ACOES.mm('good', { esperaMs: 30, limiteMs: 90, depois: (r2) => fins.push(r2) });
  await new Promise((s2) => setTimeout(s2, 140));
  assert.ok(r.estado === 'pendente' && fins.length === 1 && fins[0].estado === 'erro' && /não terminou/.test(fins[0].msg), 'Madeira que nunca responde: no limite, erro com o que conferir: ' + JSON.stringify(fins));

  /* ── código da coleta: só o estado, da empresa desta instalação ── */
  x = montar(); r = await x.T.ACOES.coleta('amb'); assert.strictEqual(r.estado, 'chave');
  x = montar({ local: { coleta_key: 'T', coleta_ok: { empresa: 'good', dia: '2026-11-10' } } }); r = await x.T.ACOES.coleta('amb');
  assert.ok(r.estado === 'info' && /nenhum ainda/.test(r.msg) && x.chamadas.length === 0 && x.msgs.length === 0, 'coleta: o "já entregue" de OUTRA empresa não conta — e nada é reenviado');
  r = await x.T.ACOES.coleta('good'); assert.ok(/10\/11\/2026/.test(r.msg));

  /* ── atualizar tudo ── */
  const passos = [];
  const falsas = { shopee: async () => ({ estado: 'ok', msg: 'a' }), bling: async () => { throw new Error('quebrou'); }, respostas: async () => ({ estado: 'chave', msg: 'c' }), fragil: async () => null, coleta: async () => ({ estado: 'info', msg: 'e' }) };
  let ganchoColeta = null; falsas.coleta = async (emp, opc) => { ganchoColeta = opc && opc.depois; return { estado: 'info', msg: 'e' }; };
  x = montar(); const saida = await x.T.atualizarTudo('amb', (id, e, tardio) => passos.push(id + ':' + e.estado + (tardio ? ':tardio' : '')), falsas);
  assert.strictEqual(saida.map((s) => s.id + ':' + s.estado).join(), 'shopee:ok,bling:erro,respostas:chave,fragil:erro,coleta:info', 'uma ação que quebra (ou não responde) não derruba as outras: ' + JSON.stringify(saida));
  assert.strictEqual(passos.join(), 'shopee:rodando,shopee:ok,bling:rodando,bling:erro,respostas:rodando,respostas:chave,fragil:rodando,fragil:erro,coleta:rodando,coleta:info', 'a tela é avisada antes e depois de cada módulo, na ordem');

  /* o resultado tardio de um módulo (o Madeira) chega à tela pelo mesmo caminho */
  assert.strictEqual(typeof ganchoColeta, 'function', 'o "atualizar tudo" tem que entregar à ação o gancho do resultado tardio');
  ganchoColeta({ estado: 'ok', msg: 'chegou depois' }); assert.strictEqual(passos[passos.length - 1], 'coleta:ok:tardio');
  assert.strictEqual(x.T.ITENS.filter((i) => i.sessao).map((i) => i.id).join(), 'shopee,bling,mm', 'quem manda a SESSÃO do navegador tem que estar marcado (pede a confirmação da conta)');

  /* ── as chaves num lugar só ── */
  x = montar({ sync: { apiUrl: 'https://ja-tinha' } }); await x.T.gravarChaves({ admin: ' ADM ', toolbox: 'TB', mm: 'MM', respostas: 'RR' }, 'amb');
  assert.ok(x.st.sceKey === 'ADM' && x.st.tbBlingKey === 'ADM' && x.st.coleta_key === 'TB' && x.st.syncKey === 'MM' && x.sy.apiKey === 'RR' && x.sy.apiUrl === 'https://ja-tinha' && x.sy.loja === 'AMBTOTAL', 'cada módulo tem que continuar achando a chave DELE: ' + JSON.stringify([x.st, x.sy]));
  x = montar(); await x.T.gravarChaves({ respostas: 'RR' }, 'good'); assert.ok(x.sy.apiUrl === x.T.HOST && x.sy.loja === 'GIMPO', 'Respostas em instalação nova: servidor padrão e a loja da empresa');
  x = montar({ sync: { loja: 'GIRASSOL' } }); await x.T.gravarChaves({ respostas: 'RR' }, 'amb'); assert.strictEqual(x.sy.loja, 'GIRASSOL', 'salvar as chaves não pode trocar a loja que já estava escolhida');
  const c = await montar({ local: { tbBlingKey: 'B', coleta_key: 'T' } }).T.lerChaves(); assert.ok(c.admin === 'B' && c.toolbox === 'T', 'a Central mostra a chave que algum módulo já tinha');

  /* ── sem automação, e a Central no menu ── */
  assert.ok(!/tabs\.create|\.click\(|alarms\./.test(SRC), 'a peça de ações não pode abrir aba, clicar nem agendar nada');
  const central = fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'central.js'), 'utf8');
  assert.ok((central.match(/confirm\(/g) || []).length === 2 && /Os sites abertos neste navegador[^']*estão logados nas contas da /.test(central), 'a Central tem UMA pergunta de quem são as contas logadas (usada no "tudo" e no "só este" de sessão) — e outra só na troca de empresa');

  /* ── a TELA de verdade, num DOM de mentira (Codex #845): enquanto roda, o botão único e os "só este" ficam travados —
     redesenhar a lista não reabilita nada, e um segundo clique não abre outra rodada; e o "só este" de quem manda
     sessão pergunta de quem é a conta ── */
  { const els = {}; const el = (id) => (els[id] = els[id] || { id, value: '', textContent: '', innerHTML: '', disabled: false, style: {}, dataset: {}, _ev: {}, addEventListener(t2, f) { this._ev[t2] = f; } });
    let soltar = null, chamadasShopee = 0, perguntas = 0, respostaConfirm = true;
    const Tfake = Object.assign({}, x.T, { lerChaves: async () => ({ admin: 'K', toolbox: '', mm: '', respostas: '' }), gravarChaves: async () => {},
      ACOES: Object.assign({}, x.T.ACOES, { shopee: async () => { chamadasShopee++; await new Promise((ok) => { soltar = ok; }); return { estado: 'ok', msg: 'viva' }; }, bling: async () => ({ estado: 'ok', msg: 'b' }), respostas: async () => ({ estado: 'ok', msg: 'r' }), fragil: async () => ({ estado: 'ok', msg: 'f' }), coleta: async () => ({ estado: 'info', msg: 'c' }) }) });
    Tfake.atualizarTudo = (emp, aoAndar) => x.T.atualizarTudo(emp, aoAndar, Tfake.ACOES);
    const ctxTela = vm.createContext({ self: { tbAcoes: Tfake }, document: { getElementById: el, querySelectorAll: () => [] }, confirm: () => { perguntas++; return respostaConfirm; }, setTimeout, console, Object, String, Promise,
      chrome: { runtime: { getManifest: () => ({ version: '9' }) }, storage: { local: { get: async () => ({ tb_empresa: 'amb' }), set: async () => {}, remove: async () => {} } }, tabs: { create: () => {} } } });
    vm.runInContext(central, ctxTela);
    await new Promise((s2) => setTimeout(s2, 30));
    assert.strictEqual(els.tudo.disabled, false, 'com a empresa escolhida o botão único começa liberado');
    els.tudo._ev.click(); await new Promise((s2) => setTimeout(s2, 30));
    assert.ok(els.tudo.disabled === true && els.emp.disabled === true && /<button class="sec so" data-id="shopee" disabled>/.test(els.itens.innerHTML) && perguntas === 1, 'DURANTE a rodada o botão único, a empresa e os "só este" têm que ficar travados (redesenhar não reabilita): ' + JSON.stringify([els.tudo.disabled, els.emp.disabled, perguntas]));
    els.tudo._ev.click(); await new Promise((s2) => setTimeout(s2, 20));
    assert.ok(chamadasShopee === 1 && perguntas === 1, 'um segundo clique no meio não pode abrir outra rodada');
    soltar(); await new Promise((s2) => setTimeout(s2, 40));
    assert.ok(els.tudo.disabled === false && /tudo certo: 5 módulos/.test(els.resumo.innerHTML), 'no fim libera e resume: ' + els.resumo.innerHTML);
    /* "só este" de sessão: pergunta a conta; se a resposta é não, nada vai */
    respostaConfirm = false; const antes = chamadasShopee;
    vm.runInContext("rodarUm('shopee')", ctxTela); await new Promise((s2) => setTimeout(s2, 20));
    assert.ok(perguntas === 2 && chamadasShopee === antes, 'o "só este" da Sessão Shopee tem que perguntar de quem é a conta — e não mandar se a resposta for não');
    vm.runInContext("rodarUm('fragil')", ctxTela); await new Promise((s2) => setTimeout(s2, 20));
    assert.strictEqual(perguntas, 2, 'módulo que não manda sessão (Frágil) não pergunta nada');
    /* Codex #845 (2) e (3): o Madeira que passa do aviso CONTINUA rodando lá no site. Enquanto isso: a EMPRESA NÃO MUDA (o
       fundo lê a empresa só na hora de mandar os lotes — trocar no meio mandaria os lotes da GOOD pra Girassol), o módulo
       não roda de novo e o "tudo" espera; quando o fim de verdade chega, o resultado entra e tudo libera */
    let ganchoMM = null, gravouEmpresa = []; respostaConfirm = true;
    ctxTela.chrome.storage.local.set = async (v) => { if (v && v.tb_empresa) gravouEmpresa.push(v.tb_empresa); };
    Tfake.ACOES.mm = async (emp, opc) => { ganchoMM = opc.depois; return { estado: 'pendente', andando: true, msg: 'ainda sincronizando' }; };
    vm.runInContext("EMP = 'good'; desenhar()", ctxTela);
    vm.runInContext("rodarUm('mm')", ctxTela); await new Promise((s2) => setTimeout(s2, 30));
    assert.ok(/ainda sincronizando/.test(els.itens.innerHTML) && typeof ganchoMM === 'function', 'o Madeira pendente tinha que aparecer na tela');
    assert.ok(els.emp.disabled === true && els.tudo.disabled === true && /<button class="sec so" data-id="mm" disabled>/.test(els.itens.innerHTML) && /<button class="sec so" data-id="shopee">/.test(els.itens.innerHTML), 'com o Madeira ainda andando: empresa travada, "tudo" travado, o Madeira não roda de novo — os outros módulos seguem livres');
    els.emp.value = 'girassol'; await els.emp._ev.change(); await new Promise((s2) => setTimeout(s2, 20));
    assert.ok(gravouEmpresa.length === 0 && els.emp.value === 'good' && vm.runInContext('EMP', ctxTela) === 'good' && /espere a sincronização/.test(els.resumo.textContent), 'trocar de empresa com o Madeira andando tinha que ser RECUSADO (senão os lotes da GOOD iam pro checkout da Girassol): ' + JSON.stringify([gravouEmpresa, els.emp.value]));
    const antesMM = ganchoMM; vm.runInContext("rodarUm('mm')", ctxTela); await new Promise((s2) => setTimeout(s2, 20));
    assert.strictEqual(ganchoMM, antesMM, 'o Madeira ainda andando não pode ser disparado de novo');
    ganchoMM({ estado: 'ok', msg: 'sincronizado: lidos 4' }); await new Promise((s2) => setTimeout(s2, 10));
    assert.ok(/sincronizado: lidos 4/.test(els.itens.innerHTML) && els.emp.disabled === false && els.tudo.disabled === false, 'o fim de verdade tinha que entrar na tela e liberar a empresa e o botão');
    /* agora sim dá pra trocar — e um resultado velho que chegasse depois não entra na tela da outra empresa */
    els.emp.value = 'girassol'; await els.emp._ev.change(); await new Promise((s2) => setTimeout(s2, 20));
    assert.ok(gravouEmpresa.join() === 'girassol' && vm.runInContext('EMP', ctxTela) === 'girassol', 'com tudo parado a troca de empresa vale');
    antesMM({ estado: 'ok', msg: 'RESULTADO VELHO DA GOOD' }); await new Promise((s2) => setTimeout(s2, 10));
    assert.ok(!/RESULTADO VELHO DA GOOD/.test(els.itens.innerHTML), 'resultado atrasado de outra empresa/rodada não pode entrar na tela'); }
  const html = fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'central.html'), 'utf8');
  assert.ok(html.indexOf('<script src="tb-acoes.js">') > 0 && html.indexOf('<script src="tb-acoes.js">') < html.indexOf('<script src="central.js">') && !/<script>[^<]/.test(html) && !/ on(click|change)=/.test(html), 'a tela carrega a peça antes dela e não tem script nem evento escrito no HTML (a extensão bloqueia)');
  for (const id of ['emp', 'k_admin', 'k_toolbox', 'k_mm', 'k_respostas', 'cx_mm', 'salvar', 'salvo', 'tudo', 'itens', 'resumo', 'versao']) assert.ok(html.includes('id="' + id + '"'), 'a tela usa #' + id + ' e ele não existe no HTML');
  const popup = fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'popup.js'), 'utf8');
  assert.ok(/href="central\.html"/.test(popup.slice(popup.indexOf('const CARTOES = ['), popup.indexOf('mm.html'))), 'o menu tem que abrir a Central (primeiro cartão)');
  /* a versão da extensão que traz a Central: 2.1.14 em diante (sem cravar o número — a próxima versão não pode quebrar isto) */
  const v = JSON.parse(fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'manifest.json'), 'utf8')).version.split('.').map(Number);
  assert.ok(v[0] > 2 || (v[0] === 2 && (v[1] > 1 || (v[1] === 1 && v[2] >= 14))), 'a Central nasceu na 2.1.14 — a versão do manifesto ficou pra trás: ' + v.join('.'));
  console.log('ok — Central da Toolbox: cada módulo diz o estado e o que falta, a sessão vai pra empresa da instalação, o "atualizar tudo" roda todos em ordem sem um derrubar o outro, e nada abre página nem clica sozinho');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && e.message); process.exit(1); });
