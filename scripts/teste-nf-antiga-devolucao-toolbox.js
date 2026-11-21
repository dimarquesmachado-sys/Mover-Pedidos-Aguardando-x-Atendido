'use strict';
/* 21/11 — A NF ANTIGA DO CONSERTO: "GERAR DEVOLUÇÃO" PELO BOTÃO, VIA TOOLBOX (o "jeito 1" que o dono escolheu: "Faz o 1
   agora"). O aviso das notas antigas (#960) ganha, na nota que passou das 24 h, o botão que manda a Toolbox gerar e emitir
   a NF de devolução pela tela do Bling — a mesma ponte do app de Devoluções (GOOD_BRIDGE_CRIAR_DEVOLUCAO).

   Prova (o código de produção):
   A. a ROTA (as três empresas): ?preparar= só pra nota pendente, passada das 24 h, a mesma nota, não cancelada — e dá o id
      da loja; uma leitura no Bling por clique; ?resolver= anota o id e o número da devolução (só dígitos, só na devolvida);
   B. o PAINEL (o trecho de verdade, com uma ponte de mentira): o botão só na nota de devolução; sem Toolbox avisa; o que
      vai pra ponte; cada resposta da Toolbox (ok, JA_EXISTE, RASCUNHO_CRIADO, TIMEOUT, NAO_LOGADO, FALHA) e o que faz com a
      lista; resposta de outra requisição não confunde; dois cliques não geram duas;
   C. a TOOLBOX 2.1.22: a ponte roda nas páginas do checkout das empresas da ficha (e só nelas), repassa ao fundo o pedido
      inteiro e devolve a resposta com o código estável; o fundo lê os campos que o checkout manda. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const raiz = path.join(__dirname, '..');
const PASTAS = fs.mkdtempSync(path.join(os.tmpdir(), 'nfa-dev-'));
const pasta = () => fs.mkdtempSync(path.join(PASTAS, 'c-'));
global.fetch = async () => { throw new Error('rede bloqueada no teste'); };
/* promessa que nunca resolve esvazia o laço e o node sairia com 0 SEM ter chegado ao fim: só o fim diz que passou */
process.exitCode = 1;
process.env.ADMIN_KEY = 'chave-dev';
const Reg = require('../lib/fiscal/nf-conserto-registro');
const CE = require('../lib/checkout/config-empresa');
const A = require('../lib/checkout/rota-nf-conserto-antigas');
const AGORA = Date.parse('2026-11-21T15:00:00-03:00');
function conserto(dir, id, op) {
  op = op || {};
  Reg.abrir(dir, id, { numero: op.numero || ('N' + id), pedido_ml: '2000' + id, teste: !!op.teste, emitida_em: op.emitida === undefined ? '2026-11-19 09:00:00' : op.emitida });
  Reg.fechar(dir, id, { id: 'NOVA' + id, numero: 'NN' + id });
  if (op.semMl) return;
  Reg.anotar(dir, id, { no_ml_em: '2026-11-19T13:00:00.000Z' });
}

(async () => {
  const _l = console.log; console.log = () => {};
  try {
    /* ═══ A. a rota ═══ */
    for (const emp of ['girassol', 'amb', 'good']) {
      const pref = CE.prefixoDe(emp);
      const dir = pasta(); const lidas = []; let bling = {};
      const rota = A.criar({ empresa: emp, cacheDir: dir, agora: () => AGORA, json: (res, st, o) => { res._s = st; res._o = o; }, lerChaveAdmin: (req, u) => u.searchParams.get('k') || '',
        validarSessao: (c) => (c === 'adm' ? { admin: true } : (c === 'est' ? { admin: false } : null)), ehAdmin: (s) => !!s.admin,
        blingGet: async (c) => { lidas.push(c); const r = bling[c]; if (r === 'ESTOURA') throw new Error('fora'); return r ? { ok: true, status: 200, data: { data: r } } : { ok: false, status: 429, data: null }; } });
      const pedir = async (qs, cookie) => { const u = new URL('http://x' + pref + '/nf-conserto-antigas' + qs); const res = {}; await rota({ method: 'GET', headers: { cookie: cookie === undefined ? 'adm' : cookie } }, res, u, 'GET', u.pathname); return Object.assign(res._o || {}, { _s: res._s }); };
      conserto(dir, '501', { numero: '082108' });                       /* 54 h: devolução */
      conserto(dir, '502', { emitida: '2026-11-21 10:00:00' });          /* 5 h: ainda cancela */
      conserto(dir, '503', { emitida: null });                           /* sem data */
      conserto(dir, '504', { teste: true });                             /* de teste: nunca pendente */
      conserto(dir, '505', { semMl: true });                             /* ML ainda não aceitou a nova */
      conserto(dir, '506', { emitida: '2026-11-20 15:00:00' });          /* exatamente 24 h: devolução */
      for (const ck of [null, 'est']) assert.strictEqual((await pedir('?preparar=501', ck))._s, 404, emp + ': só admin');
      for (const qs of ['?preparar=abc', '?preparar=5%2001', '?preparar=' + '9'.repeat(21)]) { const r = await pedir(qs); assert.ok(r._s === 400 && /use \?preparar=/.test(r.erro), emp + ': ' + qs); }
      for (const id of ['999', '504', '505']) assert.strictEqual((await pedir('?preparar=' + id)).etapa, 'nao_pendente', emp + ': ' + id);
      const semData = await pedir('?preparar=503'), cedo = await pedir('?preparar=502');
      assert.deepStrictEqual([semData.etapa, /não sei quando/.test(semData.erro), cedo.etapa, /CANCELAR/.test(cedo.erro), lidas.length], ['sem_data', true, 'ainda_cancela', true, 0], emp + ': sem data ou antes das 24 h não devolve (e nem vai ao Bling)');
      /* o Bling: falha, nota diferente, cancelada, e a certa (com e sem loja) */
      bling = {}; let r = await pedir('?preparar=501'); assert.deepStrictEqual([r.ok, r.etapa, /429/.test(r.erro), lidas.slice(-1)[0]], [false, 'bling', true, '/nfe/501']);
      bling = { '/nfe/501': 'ESTOURA' }; r = await pedir('?preparar=501'); assert.deepStrictEqual([r.etapa, /não consegui falar/.test(r.erro)], ['bling', true]);
      bling = { '/nfe/501': { id: 777, numero: '082108', situacao: 5, loja: { id: 1 } } }; assert.strictEqual((await pedir('?preparar=501')).etapa, 'nota_diferente', emp + ': o Bling devolveu outra nota');
      bling = { '/nfe/501': { id: 501, numero: '999999', situacao: 5, loja: { id: 1 } } }; assert.strictEqual((await pedir('?preparar=501')).etapa, 'nota_diferente', emp + ': número diferente do registro');
      bling = { '/nfe/501': { id: 501, numero: '82108', situacao: { valor: 2 }, loja: { id: 1 } } }; r = await pedir('?preparar=501'); assert.deepStrictEqual([r.etapa, /CANCELADA/.test(r.erro)], ['cancelada', true], emp + ': cancelada não devolve (zero à esquerda não engana a conferência do número)');
      lidas.length = 0;
      bling = { '/nfe/501': { id: 501, numero: '082108', situacao: 5, loja: { id: 203456789 }, contato: { nome: 'NÃO SAI' } } }; r = await pedir('?preparar=501');
      assert.deepStrictEqual([r.ok, r.nfe_id, r.numero, r.id_loja, r.empresa, lidas, JSON.stringify(r).includes('NÃO SAI')], [true, '501', '082108', '203456789', emp, ['/nfe/501'], false], emp + ': o que a Toolbox precisa, sem dado de gente, uma leitura só');
      for (const loja of [undefined, null, { id: null }, { id: 'abc' }, { id: '12;3' }]) { bling = { '/nfe/506': { id: 506, numero: 'N506', situacao: 5, loja } }; r = await pedir('?preparar=506'); assert.deepStrictEqual([r.ok, r.id_loja], [true, null], emp + ': loja ausente ou torta vai nula: ' + JSON.stringify(loja)); }
      /* resolver com o número da devolução: só dígitos, só na devolvida */
      r = await pedir('?resolver=501&como=devolvida&confirma=sim&devolucao_id=9988776655&devolucao_numero=000321');
      assert.deepStrictEqual([r.ok, r.resolvida.devolucao_numero, Reg.de(dir, '501').antiga_devolucao_id, Reg.de(dir, '501').antiga_devolucao_numero, Reg.de(dir, '501').antiga_resolvida_como], [true, '000321', '9988776655', '000321', 'devolvida']);
      r = await pedir('?resolver=506&como=devolvida&confirma=sim&devolucao_id=12x&devolucao_numero=' + '1'.repeat(13));
      assert.deepStrictEqual([r.ok, r.resolvida.devolucao_numero, Reg.de(dir, '506').antiga_devolucao_id, Reg.de(dir, '506').antiga_devolucao_numero], [true, null, undefined, undefined], emp + ': torto não é anotado');
      r = await pedir('?resolver=502&como=cancelada&confirma=sim&devolucao_id=11&devolucao_numero=22');
      assert.deepStrictEqual([r.ok, Reg.de(dir, '502').antiga_devolucao_id, Reg.de(dir, '502').antiga_devolucao_numero], [true, undefined, undefined], emp + ': na cancelada não há número de devolução');
      assert.strictEqual((await pedir('?preparar=501')).etapa, 'nao_pendente', emp + ': a já resolvida não prepara de novo');
    }

    /* ═══ B. o painel ═══ */
    {
      const P = require('../lib/checkout/painel/painel-galpao');
      for (const pm of ['girassol-backup-offline', 'amb-checkout-offline', 'good-checkout-offline']) {
        const marca = require(path.join(raiz, pm, 'painel-marca'));
        const html = P.renderizar(marca);
        const i0 = html.indexOf('function _nfaLimpo'), fim = 'setInterval(checarNFAntigas, 5*60000);\n', i1 = html.indexOf(fim);
        assert.ok(i0 > 0 && i1 > i0);
        const codigo = html.slice(i0, i1 + fim.length);
        const cena = (op) => {
          op = op || {};
          const obs = { buscas: [], toasts: [], confirma: [], postados: [], timers: [] };
          const ouvintes = new Set();
          const janela = {
            addEventListener: (t, f) => { if (t === 'message') ouvintes.add(f); }, removeEventListener: (t, f) => { if (t === 'message') ouvintes.delete(f); },
            postMessage: (data) => { obs.postados.push(data); const ev = { source: janela, data }; if (op.ponte) setImmediate(() => op.ponte(data, (resp) => { for (const f of [...ouvintes]) f({ source: janela, data: resp }); }, (resp) => { for (const f of [...ouvintes]) f({ source: {}, data: resp }); })); for (const f of [...ouvintes]) f(ev); },
          };
          const el = { style: { display: 'none' }, innerHTML: '' };
          const relogio = (fn, ms) => { obs.timers.push(ms); if (op.correRelogio && op.correRelogio(ms)) setImmediate(fn); return obs.timers.length; };
          const f = new Function('window', 'document', 'fetch', 'setInterval', 'setTimeout', 'clearTimeout', 'souAdmin', 'confirm', 'toast', codigo + '\nreturn { checarNFAntigas, gerarDevolucaoNFAntiga, _nfaGerando };')(
            janela, { getElementById: (id) => (id === 'nfAntigas' ? el : null) },
            async (u) => { obs.buscas.push(u); if (/preparar=/.test(u)) return { json: async () => (op.prep === undefined ? { ok: true, nfe_id: '501', numero: '082108', id_loja: '203456789' } : op.prep) }; if (/resolver=/.test(u)) return { json: async () => (op.resolver === undefined ? { ok: true } : op.resolver) }; return { json: async () => (op.lista || { ok: true, total: 0, antigas: [] }) }; },
            () => {}, relogio, () => {}, () => (op.admin !== false), (m) => { obs.confirma.push(m); return op.confirma !== false; }, (m) => obs.toasts.push(m));
          return { f, obs, el };
        };
        const PONTE_OK = (resp) => (data, responde, outro) => {
          if (data.tipo === 'GOOD_BRIDGE_PING') return responde({ tipo: 'GOOD_BRIDGE_PONG', versao: '1.4.3' });
          if (data.tipo === 'GOOD_BRIDGE_CRIAR_DEVOLUCAO') { outro({ tipo: 'GOOD_BRIDGE_RESPOSTA', requisicaoId: data.requisicaoId, ok: true, resultado: { idNotaDevolucao: 'FORA', numero: 'FORA' } }); responde({ tipo: 'GOOD_BRIDGE_RESPOSTA', requisicaoId: 'outra', ok: true, resultado: { idNotaDevolucao: 'OUTRA', numero: 'OUTRA' } }); responde(Object.assign({ tipo: 'GOOD_BRIDGE_RESPOSTA', requisicaoId: data.requisicaoId }, resp)); }
        };
        const fim2 = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
        const emp = marca.EMPRESA;

        /* o botão: só na nota de devolução */
        const L = cena({ lista: { ok: true, total: 3, antigas: [{ nfe_id: '501', numero: '082108', acao: 'devolucao', horas_desde_a_emissao: 54 }, { nfe_id: '502', numero: 'N502', acao: 'cancelar', horas_desde_a_emissao: 5 }, { nfe_id: '503', numero: 'N503', acao: null }] } });
        await L.f.checarNFAntigas();
        assert.deepStrictEqual((L.el.innerHTML.match(/gerarDevolucaoNFAntiga\('(\d+)','([^']+)'\)/g) || []), ["gerarDevolucaoNFAntiga('501','082108')"], pm + ': o botão só na que passou das 24 h');
        assert.ok(/>🧾 Gerar devolução \(Toolbox\)<\/button> <button class="btn sec"[^>]*resolverNFAntiga\('501','082108','devolvida'\)/.test(L.el.innerHTML) && /resolverNFAntiga\('502','N502','cancelada'\)/.test(L.el.innerHTML), pm + ': os "já tratei" continuam');

        /* deu certo: o que vai pra ponte, e a nota sai da lista com o número da devolução */
        const c1 = cena({ ponte: PONTE_OK({ ok: true, resultado: { idNotaDevolucao: '9988776655', numero: '000321', emitida: true } }) });
        await c1.f.gerarDevolucaoNFAntiga('501', '082108'); await fim2();
        const pedido = c1.obs.postados.find((m) => m.tipo === 'GOOD_BRIDGE_CRIAR_DEVOLUCAO');
        assert.deepStrictEqual(pedido.payload, { idNFOriginal: '501', idLoja: '203456789', emitir: true, empresa: emp }, pm + ': o pedido pra Toolbox — a empresa DESTE checkout');
        assert.ok(/^chk_\d+_[a-z0-9]+$/.test(pedido.requisicaoId));
        assert.deepStrictEqual(c1.obs.buscas, [marca.PREFIXO + '/nf-conserto-antigas?preparar=501', marca.PREFIXO + '/nf-conserto-antigas?resolver=501&como=devolvida&confirma=sim&devolucao_id=9988776655&devolucao_numero=000321', marca.PREFIXO + '/nf-conserto-antigas'], pm + ': prepara, gera, anota com o número e reconsulta');
        assert.ok(/Gerar e EMITIR a NF de devolução da NF 082108/.test(c1.obs.confirma[0]) && /✓ NF de devolução 000321 emitida — a NF 082108 saiu da lista/.test(c1.obs.toasts.slice(-1)[0]), pm + ': ' + c1.obs.toasts.join(' | '));
        assert.deepStrictEqual([c1.f._nfaGerando['501'], c1.obs.timers.filter((t) => t === 2000 || t === 110000)], [undefined, [2000, 110000]], pm + ': espera a Toolbox 2 s pra dizer que está viva e 110 s pela devolução');
        /* emitiu mas a lista não tirou: diz pra tirar à mão */
        const c1b = cena({ ponte: PONTE_OK({ ok: true, resultado: { idNotaDevolucao: '1', numero: '2' } }), resolver: { ok: false, erro: 'x' } });
        await c1b.f.gerarDevolucaoNFAntiga('501', '082108'); assert.ok(/emitida, mas não consegui tirar a NF 082108 da lista — toque em "já gerei a devolução"/.test(c1b.obs.toasts.slice(-1)[0]));

        /* as respostas de falha da Toolbox */
        const casos = [
          [{ ok: false, codigo: 'JA_EXISTE', erro: 'ja existe', idNotaDevolucao: '55', numero: '66' }, /o Bling já tem a devolução da NF 082108 \(nº 66\) — saiu da lista/, true, '&devolucao_id=55&devolucao_numero=66'],
          [{ ok: false, codigo: 'RASCUNHO_CRIADO', erro: 'sefaz recusou', idNotaDevolucao: '77', numero: '88' }, /a NF de devolução 88 foi CRIADA no Bling mas não emitiu — emita ela por lá \(não gere de novo\).*sefaz recusou/, false],
          [{ ok: false, codigo: 'TIMEOUT', erro: 'x' }, /PODE ter sido criada.*não duplica/, false],
          [{ ok: false, codigo: 'NAO_LOGADO', erro: 'x' }, /o Bling não está logado neste navegador/, false],
          [{ ok: false, codigo: 'FALHA', erro: 'A aba do Bling esta logada em OUTRA empresa' }, /não gerei a devolução: A aba do Bling esta logada em OUTRA empresa/, false],
          [{ ok: false, erro: 'sem codigo' }, /não gerei a devolução: sem codigo/, false],
        ];
        for (const [resp, re, tira, qs] of casos) {
          const c = cena({ ponte: PONTE_OK(resp) }); await c.f.gerarDevolucaoNFAntiga('501', '082108'); await fim2();
          const tirou = c.obs.buscas.some((u) => /resolver=/.test(u));
          assert.ok(re.test(c.obs.toasts.slice(-1)[0]) && tirou === tira, pm + ' ' + (resp.codigo || '-') + ': ' + c.obs.toasts.slice(-1)[0] + ' / tirou=' + tirou);
          if (qs) assert.ok(c.obs.buscas.some((u) => u.endsWith('como=devolvida&confirma=sim' + qs)), pm + ': já existe também anota o número');
        }
        /* a Toolbox não respondeu em 110 s: "não sei", nunca "não criou"; não tira da lista */
        const ct = cena({ ponte: (data, responde) => { if (data.tipo === 'GOOD_BRIDGE_PING') responde({ tipo: 'GOOD_BRIDGE_PONG' }); }, correRelogio: (ms) => ms === 110000 });
        await ct.f.gerarDevolucaoNFAntiga('501', '082108'); assert.ok(/PODE ter sido criada/.test(ct.obs.toasts.slice(-1)[0]) && !ct.obs.buscas.some((u) => /resolver=/.test(u)));
        /* sem Toolbox na página: avisa onde tem que ser, e nem pergunta ao servidor */
        const sem = cena({ correRelogio: (ms) => ms === 2000 });
        await sem.f.gerarDevolucaoNFAntiga('501', '082108');
        assert.deepStrictEqual([sem.obs.buscas.filter((u) => /preparar|resolver/.test(u)), /Toolbox não encontrada.*COMPUTADOR.*2\.1\.22/.test(sem.obs.toasts[0]), sem.obs.postados.filter((m) => m.tipo === 'GOOD_BRIDGE_CRIAR_DEVOLUCAO').length], [[], true, 0], pm + ': sem a Toolbox');
        /* a ponte que só ANUNCIA (INSTALADA, ao carregar) e não responde ao PING também vale como viva */
        const velha = cena({ correRelogio: (ms) => ms === 2000, ponte: (data, responde) => { if (data.tipo === 'GOOD_BRIDGE_PING') responde({ tipo: 'GOOD_BRIDGE_INSTALADA', versao: '1.4.3' }); if (data.tipo === 'GOOD_BRIDGE_CRIAR_DEVOLUCAO') responde({ tipo: 'GOOD_BRIDGE_RESPOSTA', requisicaoId: data.requisicaoId, ok: true, resultado: { idNotaDevolucao: '1', numero: '2' } }); } });
        await velha.f.gerarDevolucaoNFAntiga('501', '082108'); await fim2(); assert.ok(/✓ NF de devolução 2 emitida/.test(velha.obs.toasts.slice(-1)[0]), pm + ': ' + velha.obs.toasts.join(' | '));
        /* o servidor recusou: diz o motivo e não chama a Toolbox */
        const pr = cena({ ponte: PONTE_OK({ ok: true }), prep: { ok: false, etapa: 'ainda_cancela', erro: 'emitida há menos de 24 h — a regra é CANCELAR no Bling, não devolver' } });
        await pr.f.gerarDevolucaoNFAntiga('501', '082108'); await fim2();
        assert.deepStrictEqual([pr.obs.postados.filter((m) => m.tipo === 'GOOD_BRIDGE_CRIAR_DEVOLUCAO').length, /não gerei: emitida há menos de 24 h/.test(pr.obs.toasts.slice(-1)[0])], [0, true]);
        const pr2 = cena({ ponte: PONTE_OK({ ok: true }), prep: null }); await pr2.f.gerarDevolucaoNFAntiga('501', '082108'); assert.ok(/sem resposta do servidor/.test(pr2.obs.toasts.slice(-1)[0]));
        const pr3 = cena({ ponte: PONTE_OK({ ok: true, resultado: {} }), prep: { ok: true, nfe_id: '501', numero: '082108', id_loja: null } }); await pr3.f.gerarDevolucaoNFAntiga('501', '082108'); await fim2();
        assert.strictEqual(pr3.obs.postados.find((m) => m.tipo === 'GOOD_BRIDGE_CRIAR_DEVOLUCAO').payload.idLoja, null, pm + ': sem loja, vai nulo (a Toolbox usa a da própria nota)');
        /* sem confirmar, não-admin, ou já gerando: nada sai */
        for (const op of [{ confirma: false }, { admin: false }]) { const c = cena(Object.assign({ ponte: PONTE_OK({ ok: true }) }, op)); await c.f.gerarDevolucaoNFAntiga('501', '082108'); assert.deepStrictEqual([c.obs.buscas.length, c.obs.postados.length], [0, 0], pm + ': ' + JSON.stringify(op)); }
        const dois = cena({ ponte: PONTE_OK({ ok: true, resultado: { idNotaDevolucao: '1', numero: '2' } }) });
        const p1 = dois.f.gerarDevolucaoNFAntiga('501', '082108'), p2 = dois.f.gerarDevolucaoNFAntiga('501', '082108'); await p1; await p2; await fim2();
        assert.deepStrictEqual([dois.obs.confirma.length, dois.obs.postados.filter((m) => m.tipo === 'GOOD_BRIDGE_CRIAR_DEVOLUCAO').length], [1, 1], pm + ': dois cliques seguidos geram UMA');
      }
    }

    /* ═══ C. a Toolbox ═══ */
    {
      const man = JSON.parse(fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'manifest.json'), 'utf8'));
      const ver = man.version.split('.').map(Number);
      assert.ok(ver[0] > 2 || (ver[0] === 2 && (ver[1] > 1 || (ver[1] === 1 && ver[2] >= 22))), 'a Toolbox com a ponte no checkout é a 2.1.22 ou mais nova: ' + man.version);
      const comPonte = man.content_scripts.filter((c) => c.js.includes('ct-devolucoes.js'));
      const doCheckout = comPonte.filter((c) => c.matches.some((m) => /mover-pedidos-aguardando-x-atendido\.onrender\.com/.test(m)));
      assert.strictEqual(doCheckout.length, 1, 'uma regra só da ponte no checkout');
      const E = require('../toolbox-extensao/tb-empresas.js');
      const esperado = E.tbEmpresas().map((k) => 'https://mover-pedidos-aguardando-x-atendido.onrender.com/' + E.tbFicha(k).checkout + '*').sort();
      assert.deepStrictEqual(doCheckout[0].matches.slice().sort(), esperado, 'a ponte roda no checkout de CADA empresa da ficha — e só no checkout (dashboard, ponto e o resto não)');
      assert.deepStrictEqual(doCheckout[0].js, ['ct-devolucoes.js']);
      for (const pm of ['girassol-backup-offline', 'amb-checkout-offline', 'good-checkout-offline']) {
        const mk = require(path.join(raiz, pm, 'painel-marca'));
        assert.ok(esperado.includes('https://mover-pedidos-aguardando-x-atendido.onrender.com' + mk.PREFIXO + '*'), pm + ': o prefixo do painel está na regra');
        assert.ok(E.tbFicha(mk.EMPRESA), pm + ': a empresa que o checkout manda (' + mk.EMPRESA + ') é reconhecida pela ficha da Toolbox');
      }
      /* a ponte, rodada: o pedido do checkout chega ao fundo inteiro, e a resposta volta com o código estável */
      const ouv = []; const postados = []; const enviados = [];
      const win = { addEventListener: (t, f) => ouv.push(f), postMessage: (d) => postados.push(d) };
      const chrome = { runtime: { id: 'x', sendMessage: async (m) => { enviados.push(m); if (m.tipo === 'BLING_FALHAS_REGISTRO') return { ok: true, falhas: [] }; return { ok: false, codigo: 'JA_EXISTE', erro: 'ja existe', idNotaDevolucao: '55', numero: '66', resultado: null }; } } };
      const c2 = { window: win, chrome, console: { log() {} }, setTimeout, Promise };
      vm.createContext(c2); vm.runInContext(fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'ct-devolucoes.js'), 'utf8'), c2);
      const payload = { idNFOriginal: '501', idLoja: '203456789', emitir: true, empresa: 'amb' };
      for (const f of ouv) await f({ source: win, data: { tipo: 'GOOD_BRIDGE_CRIAR_DEVOLUCAO', requisicaoId: 'chk_1_a', payload } });
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
      const pedidoFundo = enviados.find((m) => m.tipo === 'BLING_DEVOLUCAO_CRIAR');
      assert.deepStrictEqual(pedidoFundo && JSON.parse(JSON.stringify(pedidoFundo.payload)), payload, 'a ponte repassa o pedido inteiro ao fundo');
      const resp = postados.find((m) => m.tipo === 'GOOD_BRIDGE_RESPOSTA');
      assert.deepStrictEqual(resp && [resp.requisicaoId, resp.ok, resp.codigo, resp.idNotaDevolucao, resp.numero], ['chk_1_a', false, 'JA_EXISTE', '55', '66'], 'a resposta volta com o mesmo id e o código estável');
      /* o fundo lê exatamente os campos que o checkout manda */
      const bg = fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'bg-devolucoes.js'), 'utf8');
      assert.ok(/const \{ idNFOriginal, idLoja, emitir, idDeposito \} = payload \|\| \{\};/.test(bg) && /String\(\(payload && payload\.empresa\) \|\| 'good'\)/.test(bg), 'o contrato da ponte mudou no fundo — o checkout manda idNFOriginal, idLoja, emitir e empresa');
    }
  } finally { console.log = _l; }
  console.log('ok — nota antiga do conserto: "Gerar devolução" pela Toolbox — a rota só prepara a nota pendente passada das 24 h (a mesma, não cancelada, com o id da loja), o painel fala com a ponte e trata cada resposta, e a Toolbox 2.1.22 leva a ponte ao checkout das empresas da ficha');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
