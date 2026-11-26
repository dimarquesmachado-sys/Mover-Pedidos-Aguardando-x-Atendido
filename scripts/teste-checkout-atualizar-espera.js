'use strict';
/* 23/11 — O "↻ ATUALIZAR" DO CHECKOUT ESPERA A CONSULTA AO BLING (o dono: "é meio lerdo o checkout. eu clico em atualizar tb, e
   nem sempre reflete o bling"; o pedido 125147 já estava no ATENDIDO no Bling e não aparecia).

   Prova (o código de produção):
   A. a rota /run: o pedido de ciclo nunca se perde — com um ciclo rodando, roda outro logo depois; clique que chega no meio
      do ciclo que acabou de rodar ganha mais um; cliques juntos viram um laço só; a resposta traz a hora do pedido;
   B. o ciclo guarda quando COMEÇOU, e a /lista devolve isso (o "Bling agora" também devolve a hora do pedido);
   C. o painel (o trecho de verdade): o "Atualizar" e o "Bling agora" esperam uma consulta que tenha COMEÇADO depois do
      clique — a que já rodava e terminou depois não conta —, recarregam a lista e dizem quando o Bling demorou. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
process.exitCode = 1;   /* promessa que nunca resolve esvazia o laço: só o fim diz que passou */
let _chegouAoFim = false;
process.on('exit', (cod) => { if (cod !== 0 && !_chegouAoFim) console.error('FALHOU: o teste não chegou ao fim — uma espera ficou sem prazo (promessa que nunca resolve)'); });
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
const giros = async (n) => { for (let i = 0; i < (n || 30); i++) await new Promise((ok) => setImmediate(ok)); };

(async () => {
  /* ═══ A. a rota /run ═══ */
  {
    const { criar } = require('../lib/checkout/rotas-conferido');
    const cena = () => {
      const obs = { chamadas: [], respostas: [] };
      let ocupado = false; let solta = null;
      const rodarCiclo = async (motivo, forcar) => {
        obs.chamadas.push({ motivo, forcar, em: Date.now() });
        if (ocupado) return { pulado: true };
        ocupado = true;
        await new Promise((ok) => { solta = ok; });
        ocupado = false; return { rodouEm: new Date().toISOString() };
      };
      const rota = criar({ prefixo: '/x', tag: 'T', json: (res, st, o) => obs.respostas.push(o), readBody: async () => ({}), readJson: () => ({}), writeJson: () => {},
        lerReservas: () => ({}), moverSituacao: async () => ({}), arquivarFinalizado: () => {}, sincronizarConferidos: async () => ({}), rodarCiclo,
        CONFERIDOS_FILE: '/tmp/c.json', RESERVAS_FILE: '/tmp/r.json', CACHE_DIR: '/tmp', SIT_VERIFICADO: 24, SYNC_ON: true, VERSAO: 't', esperaEntreTentativasMs: 15 });
      const clicar = (qs) => { const u = new URL('http://h/x/run' + (qs || '')); return rota({ method: 'POST', headers: {} }, {}, u, 'POST', '/x/run'); };
      return { obs, clicar, terminar: () => { const s = solta; solta = null; if (s) s(); }, ocupar: () => { ocupado = true; }, liberar: () => { ocupado = false; }, rodando: () => !!solta };
    };
    /* parado: um clique roda um ciclo e devolve a hora do pedido */
    let c = cena(); const antes = Date.now();
    assert.strictEqual(await c.clicar(), true);
    const r0 = c.obs.respostas[0];
    assert.ok(r0 && Date.parse(r0.pedido_em) >= antes - 5 && Date.parse(r0.pedido_em) <= Date.now() && /Ciclo iniciado/.test(r0.mensagem), JSON.stringify(r0));
    await giros(); assert.deepStrictEqual(c.obs.chamadas.map((x) => x.motivo), ['manual']);
    c.terminar(); await giros(); await espera(40); assert.strictEqual(c.obs.chamadas.length, 1, 'ninguém pediu depois do começo: um ciclo só');
    /* com o ciclo do relógio rodando: o clique NÃO se perde — roda outro logo depois */
    c = cena(); c.ocupar();
    await c.clicar(); await giros(); await espera(40);
    assert.ok(c.obs.chamadas.length >= 2 && c.obs.chamadas.every((x) => x.motivo === 'manual'), 'tenta de novo enquanto o outro roda: ' + c.obs.chamadas.length);
    c.liberar(); await espera(40); assert.ok(c.rodando(), 'quando o outro termina, o ciclo do clique roda');
    const nAntes = c.obs.chamadas.length; c.terminar(); await giros(); await espera(40);
    assert.strictEqual(c.obs.chamadas.length, nAntes, 'e para depois dele');
    /* clique no MEIO do ciclo do próprio laço: a foto dele é de antes do clique — roda mais um */
    c = cena(); await c.clicar(); await giros();
    await espera(5); await c.clicar(); await c.clicar(); await giros();
    assert.strictEqual(c.obs.chamadas.length, 1, 'cliques juntos não abrem outro laço nem outro ciclo agora');
    c.terminar(); await giros(); await espera(30);
    assert.strictEqual(c.obs.chamadas.length, 2, 'o clique que chegou no meio ganhou um ciclo novo');
    c.terminar(); await giros(); await espera(30);
    assert.strictEqual(c.obs.chamadas.length, 2, 'e acabou ali');
    /* Codex #971: o ciclo do relógio pode ficar rodando bem mais que 60 tentativas (até o watchdog de 15 min dele): o pedido
       não é abandonado — o teto é de TEMPO (aqui, 3 s), não de tentativas */
    {
      const { criar: criarH } = require('../lib/checkout/rotas-conferido');
      let ocupadoH = true, chamadasH = 0, rodadasH = 0;
      const rotaH = criarH({ prefixo: '/x', tag: 'T', json: () => {}, readBody: async () => ({}), readJson: () => ({}), writeJson: () => {}, lerReservas: () => ({}), moverSituacao: async () => ({}), arquivarFinalizado: () => {},
        sincronizarConferidos: async () => ({}), rodarCiclo: async () => { chamadasH++; if (ocupadoH) return { pulado: true }; rodadasH++; return {}; },
        CONFERIDOS_FILE: '/tmp/c.json', RESERVAS_FILE: '/tmp/r.json', CACHE_DIR: '/tmp', SIT_VERIFICADO: 24, SYNC_ON: true, VERSAO: 't', esperaEntreTentativasMs: 5, horizonteTentativasMs: 3000 });
      const uH = new URL('http://h/x/run');
      await rotaH({ method: 'POST', headers: {} }, {}, uH, 'POST', '/x/run');
      await espera(1200);
      assert.ok(chamadasH > 80 && rodadasH === 0, 'tentou bem mais que 60 vezes sem desistir: ' + chamadasH);
      ocupadoH = false; await espera(60);
      assert.strictEqual(rodadasH, 1, 'quando o ciclo do relógio solta, o pedido roda');
      /* passou do teto de tempo ocupado: desiste e solta o laço (o próximo clique recomeça) */
      ocupadoH = true; chamadasH = 0;
      await rotaH({ method: 'POST', headers: {} }, {}, uH, 'POST', '/x/run');
      await espera(3400); const antesH = chamadasH; await espera(100);
      assert.ok(antesH > 0 && chamadasH === antesH, 'passado o teto, para de tentar: ' + antesH + ' → ' + chamadasH);
      ocupadoH = false; await rotaH({ method: 'POST', headers: {} }, {}, uH, 'POST', '/x/run'); await espera(60);
      assert.strictEqual(rodadasH, 2, 'e o laço foi solto: o clique seguinte roda');
    }
    /* o prazo conta do último ciclo rodado: um laço que já rodou um ciclo longo e tem pedido novo não desiste do próximo
       pelo relógio do começo */
    {
      const { criar: criarR } = require('../lib/checkout/rotas-conferido');
      let n = 0, rodadas = 0, livreEm = 0; const t0 = Date.now();
      const rotaR = criarR({ prefixo: '/x', tag: 'T', json: () => {}, readBody: async () => ({}), readJson: () => ({}), writeJson: () => {}, lerReservas: () => ({}), moverSituacao: async () => ({}), arquivarFinalizado: () => {},
        sincronizarConferidos: async () => ({}),
        rodarCiclo: async () => { n++; if (n === 1) { rodadas++; await espera(250); livreEm = Date.now() + 200; return {}; } if (Date.now() < livreEm) return { pulado: true }; rodadas++; return {}; },
        CONFERIDOS_FILE: '/tmp/c.json', RESERVAS_FILE: '/tmp/r.json', CACHE_DIR: '/tmp', SIT_VERIFICADO: 24, SYNC_ON: true, VERSAO: 't', esperaEntreTentativasMs: 5, horizonteTentativasMs: 300 });
      const uR = new URL('http://h/x/run');
      await rotaR({ method: 'POST', headers: {} }, {}, uR, 'POST', '/x/run');
      await espera(100); await rotaR({ method: 'POST', headers: {} }, {}, uR, 'POST', '/x/run');   /* clique no meio do ciclo longo */
      await espera(800);
      assert.strictEqual(rodadas, 2, 'o clique do meio roda mesmo tendo passado o prazo contado do começo do laço (' + (Date.now() - t0) + ' ms)');
    }
    /* Codex #971: o force que chega enquanto o laço espera NÃO se perde — vai no próximo ciclo que rodar */
    c = cena(); c.ocupar();
    await c.clicar(); await giros(); await espera(20);
    await c.clicar('?force=1'); await espera(20);
    assert.ok(c.obs.chamadas.slice(-1)[0].forcar === true, 'o force vai na próxima tentativa: ' + JSON.stringify(c.obs.chamadas.map((x) => x.forcar)));
    c.liberar(); await espera(40);
    const rodou = c.obs.chamadas.filter((x) => true).slice(-1)[0];
    assert.deepStrictEqual([c.rodando(), rodou.motivo, rodou.forcar], [true, 'manual-force', true], 'o ciclo que roda depois é o forçado');
    c.terminar(); await giros(); await espera(40);
    assert.ok(c.obs.chamadas.slice(-1)[0] === rodou, 'e o force foi consumido (não roda outro)');
    await c.clicar(); await giros(); assert.strictEqual(c.obs.chamadas.slice(-1)[0].forcar, false, 'o clique comum seguinte NÃO é forçado (o force foi gasto)');
    c.terminar(); await giros(); await espera(30);
    /* force no MEIO do ciclo comum do laço: o próximo ciclo é forçado */
    c = cena(); await c.clicar(); await giros(); await espera(5); await c.clicar('?force=1'); await giros();
    c.terminar(); await giros(); await espera(30);
    assert.deepStrictEqual(c.obs.chamadas.map((x) => x.forcar), [false, true], 'o force que chegou no meio ganhou o ciclo dele');
    c.terminar(); await giros(); await espera(30);
    /* o force segue passando */
    c = cena(); await c.clicar('?force=1'); await giros();
    assert.deepStrictEqual([c.obs.chamadas[0].motivo, c.obs.chamadas[0].forcar, /FORCE/.test(c.obs.respostas[0].mensagem)], ['manual-force', true, true]);
    c.terminar(); await giros();
    /* ciclo que falha (estoura) não prende o laço: o próximo clique roda */
    const { criar: criar2 } = require('../lib/checkout/rotas-conferido');
    let n = 0; const rr = [];
    const rota2 = criar2({ prefixo: '/x', tag: 'T', json: (res, st, o) => rr.push(o), readBody: async () => ({}), readJson: () => ({}), writeJson: () => {}, lerReservas: () => ({}), moverSituacao: async () => ({}), arquivarFinalizado: () => {},
      sincronizarConferidos: async () => ({}), rodarCiclo: async () => { n++; throw new Error('Bling caiu'); }, CONFERIDOS_FILE: '/tmp/c.json', RESERVAS_FILE: '/tmp/r.json', CACHE_DIR: '/tmp', SIT_VERIFICADO: 24, SYNC_ON: true, VERSAO: 't', esperaEntreTentativasMs: 15 });
    const u2 = new URL('http://h/x/run');
    await rota2({ method: 'POST', headers: {} }, {}, u2, 'POST', '/x/run'); await giros(); await espera(20);
    await rota2({ method: 'POST', headers: {} }, {}, u2, 'POST', '/x/run'); await giros(); await espera(20);
    assert.strictEqual(n, 2, 'o laço se solta depois de um ciclo que falhou');
    /* Codex #971: ciclo que NUNCA termina tem prazo — o laço não fica preso: tenta de novo (e o force continua pendente) */
    let m = 0; const forcas = [];
    const rota3 = criar2({ prefixo: '/x', tag: 'T', json: () => {}, readBody: async () => ({}), readJson: () => ({}), writeJson: () => {}, lerReservas: () => ({}), moverSituacao: async () => ({}), arquivarFinalizado: () => {},
      sincronizarConferidos: async () => ({}), rodarCiclo: (mot, f) => { m++; forcas.push(f); return m === 1 ? new Promise(() => {}) : Promise.resolve({ rodouEm: 'x' }); },
      CONFERIDOS_FILE: '/tmp/c.json', RESERVAS_FILE: '/tmp/r.json', CACHE_DIR: '/tmp', SIT_VERIFICADO: 24, SYNC_ON: true, VERSAO: 't', esperaEntreTentativasMs: 5, prazoCicloMs: 30 });
    await rota3({ method: 'POST', headers: {} }, {}, new URL('http://h/x/run?force=1'), 'POST', '/x/run'); await giros(); await espera(120);
    assert.deepStrictEqual(forcas, [true, true], 'ciclo pendurado estourou o prazo e o force foi tentado de novo: ' + JSON.stringify(forcas));
  }

  /* ═══ B. o ciclo e as rotas que o painel lê ═══ */
  {
    const ce = fs.readFileSync(path.join(raiz, 'lib/checkout/ciclo-empresa.js'), 'utf8');
    assert.ok(/ultimoResumo = \{\n\s+rodouEm: new Date\(\)\.toISOString\(\),[\s\S]{0,300}?comecouEm: new Date\(t0\)\.toISOString\(\),/.test(ce) && /const t0 = Date\.now\(\);\n\s+let novos = 0, erros = 0;/.test(ce), 'o resumo do ciclo guarda o COMEÇO (t0, de antes da foto do ATENDIDO)');
    assert.ok(ce.indexOf('const t0 = Date.now();') < ce.indexOf('await listarAtendidos()'), 'o t0 é de antes da leitura do ATENDIDO');
    const rc = fs.readFileSync(path.join(raiz, 'lib/checkout/rotas-comuns.js'), 'utf8');
    assert.ok(/ciclo_comecou_em: \(getUltimoResumo\(\) \|\| \{\}\)\.comecouEm \|\| null,/.test(rc), 'a /lista devolve quando o último ciclo começou');
    assert.ok(/json\(res, 200, \{ ok: true, mensagem: 'consultando o Bling agora \(~30-60s\)', pedido_em: new Date\(agora\)\.toISOString\(\) \}\);/.test(rc), 'o "Bling agora" devolve a hora do pedido');
  }

  /* ═══ C. o painel ═══ */
  {
    const P = require('../lib/checkout/painel/painel-galpao');
    for (const pm of ['girassol-backup-offline', 'amb-checkout-offline', 'good-checkout-offline']) {
      const marca = require(path.join(raiz, pm, 'painel-marca'));
      const html = P.renderizar(marca);
      const pega = (ini, fim) => { const i = html.indexOf(ini); const j = html.indexOf(fim, i); assert.ok(i > 0 && j > i, pm + ': ' + ini); return html.slice(i, j + fim.length); };
      const codigo = pega('async function blingAgora(){', '\n}\n') + pega('async function _esperarCicloDepois(', '\n}\n') + pega('async function sincronizar(){', '\n}\n');
      const cena = (op) => {
        const obs = { lista: 0, toasts: [], posts: [], carregou: 0, rel: 0 };
        const btn = { textContent: '↻ Atualizar', disabled: false }, btn2 = { disabled: false };
        const relogio = { agora: Date.parse('2026-11-23T16:50:00Z') };
        const f = new Function('$', 'api', 'postJson', 'fetch', 'toast', 'carregarLista', 'souAdmin', 'setTimeout', 'Date',
          codigo + '\nreturn { blingAgora, sincronizar, _esperarCicloDepois };')(
          (id) => (id === 'btnSync' ? btn : btn2),
          async (u, o) => {
            if (u === marca.PREFIXO + '/ciclo-agora') { obs.posts.push(u); assert.ok(o && o.method === 'POST' && o.signal, 'o "Bling agora" tem que levar prazo'); if (op.cicloPendura) return new Promise((ok, falha) => o.signal.addEventListener('abort', () => falha(new Error('abortada')))); return op.cicloAgora; }
            obs.lista++; assert.strictEqual(u, marca.PREFIXO + '/lista');
            if (op.pendura && op.pendura(obs.lista)) { assert.ok(o && o.signal, 'a consulta da espera tem que levar prazo'); return new Promise((ok, falha) => o.signal.addEventListener('abort', () => { obs.abortadas = (obs.abortadas || 0) + 1; falha(new Error('abortada')); })); }
            return op.lista(obs.lista); },
          async (u) => { obs.posts.push(u); return op.cicloAgora; },
          async (u, o) => { obs.posts.push(u + ' ' + (o && o.method));
            if (op.runPendura) { assert.ok(o && o.signal, 'o pedido do Atualizar tem que levar prazo'); return new Promise((ok, falha) => o.signal.addEventListener('abort', () => falha(new Error('abortada')))); }
            return { json: async () => { if (op.runQuebra) throw new Error('x'); return op.run; } }; },
          (m) => obs.toasts.push(m), async () => { obs.carregou++; }, () => op.admin !== false,
          (fn, ms) => { if (++obs.rel > 400) throw new Error('espera sem fim'); if (ms === 5000) relogio.agora += ms; else obs.prazos = (obs.prazos || []).concat([ms]); setImmediate(fn); return 1; },   /* espera sem teto vira erro, não trava o teste; os prazos de consulta disparam na hora (como se a consulta pendurasse até o fim deles) */
          Object.assign(function () { return new Date(relogio.agora); }, { now: () => relogio.agora, parse: Date.parse }));
        return { f, obs, btn, btn2, relogio };
      };
      const PED = '2026-11-23T16:50:00.000Z';
      /* "Atualizar": espera a consulta que COMEÇOU depois do clique; a que já rodava (começou antes, terminou depois) não conta */
      let c = cena({ run: { pedido_em: PED }, lista: (n) => (n < 3 ? { ciclo_comecou_em: '2026-11-23T16:49:30.000Z', ciclo_rodou_em: '2026-11-23T16:50:20.000Z' } : { ciclo_comecou_em: '2026-11-23T16:50:01.000Z' }) });
      const p = c.f.sincronizar(); assert.deepStrictEqual([c.btn.textContent, c.btn.disabled], ['⏳ Consultando o Bling…', true]);
      await p;
      assert.deepStrictEqual([c.obs.posts, c.obs.lista, c.obs.carregou, c.obs.toasts, c.btn.textContent, c.btn.disabled], [[marca.PREFIXO + '/atualizar POST'], 3, 2, ['Sincronizado com o Bling'], '↻ Atualizar', false], pm + ': ' + JSON.stringify(c.obs));
      /* o Bling demorou mais que o teto: recarrega o que tem e avisa, sem fingir que atualizou */
      c = cena({ run: { pedido_em: PED }, lista: () => ({ ciclo_comecou_em: '2026-11-23T16:49:00.000Z' }) });
      await c.f.sincronizar();
      assert.ok(c.obs.lista >= 30 && c.obs.lista <= 37 && /o Bling está demorando/.test(c.obs.toasts[0]) && c.btn.disabled === false && c.obs.carregou === 2, pm + ': teto de 3 min: ' + c.obs.lista + ' ' + c.obs.toasts);
      /* Codex #971: consulta à lista que PENDURA não segura o botão além do teto — cada uma é abortada no prazo */
      c = cena({ run: { pedido_em: PED }, pendura: () => true, lista: () => ({}) });
      await c.f.sincronizar();
      assert.ok(c.obs.abortadas >= 30 && /o Bling está demorando/.test(c.obs.toasts[0]) && c.btn.disabled === false && c.obs.prazos.every((m) => m > 0 && m <= 20000), pm + ': consultas penduradas: ' + JSON.stringify([c.obs.abortadas, c.obs.toasts, (c.obs.prazos || []).slice(0, 3)]));
      c = cena({ run: { pedido_em: PED }, pendura: (n) => n === 2, lista: (n) => (n >= 3 ? { ciclo_comecou_em: PED } : {}) });
      await c.f.sincronizar(); assert.deepStrictEqual([c.obs.abortadas, c.obs.toasts], [1, ['Sincronizado com o Bling']], pm + ': uma pendurada no meio não atrapalha as seguintes');
      c = cena({ runPendura: true, lista: () => ({}) });
      await c.f.sincronizar(); assert.deepStrictEqual([/Falha ao pedir a atualização/.test(c.obs.toasts[0]), c.btn.disabled, c.obs.prazos.includes(20000)], [true, false, true], pm + ': o pedido ao servidor que pendura também tem prazo');
      /* lista que falha no meio: continua esperando (não é "atualizou") */
      c = cena({ run: { pedido_em: PED }, lista: (n) => { if (n === 1) throw new Error('rede'); return n === 2 ? null : { ciclo_comecou_em: PED }; } });
      await c.f.sincronizar(); assert.deepStrictEqual([c.obs.lista, c.obs.toasts], [3, ['Sincronizado com o Bling']], pm + ': começou no mesmo instante do pedido conta');
      /* servidor sem a hora do pedido (resposta torta, ou falhou): não espera à toa, recarrega e avisa */
      for (const op of [{ run: {} }, { run: null }, { runQuebra: true }]) {
        c = cena(Object.assign({ lista: () => ({}) }, op)); await c.f.sincronizar();
        assert.deepStrictEqual([c.obs.lista, c.obs.carregou, /Falha ao pedir a atualização/.test(c.obs.toasts[0]), c.btn.disabled], [0, 1, true, false], pm + ': ' + JSON.stringify(op));
      }
      /* "Bling agora": a mesma espera */
      c = cena({ cicloAgora: { ok: true, pedido_em: PED }, lista: (n) => (n < 2 ? { ciclo_comecou_em: '2026-11-23T16:49:59.000Z' } : { ciclo_comecou_em: '2026-11-23T16:50:30.000Z' }) });
      await c.f.blingAgora();
      assert.deepStrictEqual([c.obs.posts, c.obs.lista, c.obs.carregou, c.obs.toasts.slice(-1)[0], c.btn2.disabled], [[marca.PREFIXO + '/ciclo-agora'], 2, 1, '✓ lista atualizada com o Bling', false], pm + ': Bling agora');
      c = cena({ cicloPendura: true, lista: () => ({}) }); await c.f.blingAgora();
      assert.deepStrictEqual([/falha/.test(c.obs.toasts.slice(-1)[0]), c.btn2.disabled, c.obs.prazos.includes(20000)], [true, false, true], pm + ': o pedido do Bling agora que pendura tem prazo');
      /* Codex #971: a recarga da lista (carregarLista) também tem prazo, e prazo estourado não apaga a lista da tela */
      const cl = pega('async function carregarLista(){', '\n}\n');
      assert.ok(/const acL = .*AbortController[\s\S]*setTimeout\(\(\) => acL\.abort\(\), 20000\)[\s\S]*api\('[^']*\/lista', acL \? \{ signal: acL\.signal \} : undefined\)[\s\S]*clearTimeout\(tmL\)/.test(cl) && /e\.name==='AbortError' && listaCache && listaCache\.length\) return;/.test(cl), pm + ': carregarLista com prazo');
      c = cena({ cicloAgora: { ok: false, erro: '⏳ ciclo já disparado há menos de 1 min — aguarde' }, lista: () => ({}) }); await c.f.blingAgora();
      assert.deepStrictEqual([c.obs.lista, c.obs.toasts.slice(-1)[0], c.btn2.disabled], [0, '⏳ ciclo já disparado há menos de 1 min — aguarde', false]);
      c = cena({ cicloAgora: { ok: true }, admin: false, lista: () => ({}) }); await c.f.blingAgora(); assert.deepStrictEqual(c.obs.posts, [], pm + ': só admin');
      /* a função de espera em si: sem hora válida não espera */
      c = cena({ lista: () => ({ ciclo_comecou_em: PED }) });
      assert.deepStrictEqual([await c.f._esperarCicloDepois(null, 1000), await c.f._esperarCicloDepois('ontem', 1000), c.obs.lista], [false, false, 0]);
    }
  }
  _chegouAoFim = true;
  console.log('ok — checkout: o "Atualizar" nunca perde o pedido de consulta (com um ciclo rodando, roda outro depois) e o painel espera a consulta que começou depois do clique antes de recarregar — nas três empresas');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
