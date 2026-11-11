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
  x = montar({ local: { tbBlingKey: 'K2' }, cookies: cb, respostas: () => ({ status: 200, corpo: { ok: true, caracteres: 13, tem_phpsessid: true } }) }); r = await x.T.ACOES.bling('amb');
  assert.ok(r.estado === 'ok' && /empresa=amb&k=K2$/.test(x.chamadas[0].url) && /cookie: PHPSESSID=abc\nuser-agent: UA-teste/.test(JSON.parse(x.chamadas[0].opt.body).texto), 'Bling: empresa e formato certos: ' + JSON.stringify(x.chamadas[0]));
  x = montar({ local: { sceKey: 'K' }, cookies: cb, respostas: () => ({ status: 200, corpo: { ok: true, caracteres: 5, tem_phpsessid: false } }) }); r = await x.T.ACOES.bling('good');
  assert.ok(r.estado === 'login' && /PHPSESSID/.test(r.msg), 'cookie sem a sessão: pede o login de novo');

  /* ── Respostas Rápidas ── */
  x = montar(); r = await x.T.ACOES.respostas('good'); assert.strictEqual(r.estado, 'chave');
  x = montar({ sync: { apiKey: 'R', apiUrl: 'https://srv/' }, respostas: () => ({ status: 200, corpo: { respostas: [1, 2, 3] } }) }); r = await x.T.ACOES.respostas('good');
  assert.ok(r.estado === 'ok' && /3 respostas para gimpo/.test(r.msg) && x.chamadas[0].url === 'https://srv/respostas-rapidas/api/respostas?loja=gimpo' && x.chamadas[0].opt.headers['X-API-Key'] === 'R', 'Respostas: loja da empresa e a chave: ' + JSON.stringify(x.chamadas[0]));
  x = montar({ sync: { apiKey: 'R' }, respostas: () => ({ status: 401, corpo: {} }) }); r = await x.T.ACOES.respostas('amb'); assert.strictEqual(r.estado, 'chave');

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
  x = montar({ local: { syncKey: 'M' }, abasMM: [{ id: 7 }] }); r = await x.T.ACOES.mm('good', { esperaMs: 60 });
  assert.ok(r.estado === 'erro' && /não terminou/.test(r.msg), 'Madeira que não responde: erro com o que conferir');

  /* ── código da coleta: só o estado, da empresa desta instalação ── */
  x = montar(); r = await x.T.ACOES.coleta('amb'); assert.strictEqual(r.estado, 'chave');
  x = montar({ local: { coleta_key: 'T', coleta_ok: { empresa: 'good', dia: '2026-11-10' } } }); r = await x.T.ACOES.coleta('amb');
  assert.ok(r.estado === 'info' && /nenhum ainda/.test(r.msg) && x.chamadas.length === 0 && x.msgs.length === 0, 'coleta: o "já entregue" de OUTRA empresa não conta — e nada é reenviado');
  r = await x.T.ACOES.coleta('good'); assert.ok(/10\/11\/2026/.test(r.msg));

  /* ── atualizar tudo ── */
  const passos = [];
  const falsas = { shopee: async () => ({ estado: 'ok', msg: 'a' }), bling: async () => { throw new Error('quebrou'); }, respostas: async () => ({ estado: 'chave', msg: 'c' }), fragil: async () => null, coleta: async () => ({ estado: 'info', msg: 'e' }) };
  x = montar(); const saida = await x.T.atualizarTudo('amb', (id, e) => passos.push(id + ':' + e.estado), falsas);
  assert.strictEqual(saida.map((s) => s.id + ':' + s.estado).join(), 'shopee:ok,bling:erro,respostas:chave,fragil:erro,coleta:info', 'uma ação que quebra (ou não responde) não derruba as outras: ' + JSON.stringify(saida));
  assert.strictEqual(passos.join(), 'shopee:rodando,shopee:ok,bling:rodando,bling:erro,respostas:rodando,respostas:chave,fragil:rodando,fragil:erro,coleta:rodando,coleta:info', 'a tela é avisada antes e depois de cada módulo, na ordem');

  /* ── as chaves num lugar só ── */
  x = montar({ sync: { apiUrl: 'https://ja-tinha' } }); await x.T.gravarChaves({ admin: ' ADM ', toolbox: 'TB', mm: 'MM', respostas: 'RR' }, 'amb');
  assert.ok(x.st.sceKey === 'ADM' && x.st.tbBlingKey === 'ADM' && x.st.coleta_key === 'TB' && x.st.syncKey === 'MM' && x.sy.apiKey === 'RR' && x.sy.apiUrl === 'https://ja-tinha' && x.sy.loja === 'ambtotal', 'cada módulo tem que continuar achando a chave DELE: ' + JSON.stringify([x.st, x.sy]));
  x = montar(); await x.T.gravarChaves({ respostas: 'RR' }, 'good'); assert.ok(x.sy.apiUrl === x.T.HOST && x.sy.loja === 'gimpo', 'Respostas em instalação nova: servidor padrão e a loja da empresa');
  const c = await montar({ local: { tbBlingKey: 'B', coleta_key: 'T' } }).T.lerChaves(); assert.ok(c.admin === 'B' && c.toolbox === 'T', 'a Central mostra a chave que algum módulo já tinha');

  /* ── sem automação, e a Central no menu ── */
  assert.ok(!/tabs\.create|\.click\(|alarms\./.test(SRC), 'a peça de ações não pode abrir aba, clicar nem agendar nada');
  const central = fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'central.js'), 'utf8');
  assert.ok((central.match(/confirm\(/g) || []).length === 2 && /Os sites abertos neste navegador[^']*estão logados nas contas da /.test(central), 'a Central confirma UMA vez (no "tudo") de quem são as contas logadas — e outra só na troca de empresa');
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
