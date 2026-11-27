'use strict';
/* 27/11 — TOOLBOX 2.1.23: OS IDS FISCAIS FICAM GUARDADOS NO NAVEGADOR (pedido do dono: "dá um jeito de não precisar logar lá").
   Caso real: no checkout da Girassol, "Gerar devolução (Toolbox)" parou em 'Nao consegui os IDs fiscais da empresa
   "girassol": sessao invalida ou expirada' — a ponte busca natureza de operação e empresa no servidor do Devoluções, que
   só responde com login no painel dele; no checkout ninguém está logado lá.

   Aqui o bg-devolucoes.js REAL roda num `chrome` simulado. O que se prova:
   A. resposta boa do servidor é guardada (por empresa) — e segue sendo a que vale enquanto ele responde;
   B. sem login (ou servidor fora), vale a guardada: a nota sai com os ids da empresa certa, sem pedir login;
   C. nunca guardou → recusa como antes (não emite), dizendo o que fazer; a GOOD segue com o padrão dela;
   D. guardada torta, de outra empresa, velha demais (180 dias) ou do futuro não vale;
   E. o painel do Devoluções aberto renova a guardada da empresa DELE (e só dela; sem login não estraga a que existe). */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const raiz = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'bg-devolucoes.js'), 'utf8');
const HOST = 'https://good-devolucoes-x-marketplaces-x-nfsbling.onrender.com';
const IDS = { good: { idEmpresaControl: '4956030980', idNaturezaOperacao: '5776118802' }, girassol: { idEmpresaControl: '933846821', idNaturezaOperacao: '1044537822' }, ambtotal: { idEmpresaControl: '14901993834', idNaturezaOperacao: '15110128838' } };
const DIA = 864e5;

function montar(op) {
  op = op || {};
  const o = { fetch: [], exec: [], avisos: [] };
  const storage = Object.assign({}, op.storage || {});
  const listeners = [];
  const cx = { o, storage, agora: op.agora || Date.parse('2026-11-27T12:00:00Z'), servidor: op.servidor || ((emp) => ({ ok: true, ...IDS[emp] })), storageQuebra: false };
  const DataFalsa = class extends Date { static now() { return cx.agora; } };
  const chrome = {
    runtime: { onMessage: { addListener: (fn) => listeners.push(fn) }, onInstalled: { addListener() {} }, sendMessage: async () => ({}), id: 'ext', getManifest: () => ({ version: 'teste' }) },
    webRequest: { onSendHeaders: { addListener() {} }, onBeforeSendHeaders: { addListener() {} } },
    storage: { session: { get: async () => ({}), set: async () => {} },
      local: { get: async (k) => { if (cx.storageQuebra) throw new Error('storage'); const ks = Array.isArray(k) ? k : [k]; const r = {}; for (const x of ks) r[x] = storage[x]; return r; },
        set: async (v) => { if (cx.storageQuebra) throw new Error('storage'); Object.assign(storage, JSON.parse(JSON.stringify(v))); } } },
    tabs: { query: async () => [{ id: 7, url: 'https://www.bling.com.br/notas.php', windowId: 1 }], update: async () => {}, get: async () => ({ id: 7 }) },
    windows: { update: async () => {} },
    scripting: { executeScript: async (opts) => { const arg = opts.args[0]; o.exec.push(arg);
      setTimeout(() => { for (const l of listeners) l({ tipo: 'BLING_DEVOLUCAO_RESULTADO_PAGINA', execId: arg.execId, ok: true, resultado: { idNotaDevolucao: '555', numero: '127999', emitida: true } }, {}, () => {}); }, 5);
      return [{ result: null }]; } },
  };
  const ctx = { chrome, console: { log() {}, warn: (...a) => o.avisos.push(a.join(' ')), error() {} }, Date: DataFalsa, String, Number, JSON, Promise, Map, Set, Math, Array, Object, Error, URL, setTimeout: (fn, ms) => setTimeout(fn, (ms >= 100 && ms <= 20000) ? 3 : ms) /* as esperas curtas da ponte (acordar a aba…) não interessam aqui; os relógios de segurança (100 s) ficam como são */, clearTimeout, encodeURIComponent,
    fetch: async (url, opts) => {
      const u = String(url); o.fetch.push(((opts && opts.method) || 'GET') + ' ' + u.replace(HOST, ''));
      assert.ok(u.indexOf(HOST) === 0, 'a ponte foi a outro servidor: ' + u);
      if (/ids-fiscais/.test(u)) { assert.strictEqual(opts.credentials, 'include'); const emp = /\/girassol\//.test(u) ? 'girassol' : /\/amb\//.test(u) ? 'ambtotal' : 'good'; const r = cx.servidor(emp); if (r === 'ESTOURA') throw new Error('rede'); return { ok: true, json: async () => { if (r === 'TORTO') throw new Error('json'); return r; } }; }
      return { ok: true, status: 200, json: async () => ({}) };
    } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'tb-empresas.js'), 'utf8'), ctx); vm.runInContext(SRC, ctx);
  cx.mensagem = (msg, url) => new Promise((resolve) => { for (const l of listeners) { if (l(msg, { tab: { id: 1, url: url || 'https://mover-pedidos-aguardando-x-atendido.onrender.com/girassol-backup-offline/painel' } }, resolve) === true) return; } resolve(null); });
  cx.gerar = (empresa) => cx.mensagem({ tipo: 'BLING_DEVOLUCAO_CRIAR', payload: Object.assign({ idNFOriginal: '1', emitir: true }, empresa ? { empresa } : {}) });
  cx.fixos = () => (o.exec.length ? JSON.parse(JSON.stringify(o.exec[o.exec.length - 1].fixos)) : null);
  cx.tique = () => new Promise((r) => setTimeout(r, 15));
  return cx;
}
const SEM_LOGIN = () => ({ ok: false, erro: 'sessao invalida ou expirada' });
const G = (emp, extra) => ({ ['ids_fiscais_' + emp]: Object.assign({ quando: Date.parse('2026-11-20T12:00:00Z'), idNaturezaOperacao: IDS[emp].idNaturezaOperacao, idEmpresaControl: IDS[emp].idEmpresaControl }, extra || {}) });

(async () => {
  for (const emp of ['girassol', 'ambtotal', 'good']) {
    /* ═══ A. resposta boa é guardada, por empresa ═══ */
    let t = montar();
    let r = await t.gerar(emp);
    assert.strictEqual(r && r.ok, true, emp + ': com o servidor respondendo, a nota sai');
    assert.deepStrictEqual([t.fixos(), t.storage['ids_fiscais_' + emp], Object.keys(t.storage).filter((k) => /^ids_fiscais_/.test(k))], [IDS[emp], { quando: t.agora, idNaturezaOperacao: IDS[emp].idNaturezaOperacao, idEmpresaControl: IDS[emp].idEmpresaControl }, ['ids_fiscais_' + emp]], emp + ': guardou os ids que o servidor deu, só os desta empresa');
    /* o servidor mudou os números: vale o que ele manda AGORA, e a guardada acompanha */
    t = montar({ storage: G(emp), servidor: () => ({ ok: true, idNaturezaOperacao: '70000001', idEmpresaControl: '80000002' }) });
    r = await t.gerar(emp);
    assert.deepStrictEqual([r.ok, t.fixos(), t.storage['ids_fiscais_' + emp].idNaturezaOperacao, t.storage['ids_fiscais_' + emp].quando], [true, { idNaturezaOperacao: '70000001', idEmpresaControl: '80000002' }, '70000001', t.agora], emp + ': com login, o servidor manda e renova');
    /* guardar falhou (storage): a nota de agora sai do mesmo jeito */
    t = montar(); t.storageQuebra = true; r = await t.gerar(emp); assert.deepStrictEqual([r.ok, t.fixos()], [true, IDS[emp]], emp + ': storage quebrado não impede a nota');
    /* resposta boa com número que não tem cara de id: usa (como sempre), mas NÃO guarda */
    t = montar({ servidor: () => ({ ok: true, idNaturezaOperacao: 'abc', idEmpresaControl: '80000002' }) }); await t.gerar(emp);
    assert.strictEqual(t.storage['ids_fiscais_' + emp], undefined, emp + ': lixo não é guardado');

    /* ═══ B. sem login: vale a guardada ═══ */
    for (const resp of [SEM_LOGIN(), 'ESTOURA', 'TORTO', null, { ok: true }, { ok: true, idNaturezaOperacao: '1' }]) {
      t = montar({ storage: G(emp), servidor: () => resp });
      r = await t.gerar(emp);
      assert.deepStrictEqual([r && r.ok, t.fixos(), t.o.fetch.filter((u) => /ids-fiscais/.test(u)).length], [true, IDS[emp], 1], emp + ': sem resposta boa (' + JSON.stringify(resp) + '), a nota sai com os ids guardados: ' + JSON.stringify(r));
      assert.ok(t.o.avisos.some((a) => /usando os guardados da ultima resposta boa/.test(a)), emp + ': fica dito no console');
      assert.strictEqual(t.storage['ids_fiscais_' + emp].quando, Date.parse('2026-11-20T12:00:00Z'), emp + ': usar a guardada não a rejuvenesce');
    }
  }

  /* ═══ C. nunca guardou ═══ */
  for (const emp of ['girassol', 'ambtotal']) {
    const t = montar({ servidor: SEM_LOGIN });
    const r = await t.gerar(emp);
    assert.deepStrictEqual([r.ok, t.o.exec.length], [false, 0], emp + ': sem ids, nada é emitido');
    assert.ok(new RegExp('Nao consegui os IDs fiscais da empresa "' + emp + '": sessao invalida ou expirada\\. Sem eles a nota sairia na empresa ou natureza erradas — nao emiti nada\\. Entre UMA vez no painel do Devolucoes desta empresa neste navegador: a extensao guarda os dados e nao pede de novo\\.').test(r.erro), emp + ': ' + r.erro);
  }
  { const t = montar({ servidor: SEM_LOGIN }); const r = await t.gerar('good'); assert.deepStrictEqual([r.ok, t.fixos()], [true, IDS.good], 'a GOOD, sem guardada, segue com o padrão dela'); }
  { const t = montar({ servidor: SEM_LOGIN, storage: { ids_fiscais_good: { quando: Date.parse('2026-11-20T12:00:00Z'), idNaturezaOperacao: '11112222', idEmpresaControl: '33334444' } } }); const r = await t.gerar('good');
    assert.deepStrictEqual([r.ok, t.fixos()], [true, { idNaturezaOperacao: '11112222', idEmpresaControl: '33334444' }], 'a GOOD com guardada usa a guardada (o que o servidor disse por último), não o número cravado'); }

  /* ═══ D. guardada que NÃO vale ═══ */
  const ruins = [['de outra empresa', G('ambtotal')], ['natureza torta', G('girassol', { idNaturezaOperacao: '12a4' })], ['empresa vazia', G('girassol', { idEmpresaControl: '' })], ['número em vez de texto', G('girassol', { idEmpresaControl: 933846821 })],
    ['curta demais', G('girassol', { idNaturezaOperacao: '123' })], ['com 180 dias', G('girassol', { quando: Date.parse('2026-11-27T12:00:00Z') - 180 * DIA })], ['do futuro', G('girassol', { quando: Date.parse('2026-11-27T12:00:01Z') })],
    ['sem data', G('girassol', { quando: undefined })], ['data torta', G('girassol', { quando: 'ontem' })], ['não é objeto', { ids_fiscais_girassol: 'x' }], ['nula', { ids_fiscais_girassol: null }]];
  for (const [nome, st] of ruins) { const t = montar({ servidor: SEM_LOGIN, storage: st }); const r = await t.gerar('girassol'); assert.deepStrictEqual([r.ok, t.o.exec.length], [false, 0], 'guardada ' + nome + ' não vale: ' + JSON.stringify(r)); }
  { const t = montar({ servidor: SEM_LOGIN, storage: G('girassol', { quando: Date.parse('2026-11-27T12:00:00Z') - 180 * DIA + 1000 }) }); assert.strictEqual((await t.gerar('girassol')).ok, true, 'com 179 dias e 23h59 ainda vale'); }
  { const t = montar({ servidor: SEM_LOGIN, storage: G('girassol') }); t.storageQuebra = true; const r = await t.gerar('girassol'); assert.deepStrictEqual([r.ok, t.o.exec.length], [false, 0], 'storage que não lê = sem guardada = não emite'); }

  /* ═══ E. o painel do Devoluções aberto renova a guardada da empresa dele ═══ */
  for (const [url, emp] of [[HOST + '/girassol/', 'girassol'], [HOST + '/girassol', 'girassol'], [HOST + '/girassol/admin?x=1', 'girassol'], [HOST + '/amb/', 'ambtotal'], [HOST + '/', 'good'], [HOST + '/admin', 'good'], [HOST + '/girassolx/', 'good'], [HOST + '/ambiente', 'good']]) {
    const t = montar();
    const r = await t.mensagem({ tipo: 'BLING_FALHAS_REGISTRO' }, url); await t.tique();
    assert.deepStrictEqual([r && r.ok, t.o.fetch, Object.keys(t.storage).filter((k) => /^ids_fiscais_/.test(k)), t.storage['ids_fiscais_' + emp] && t.storage['ids_fiscais_' + emp].idEmpresaControl],
      [true, ['GET ' + (emp === 'good' ? '/api/ids-fiscais?empresa=good' : (emp === 'girassol' ? '/girassol' : '/amb') + '/api/ids-fiscais')], ['ids_fiscais_' + emp], IDS[emp].idEmpresaControl], url + ' → renova ' + emp);
    /* de novo logo em seguida: não volta ao servidor (10 min); e depois de aquecida, gerar sem login funciona */
    await t.mensagem({ tipo: 'BLING_FALHAS_REGISTRO' }, url); await t.tique(); assert.strictEqual(t.o.fetch.length, 1, url + ': uma ida a cada 10 min');
    t.agora += 11 * 60000; t.servidor = SEM_LOGIN;
    const g = await t.gerar(emp); assert.deepStrictEqual([g.ok, t.fixos()], [true, IDS[emp]], url + ': aquecida pelo painel, a nota sai sem login');
  }
  /* página que não é do Devoluções (o checkout, o Bling, endereço torto): não renova nada */
  for (const url of ['https://mover-pedidos-aguardando-x-atendido.onrender.com/girassol-backup-offline/painel', 'https://www.bling.com.br/girassol/', HOST + '.evil.com/girassol/', 'nada', '', undefined]) {
    const t = montar(); const fs0 = [];
    for (const l of [0]) { void l; }
    const r = await new Promise((resolve) => { t.mensagem({ tipo: 'BLING_FALHAS_REGISTRO' }, url === undefined ? 'x://' : url).then(resolve); }); await t.tique();
    assert.deepStrictEqual([r && r.ok, t.o.fetch, fs0], [true, [], []], 'não renova a partir de ' + url);
  }
  /* painel aberto SEM login: a guardada que existe fica como está */
  { const t = montar({ servidor: SEM_LOGIN, storage: G('girassol') }); await t.mensagem({ tipo: 'BLING_FALHAS_REGISTRO' }, HOST + '/girassol/'); await t.tique();
    assert.deepStrictEqual([t.o.fetch.length, t.storage.ids_fiscais_girassol], [1, G('girassol').ids_fiscais_girassol]); }
  { const t = montar({ servidor: () => 'ESTOURA' }); const r = await t.mensagem({ tipo: 'BLING_FALHAS_REGISTRO' }, HOST + '/girassol/'); await t.tique(); assert.strictEqual(r.ok, true, 'servidor fora não derruba a resposta ao painel'); }

  /* ═══ F. o CHECKOUT manda os ids no pedido (payload.idsFiscais): a nota sai sem ir ao Devoluções ═══ */
  for (const emp of ['girassol', 'ambtotal', 'good']) {
    const DO_PEDIDO = { idNaturezaOperacao: '33334444', idEmpresaControl: '11112222' };
    const t = montar({ servidor: SEM_LOGIN });
    let r = await t.mensagem({ tipo: 'BLING_DEVOLUCAO_CRIAR', payload: { idNFOriginal: '1', emitir: true, empresa: emp, idsFiscais: Object.assign({ lixo: 'x' }, DO_PEDIDO) } });
    assert.deepStrictEqual([r && r.ok, t.fixos(), t.o.fetch.filter((u) => /ids-fiscais/.test(u)).length, Object.keys(t.storage).filter((k) => /^ids_fiscais_/.test(k))], [true, DO_PEDIDO, 0, []], emp + ': com os ids no pedido, nem pergunta ao Devoluções (e não guarda o que não veio dele)');
    /* par incompleto ou torto no pedido: ignorado — segue o caminho de sempre (aqui: servidor respondendo) */
    for (const ruim of [{ idNaturezaOperacao: '33334444' }, { idEmpresaControl: '11112222' }, { idNaturezaOperacao: '3333,4444', idEmpresaControl: '11112222' }, { idNaturezaOperacao: 33334444, idEmpresaControl: '11112222' }, { idNaturezaOperacao: '33334444', idEmpresaControl: '' }, 'x', null, [], {}]) {
      const t2 = montar();
      r = await t2.mensagem({ tipo: 'BLING_DEVOLUCAO_CRIAR', payload: { idNFOriginal: '1', emitir: true, empresa: emp, idsFiscais: ruim } });
      assert.deepStrictEqual([r && r.ok, t2.fixos(), t2.o.fetch.filter((u) => /ids-fiscais/.test(u)).length], [true, IDS[emp], 1], emp + ': ids tortos no pedido (' + JSON.stringify(ruim) + ') são ignorados');
    }
  }
  /* torto no pedido E sem login E sem guardada: não emite (não usa o torto) */
  { const t = montar({ servidor: SEM_LOGIN }); const r = await t.mensagem({ tipo: 'BLING_DEVOLUCAO_CRIAR', payload: { idNFOriginal: '1', emitir: true, empresa: 'girassol', idsFiscais: { idNaturezaOperacao: 'abc', idEmpresaControl: '11112222' } } }); assert.deepStrictEqual([r.ok, t.o.exec.length], [false, 0]); }

  /* a versão sobe (o dono confere no menu da extensão se a atualização pegou) */
  const ver = JSON.parse(fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'manifest.json'), 'utf8')).version.split('.').map(Number);
  assert.ok(ver[0] > 2 || (ver[0] === 2 && (ver[1] > 1 || (ver[1] === 1 && ver[2] >= 23))), 'a Toolbox com os ids guardados é a 2.1.23 ou mais nova');
  console.log('OK: Toolbox — ids fiscais guardados no navegador: resposta boa do servidor é guardada por empresa; sem login vale a guardada (até 180 dias); nunca guardou = não emite; o painel do Devoluções aberto renova; e os ids que o checkout manda no pedido dispensam o Devoluções');
  process.exit(0);   /* a ponte deixa relógios de segurança armados (100 s por nota); o teste já viu o que precisava */
})().catch((e) => { console.error('FALHOU:', e && e.stack || e); process.exit(1); });
