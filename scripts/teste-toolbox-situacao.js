'use strict';
/* 12/11 — TOOLBOX 2.1.17: a NF em "CONSULTAR SITUAÇÃO" destrava sozinha com o Bling aberto.
   Pedido do dono: "é só 1 clique e resolve… tinha que ajustar isso pra todas as empresas não ficarem com as NFs travadas".
   (Antes era um robô num computador dele; com o computador desligado, nada destravava.)
   Prova, com o navegador e o Bling de mentira:
   1) a LEITURA da resposta do Bling (a resposta REAL capturada em junho): acha o XML, o cStat e o motivo; reconhece a
      página de login; resposta sem o retorno não é "autorizada";
   2) a PÁGINA: nota com 100 (Autorizado) → consulta e GRAVA (updateSituacao com o XML em base64, 100, o motivo e 'S');
      nota com outra resposta → NÃO grava nada; sem login → para e não tenta as outras; endereço que não existe (404) →
      tenta o seguinte; sem a vez dada pelo fundo → não chama o Bling;
   3) o FUNDO: uma rodada por empresa a cada 10 min; uma aba por vez; sem chave não roda; servidor recusando a chave
      diz isso e NÃO conta como rodada; lista vazia = "nenhuma nota parada"; no máximo 10 por rodada; o prefixo de cada
      empresa; o resultado vira texto pra Central e volta pro servidor; empresa trocada no meio = resultado descartado;
   4) a fiação: o módulo roda nas páginas do Bling (a leitura antes da página), o fundo é carregado no Chrome e no
      Firefox, e NADA dele toca o Mercado Livre. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const dir = path.join(__dirname, '..', 'toolbox-extensao');
const ler = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const LIB = ler('situacao-nf.js'), CT = ler('ct-situacao.js'), BG = ler('bg-situacao.js');

const XML = '<retConsSitNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><tpAmb>1</tpAmb><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo><chNFe>35260627548456000147550010001173241473134710</chNFe><protNFe versao="4.00"><infProt><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe></retConsSitNFe>';
const envelope = (id, xml) => '<?xml version="1.0" encoding="utf-8" ?><xjx><cmd n="js"><![CDATA[callbackSituacao(' + id + ", '" + xml + "', '')]]></cmd></xjx>";
const LOGIN = '<html><head><title>Bling - Login</title></head><body><form action="/login">Entrar</form></body></html>';

(async () => {
  /* ── 1) a leitura ── */
  const w = { btoa: (s2) => Buffer.from(s2, 'binary').toString('base64'), unescape, encodeURIComponent, Date }; vm.runInNewContext(LIB, w); const L = w.tbSituacaoNF;
  let e = L.lerEnvelope(envelope('26047313471', XML));
  assert.ok(e.tipo === 'resposta' && e.cStat === '100' && e.xMotivo === 'Autorizado o uso da NF-e' && e.xml === XML, 'a resposta real do Bling tinha que ser lida: ' + JSON.stringify(e).slice(0, 200));
  assert.strictEqual(Buffer.from(L.base64(e.xml), 'base64').toString('utf8'), XML, 'o XML vai em base64, inteiro');
  assert.strictEqual(L.lerEnvelope(LOGIN).tipo, 'nao_logado');
  assert.strictEqual(L.lerEnvelope('<xjx><cmd n="al">Aguarde</cmd></xjx>').tipo, 'sem_callback', 'resposta sem o retorno da consulta não pode valer como autorizada');
  assert.strictEqual(L.lerEnvelope(envelope('1', XML.replace(/<cStat>100<\/cStat>/, '<cStat>217</cStat>'))).cStat, '217');
  const c = L.corpo('getEnvelopeSituacao', ['26047313471']);
  assert.ok(/^xajax=getEnvelopeSituacao&xajaxr=\d{13}&xajaxargs\[\]=26047313471$/.test(c), 'o corpo tem que ser o do Bling (o mesmo do clique): ' + c);
  /* Codex #848: HTTP 200 não basta — corpo vazio, JSON de erro, página de login e alerta de erro NÃO são "aceitou" */
  assert.ok(L.gravou(200, '<xjx></xjx>') && !L.gravou(500, '<xjx></xjx>') && !L.gravou(200, LOGIN) && !L.gravou(200, '') && !L.gravou(200, '{"errors":["x"]}') && !L.gravou(200, '<xjx><cmd n="al"><![CDATA[Erro ao gravar a situação]]></cmd></xjx>'));

  /* ── 2) a página ── */
  async function pagina(nfs, bling, vez) {
    const posts = [], msgs = [];
    const ctx = vm.createContext({ console, Date, Promise, String, Object, URLSearchParams, encodeURIComponent, unescape, btoa: (s2) => Buffer.from(s2, 'binary').toString('base64'),
      setTimeout: (f, ms) => { if (ms === 5000) ctx.__inicio = f; else setTimeout(f, 0); }, setInterval: () => 1,
      fetch: async (url, opt) => { posts.push({ url, corpo: opt.body, cred: opt.credentials, cab: opt.headers }); const r = bling(url, opt.body); return { status: r.status, text: async () => r.texto }; },
      chrome: { runtime: { lastError: null, sendMessage: (m, cb) => { msgs.push(m); cb(m.tipo === 'SITUACAO_PEDIR' ? (vez === false ? { rodar: false, motivo: 'cedo' } : { rodar: true, empresa: 'girassol', nfs }) : { ok: true }); }, onMessage: { addListener: () => {} } } } });
    ctx.window = ctx; ctx.top = ctx; ctx.window.top = ctx;
    vm.runInContext(LIB, ctx); vm.runInContext(CT, ctx);
    await ctx.__inicio(); await new Promise((ok) => setTimeout(ok, 60));
    const res = (msgs.find((m) => m.tipo === 'SITUACAO_RESULTADO') || {}).resultados || null;
    return { posts, msgs, res };
  }
  const arg = (corpo, i) => decodeURIComponent(corpo.split('&').filter((p) => p.startsWith('xajaxargs[]='))[i].slice('xajaxargs[]='.length));
  let x = await pagina([{ id: 27382560215, numero: '130431' }], (url, corpo) => (/f=getEnvelopeSituacao/.test(url) ? { status: 200, texto: envelope('27382560215', XML) } : { status: 200, texto: '<xjx></xjx>' }));
  assert.strictEqual(x.posts.length, 2, 'nota autorizada: consulta e grava (2 chamadas): ' + x.posts.map((p) => p.url).join());
  assert.ok(x.posts[0].url === '/services/notas.fiscais.server.php?f=getEnvelopeSituacao' && arg(x.posts[0].corpo, 0) === '27382560215' && x.posts[0].cred === 'include' && x.posts[0].cab['X-Requested-With'] === 'XMLHttpRequest', 'a consulta é a do clique, na sessão da página: ' + JSON.stringify(x.posts[0]).slice(0, 220));
  assert.ok(/f=updateSituacao$/.test(x.posts[1].url) && arg(x.posts[1].corpo, 0) === '27382560215' && Buffer.from(arg(x.posts[1].corpo, 1), 'base64').toString('utf8') === XML && arg(x.posts[1].corpo, 2) === '100' && arg(x.posts[1].corpo, 3) === 'Autorizado o uso da NF-e' && arg(x.posts[1].corpo, 4) === 'S', 'a gravação tem que levar a nota, o XML em base64, 100, o motivo e S');
  assert.ok(x.res.length === 1 && x.res[0].via === 'gravada' && x.res[0].numero === '130431', 'a página diz "gravada" (o Bling aceitou); quem confirma que destravou é o fundo');
  /* outra resposta da SEFAZ: NÃO grava */
  x = await pagina([{ id: 5, numero: '9' }], () => ({ status: 200, texto: envelope('5', XML.replace(/<cStat>100<\/cStat>/g, '<cStat>217</cStat>').replace(/Autorizado o uso da NF-e/g, 'Rejeicao: NF-e nao consta na base de dados da SEFAZ')) }));
  assert.ok(x.posts.length === 1 && x.res[0].via === 'nao_autorizada' && x.res[0].cStat === '217' && /nao consta/.test(x.res[0].xMotivo), 'sem o 100 da SEFAZ NADA pode ser gravado: ' + JSON.stringify(x.res));
  x = await pagina([{ id: 5 }], () => ({ status: 200, texto: '<xjx><cmd n="al">Aguarde</cmd></xjx>' }));
  assert.ok(x.posts.length === 1 && x.res[0].via === 'sem_resposta');
  /* sem login: para na primeira */
  x = await pagina([{ id: 1 }, { id: 2 }, { id: 3 }], () => ({ status: 200, texto: LOGIN }));
  assert.ok(x.posts.length === 1 && x.res.length === 1 && x.res[0].via === 'nao_logado', 'sem sessão no Bling não adianta tentar as outras notas');
  /* endereço que não existe nesta conta: tenta o seguinte */
  x = await pagina([{ id: 7 }], (url) => (/^\/services\//.test(url) ? { status: 404, texto: '' } : (/getEnvelope/.test(url) ? { status: 200, texto: envelope('7', XML) } : { status: 200, texto: '<xjx></xjx>' })));
  assert.ok(x.posts[0].url.startsWith('/services/') && x.posts[1].url === '/b/services/notas.fiscais.server.php?f=getEnvelopeSituacao' && x.res[0].via === 'gravada', 'com 404 no primeiro endereço tinha que tentar o seguinte: ' + x.posts.map((p) => p.url).join());
  /* a SEFAZ autorizou mas o Bling não gravou: não é "validada" */
  x = await pagina([{ id: 8 }], (url) => (/getEnvelope/.test(url) ? { status: 200, texto: envelope('8', XML) } : { status: 500, texto: 'erro' }));
  assert.ok(x.res[0].via === 'erro' && /não gravou/.test(x.res[0].erro));
  x = await pagina([{ id: 8 }], (url) => (/getEnvelope/.test(url) ? { status: 200, texto: envelope('8', XML) } : { status: 200, texto: '' }));
  assert.ok(x.res[0].via === 'erro', 'gravação com HTTP 200 e corpo vazio não é "gravada"');
  /* sem a vez: nem chama o Bling */
  x = await pagina([{ id: 1 }], () => ({ status: 200, texto: '' }), false);
  assert.ok(x.posts.length === 0 && x.res === null, 'sem a vez dada pelo fundo a página não chama o Bling');
  assert.ok(/if \(e\.cStat !== '100'\) return/.test(CT) && CT.indexOf("if (e.cStat !== '100') return") < CT.indexOf("xajax('updateSituacao'"), 'a gravação tem que vir DEPOIS da conferência do 100');

  /* ── 3) o fundo ── */
  function fundo(st, srv, agoraIni) {
    const chamadas = [], abasMsg = []; let ouv = null, agora = agoraIni || 1e12;
    const ctx = vm.createContext({ console, Promise, String, Object, Array, JSON, Set, encodeURIComponent, Date: { now: () => agora }, setTimeout: (fn) => setTimeout(fn, 0),
      fetch: async (url, opt) => { chamadas.push({ url, opt: opt || {} }); const r = srv(url, opt); return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.corpo }; },
      chrome: { runtime: { onMessage: { addListener: (f) => { ouv = f; } }, getManifest: () => ({ version: '2.1.17' }) },
        storage: { local: { get: async (ks) => { const r = {}; for (const k of ks) if (k in st) r[k] = st[k]; return r; }, set: async (v) => Object.assign(st, v), remove: async (k) => { for (const z of [].concat(k)) delete st[z]; } } },
        tabs: { query: async () => st.__abas || [], sendMessage: async (id, m) => { abasMsg.push([id, m.tipo]); return { ok: true }; } } } });
    vm.runInContext(BG, ctx);
    const msg = (m) => new Promise((ok) => { ouv(m, {}, ok); });
    return { st, chamadas, abasMsg, msg, anda: (ms) => { agora += ms; } };
  }
  const lista = (n) => () => ({ status: 200, corpo: { empresa: 'x', total: n, nfs: Array.from({ length: n }, (_, i) => ({ id: 100 + i, numero: String(500 + i), dataEmissao: '2026-11-11' })) } });
  let f = fundo({ tb_empresa: 'girassol', sceKey: 'K' }, lista(3));
  let r = await f.msg({ tipo: 'SITUACAO_PEDIR' });
  assert.ok(r.rodar && r.empresa === 'girassol' && r.nfs.length === 3 && f.chamadas[0].url === 'https://mover-pedidos-aguardando-x-atendido.onrender.com/robo/nfs-consultar-situacao?k=K', 'Girassol: a rota sem prefixo, com a chave: ' + JSON.stringify(f.chamadas[0]));
  r = await f.msg({ tipo: 'SITUACAO_PEDIR' }); assert.ok(!r.rodar && r.motivo === 'cedo' && f.chamadas.length === 1, 'outra aba pedindo logo depois: não roda de novo nem chama o servidor');
  f.anda(11 * 60000); r = await f.msg({ tipo: 'SITUACAO_PEDIR' });
  assert.ok(r.rodar && f.chamadas.length === 2, 'passados 10 min (e a vez da aba anterior vencida) roda de novo');
  f = fundo({ tb_empresa: 'amb', tbBlingKey: 'K2' }, lista(14)); r = await f.msg({ tipo: 'SITUACAO_PEDIR' });
  assert.ok(r.nfs.length === 10 && /\/amb\/robo\/nfs-consultar-situacao\?k=K2$/.test(f.chamadas[0].url), 'AMB: prefixo /amb e no máximo 10 por rodada');
  f = fundo({ tb_empresa: 'good', sceKey: 'K' }, lista(1)); await f.msg({ tipo: 'SITUACAO_PEDIR' }); assert.ok(/\/good\/robo\//.test(f.chamadas[0].url));
  /* uma aba por vez: com a vez tomada, a segunda não roda mesmo com `forcar` */
  f = fundo({ tb_empresa: 'good', sceKey: 'K' }, lista(2)); await f.msg({ tipo: 'SITUACAO_PEDIR' });
  r = await f.msg({ tipo: 'SITUACAO_PEDIR', forcar: true }); assert.ok(!r.rodar && r.motivo === 'outra_aba', 'duas abas não podem consultar a mesma nota ao mesmo tempo: ' + JSON.stringify(r));
  f = fundo({ tb_empresa: 'good' }, lista(2)); r = await f.msg({ tipo: 'SITUACAO_PEDIR' });
  assert.ok(!r.rodar && f.chamadas.length === 0 && f.st.sit_status.via === 'sem_chave', 'sem a chave não roda — e diz isso');
  f = fundo({ tb_empresa: 'good', sceKey: 'errada' }, () => ({ status: 404, corpo: { error: 'not found' } })); r = await f.msg({ tipo: 'SITUACAO_PEDIR' });
  assert.ok(!r.rodar && f.st.sit_status.via === 'chave_recusada' && !f.st.sit_ultima && !f.st.sit_vez, 'chave recusada: diz isso e NÃO conta como rodada (a próxima tenta de novo)');
  f = fundo({ tb_empresa: 'good', sceKey: 'K' }, lista(0)); r = await f.msg({ tipo: 'SITUACAO_PEDIR' });
  assert.ok(!r.rodar && f.st.sit_status.ok === true && f.st.sit_status.via === 'vazio' && !f.st.sit_vez);
  f = fundo({ sceKey: 'K' }, lista(2)); r = await f.msg({ tipo: 'SITUACAO_PEDIR' }); assert.ok(!r.rodar && r.motivo === 'sem_empresa' && f.chamadas.length === 0);
  /* Codex #848: a escolha RODA — com 14 paradas e as 10 primeiras sem destravar, a rodada seguinte começa pelas 4 que
     ainda não tiveram vez (e completa com as tentadas há mais tempo) */
  f = fundo({ tb_empresa: 'amb', sceKey: 'K' }, lista(14)); r = await f.msg({ tipo: 'SITUACAO_PEDIR' });
  assert.strictEqual(r.nfs.map((n2) => n2.id).join(), '100,101,102,103,104,105,106,107,108,109');
  await f.msg({ tipo: 'SITUACAO_RESULTADO', empresa: 'amb', resultados: r.nfs.map((n2) => ({ id: n2.id, numero: n2.numero, via: 'nao_autorizada', cStat: '217', xMotivo: 'x' })) });
  f.anda(11 * 60000); r = await f.msg({ tipo: 'SITUACAO_PEDIR' });
  assert.strictEqual(r.nfs.slice(0, 4).map((n2) => n2.id).join(), '110,111,112,113', 'as notas que ficaram fora da 1ª rodada tinham que vir PRIMEIRO na 2ª: ' + r.nfs.map((n2) => n2.id).join());
  assert.strictEqual(r.nfs.length, 10);
  /* o resultado: texto pra Central e a volta pro servidor. Codex #848: "gravada" só vira "destravada" depois de CONFIRMAR
     na lista do servidor que a nota saiu de "Consultar situação" */
  const srvConf = (aindaParadas) => (url, opt) => (opt && opt.method === 'POST' ? { status: 200, corpo: { ok: true } } : { status: 200, corpo: { nfs: aindaParadas.map((id) => ({ id })) } });
  f = fundo({ tb_empresa: 'girassol', sceKey: 'K', sit_vez: 1 }, srvConf([2, 3]));
  await f.msg({ tipo: 'SITUACAO_RESULTADO', empresa: 'girassol', resultados: [{ id: 1, numero: '130431', via: 'gravada', cStat: '100' }, { id: 2, numero: '130428', via: 'nao_autorizada', cStat: '217', xMotivo: 'Rejeicao: nao consta' }, { id: 3, numero: '130432', via: 'gravada', cStat: '100' }] });
  assert.ok(f.st.sit_status.via === 'pendente' && f.st.sit_status.validadas === 1 && f.st.sit_status.pendentes === 2 && /1 nota\(s\) destravada/.test(f.st.sit_status.msg) && /NF 130428: a SEFAZ respondeu 217/.test(f.st.sit_status.msg) && /NF 130432: o Bling aceitou a gravação, mas a nota continua/.test(f.st.sit_status.msg) && !f.st.sit_vez, 'a nota gravada que CONTINUA na lista não pode contar como destravada: ' + JSON.stringify(f.st.sit_status));
  const post = f.chamadas.find((c2) => c2.opt.method === 'POST');
  assert.ok(/\/robo\/nfs-consultar-situacao\/resultado\?k=K$/.test(post.url) && JSON.parse(post.opt.body).origem === 'toolbox' && JSON.parse(post.opt.body).resultados.map((x2) => x2.via).join() === 'validada,nao_autorizada,nao_confirmada', 'o resultado JÁ CONFIRMADO tem que voltar pro servidor (é ele que avisa no checkout): ' + post.opt.body);
  assert.ok(f.chamadas.findIndex((c2) => !c2.opt.method) < f.chamadas.findIndex((c2) => c2.opt.method === 'POST'), 'a confirmação (reler a lista) vem antes de reportar');
  f = fundo({ tb_empresa: 'girassol', sceKey: 'K' }, srvConf([]));
  await f.msg({ tipo: 'SITUACAO_RESULTADO', empresa: 'girassol', resultados: [{ id: 1, numero: '1', via: 'gravada' }, { id: 2, numero: '2', via: 'gravada' }] });
  assert.ok(f.st.sit_status.ok === true && f.st.sit_status.via === 'validadas' && /2 nota\(s\) destravada/.test(f.st.sit_status.msg));
  /* sem conseguir reler a lista: não afirma que destravou */
  f = fundo({ tb_empresa: 'girassol', sceKey: 'K' }, (url, opt) => (opt && opt.method === 'POST' ? { status: 200, corpo: {} } : { status: 502, corpo: {} }));
  await f.msg({ tipo: 'SITUACAO_RESULTADO', empresa: 'girassol', resultados: [{ id: 1, numero: '1', via: 'gravada' }] });
  assert.ok(f.st.sit_status.via === 'pendente' && f.st.sit_status.validadas === 0 && /não deu pra confirmar/.test(f.st.sit_status.msg), 'sem a confirmação não pode dizer "destravada": ' + JSON.stringify(f.st.sit_status));
  f = fundo({ tb_empresa: 'amb', sceKey: 'K' }, () => ({ status: 200, corpo: {} }));
  await f.msg({ tipo: 'SITUACAO_RESULTADO', empresa: 'girassol', resultados: [{ id: 1, via: 'gravada' }] });
  assert.ok(f.st.sit_status.via === 'empresa_mudou' && f.chamadas.length === 0, 'resultado de outra empresa (trocada no meio) não vai pro servidor');
  /* a Central pedindo AGORA: libera o intervalo e chama a aba do Bling */
  f = fundo({ tb_empresa: 'good', sceKey: 'K', sit_ultima: { empresa: 'good', quando: 1e12 }, __abas: [{ id: 9 }] }, lista(1));
  r = await f.msg({ tipo: 'SITUACAO_AGORA' });
  assert.ok(r.abas === 1 && r.chamou === 1 && f.abasMsg[0][0] === 9 && f.abasMsg[0][1] === 'SITUACAO_RODAR' && !f.st.sit_ultima);
  /* Codex #848: com uma rodada EM ANDAMENTO (a vez tomada), o "agora" não tira a vez nem chama outra aba */
  f = fundo({ tb_empresa: 'good', sceKey: 'K', sit_ultima: { empresa: 'good', quando: 1e12 }, sit_vez: 1e12 - 1000, __abas: [{ id: 9 }, { id: 10 }] }, lista(1));
  r = await f.msg({ tipo: 'SITUACAO_AGORA' });
  assert.ok(r.ocupado === true && r.chamou === 0 && f.abasMsg.length === 0 && f.st.sit_vez === 1e12 - 1000, 'pedir uma rodada no meio de outra não pode soltar a vez de quem está rodando: ' + JSON.stringify([r, f.st.sit_vez]));
  r = await f.msg({ tipo: 'SITUACAO_PEDIR', forcar: true }); assert.ok(!r.rodar && r.motivo === 'outra_aba');
  f = fundo({ tb_empresa: 'good', sceKey: 'K' }, lista(1)); r = await f.msg({ tipo: 'SITUACAO_AGORA' }); assert.ok(r.abas === 0 && r.chamou === 0);

  /* ── 4) a fiação ── */
  const man = JSON.parse(ler('manifest.json'));
  const bl = man.content_scripts.find((c2) => c2.matches.length === 1 && c2.matches[0] === 'https://www.bling.com.br/*');
  assert.ok(bl.js.indexOf('situacao-nf.js') !== -1 && bl.js.indexOf('situacao-nf.js') < bl.js.indexOf('ct-situacao.js'), 'nas páginas do Bling: a leitura antes da página');
  assert.ok(man.background.scripts.indexOf('bg-situacao.js') !== -1 && /importScripts\([^)]*'bg-situacao\.js'/.test(ler('bg-toolbox.js')), 'o fundo tem que ser carregado no Firefox (scripts) e no Chrome/Edge (importScripts)');
  for (const c2 of man.content_scripts) if (c2.matches.some((m) => /mercadoli/.test(m))) assert.ok(c2.js.indexOf('ct-situacao.js') === -1 && c2.js.indexOf('situacao-nf.js') === -1, 'o módulo não pode rodar em página do Mercado Livre');
  for (const src of [LIB, CT, BG]) assert.ok(!/mercadoli/i.test(src), 'nada do módulo toca o Mercado Livre');
  const T = (() => { const cx = vm.createContext({ chrome: {}, setTimeout, clearTimeout, console, Date, Math, JSON, Map, Promise, encodeURIComponent, Object, Array, String }); cx.self = cx; vm.runInContext(ler('tb-acoes.js'), cx); return cx.tbAcoes; })();
  for (const emp of ['girassol', 'good', 'amb']) assert.ok(T.itensDa(emp).some((i) => i.id === 'situacao'), 'a Central mostra o módulo nas três empresas');
  assert.strictEqual(T.lerStatusSituacao({ via: 'vazio' }).estado, 'ok');
  assert.strictEqual(T.lerStatusSituacao({ via: 'validadas', msg: '2 nota(s) destravada(s)' }).estado, 'ok');
  assert.strictEqual(T.lerStatusSituacao({ via: 'pendente', msg: 'x' }).estado, 'pendente');
  assert.strictEqual(T.lerStatusSituacao({ via: 'nao_logado', msg: 'x' }).estado, 'login');
  assert.strictEqual(T.lerStatusSituacao({ via: 'chave_recusada', msg: 'x' }).estado, 'chave');
  assert.strictEqual(T.lerStatusSituacao({ via: 'servidor', msg: 'x' }).estado, 'erro');
  assert.strictEqual(T.lerStatusSituacao(null).estado, 'pendente');
  console.log('ok — Toolbox: NF em "Consultar situação" destrava sozinha com o Bling aberto — só grava com o 100 (Autorizado) da SEFAZ, uma rodada por empresa a cada 10 min, e o que não destrava volta pro servidor');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && e.message); process.exit(1); });
