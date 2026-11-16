'use strict';
/* 15/11 — A TRAVA DO CICLO TEM DONO (auditoria geral do Codex de 15/11/2026, P2 nº 5).

   O ciclo tem um watchdog: execução pendurada há mais de 15 min (Bling mudo) solta a trava e a próxima roda. Mas a antiga
   não morria — quando o Bling finalmente respondia, ela ACORDAVA e seguia: gravava um manifesto velho por cima do que a nova
   acabara de gravar, movia pedido no Bling com uma foto antiga da fila, escrevia o resumo e, no `finally`, punha
   `rodando = false` NO MEIO da execução nova — que a partir daí corria em dobro com o cron seguinte.

   Agora `rodando` guarda a GERAÇÃO da execução dona. O watchdog deixa a antiga SUBSTITUÍDA: ao acordar ela não grava o
   manifesto (o `salvarManifest` dela recusa), para antes de mover Full / sincronizar conferidos / gravar o manifesto final
   (`_exigirDona`), não escreve o resumo e não solta a trava de quem veio depois. O resumo mostra `geracao` e
   `substituidasPeloWatchdog`.

   Prova com o CICLO DE PRODUÇÃO da AMB (amb-checkout-offline/ciclo.js — a peça lib/checkout/ciclo-empresa montada como a
   AMB monta), Bling de mentira (node-fetch trocado) cuja lista de ATENDIDO fica PENDURADA sob controle do teste, e o
   relógio adiantado 16 min pra disparar o watchdog. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vigia = setTimeout(() => { console.error('FALHOU: o teste travou — 60s'); process.exit(1); }, 60000);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-ciclo-'));
process.env.AMBBKP_CACHE_DIR = dir; process.env.AMBBKP_ARQUIVO_DIR = path.join(dir, 'arq'); process.env.AMBBKP_SYNC_ON = '1';
process.env.AMBBKP_UN_FULL = '77';   /* Codex #908: a unidade 77 é Full — a lista velha da A traz o 888 nela, e o expurgo (sem await) não pode rodar substituída */   /* a FASE 3 (sync dos conferidos) ligada, como na AMB */
const MANIFEST = path.join(dir, 'manifest.json'), CONFERIDOS = path.join(dir, 'conferidos.json');

/* o Bling de mentira: a lista de ATENDIDO pode ficar presa (promise sob controle); o resto responde vazio */
let presas = [];   /* fila de "segurar a próxima lista" — cada entrada é { resolve } */
let proximaLista = null;   /* a próxima lista de ATENDIDO (sem segurar) */
let presaUrl = null;       /* { re, resolve }: segura a próxima chamada que casar com `re` (o PATCH do Full, o PATCH do sync) */
const chamadas = [];
const resposta = (data) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data }), text: async () => JSON.stringify({ data }) });
const fake = async (url) => {
  const u = String(url); chamadas.push(u.slice(0, 100));
  if (/\/pedidos\/vendas\?/.test(u) && presas.length) { const p = presas.shift(); return new Promise((res) => { p.resolve = (data) => res(resposta(data)); }); }
  if (/\/pedidos\/vendas\?/.test(u) && proximaLista) { const d = proximaLista; proximaLista = null; return resposta(d); }
  const ok204 = { ok: true, status: 204, headers: { get: () => null }, json: async () => ({}), text: async () => '' };
  if (presaUrl && presaUrl.re.test(u)) {
    if (presaUrl.pular > 0) { presaUrl.pular--; }   /* deixa passar as N primeiras que casam (ex.: o detalhe que a LISTAGEM pede antes do cache) */
    else { const p = presaUrl; presaUrl = null; return new Promise((res) => { p.resolve = (data) => res(data === undefined ? ok204 : data === 'PDF' ? { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => Buffer.from('%PDF-1.4 danfe de mentira') } : resposta(data)); }); }
  }
  if (/\/situacoes\//.test(u)) return ok204;
  /* Codex P2-5 r2: o 555 responde um detalhe VÁLIDO — se A (substituída) chegar a buscá-lo, ela cacheia e o teste pega */
  if (/\/pedidos\/vendas\/555$/.test(u)) return resposta({ id: 555, numero: '555', situacao: { id: 9 }, loja: { id: 1 }, itens: [], transporte: {} });
  if (/\/nfe\/5$/.test(u)) return resposta({ id: 5, numero: '10', serie: '3', linkPDF: 'https://pdf.bling.test/danfe-5.pdf' });   /* a DANFE do pedido 555 (cenário 8) */
  if (/\/pedidos\/vendas\/888\/nfe$/.test(u)) return resposta({ id: 5, numero: '10', serie: '3' });   /* NF espelhada do marketplace: série ≠ 1 → Full confirmado */
  if (/\/pedidos\/vendas\/888$/.test(u)) return resposta({ id: 888, numero: '888', situacao: { id: 9 }, loja: { id: 1 }, itens: [], transporte: {} });
  return resposta([]);
};
const nf = require.resolve('node-fetch', { paths: [process.cwd()] }); require.cache[nf] = { id: nf, filename: nf, loaded: true, exports: fake }; global.fetch = fake;
const tm = require.resolve('../ambtotal/tokenManager'); require.cache[tm] = { id: tm, filename: tm, loaded: true, exports: { garantirToken: async () => 'tok', renovarToken: async () => 'tok' } };
const C = require('../amb-checkout-offline/ciclo.js');
const lerMan = () => { try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch (e) { return null; } };
const esperaMs = (ms) => new Promise((r) => setTimeout(r, ms));
const esperarPresa = async (p, nome) => { for (let i = 0; i < 400 && !p.resolve; i++) await esperaMs(25); assert.ok(p.resolve, nome); };
const _now = Date.now; let desloc = 0; Date.now = () => _now() + desloc;   /* o relógio do watchdog */

(async () => {
  const _log = console.log, _err = console.error; const logs = []; console.log = (...a) => logs.push(a.join(' ')); console.error = (...a) => logs.push(a.join(' '));
  let falhou = null;
  try {
    /* 0. um ciclo normal: resumo com geração 1, trava solta */
    let r = await C.rodarCiclo('t0');
    assert.ok(r.blingOk === true && r.geracao === 1 && r.substituidasPeloWatchdog === 0, 'ciclo normal: ' + JSON.stringify(r));
    assert.ok(lerMan() && Object.keys(lerMan()).length === 0, 'manifesto vazio gravado');

    /* 1. A pendura na lista do Bling; 16 min depois o cron chama B: o watchdog solta a trava e B roda inteiro.
       (Codex #908) A nasce com o Full 888 já no cache: quando acordar com a lista velha, o EXPURGO do Full — que roda sem
       nenhum await depois da lista — apagaria a pasta dele; só o portão logo depois da lista segura isso */
    const manA = { 888: { numero: '888', full_ml: true, tem_etiqueta: true } };
    fs.writeFileSync(MANIFEST, JSON.stringify(manA)); fs.mkdirSync(path.join(dir, '888'), { recursive: true }); fs.writeFileSync(path.join(dir, '888', 'pedido.json'), JSON.stringify({ id: 888, numero: '888', itens: [], marketplace: 'ml', full_ml: true }));
    const presaA = {}; presas.push(presaA);
    const pA = C.rodarCiclo('A');
    await esperaMs(30);
    assert.ok(presaA.resolve, 'A tinha que estar presa na lista do Bling');
    const puladoAntes = await C.rodarCiclo('cron-antes-do-watchdog');
    assert.strictEqual(puladoAntes.pulado, true, 'antes de 15 min o cron tem que ser pulado (A é a dona)');
    desloc = 16 * 60 * 1000;
    const rB = await C.rodarCiclo('B');
    assert.ok(rB.pulado !== true && rB.geracao === 3 && rB.substituidasPeloWatchdog === 1 && rB.blingOk === true, 'B tinha que rodar depois do watchdog com geração 3 (A era a 2): ' + JSON.stringify(rB));
    assert.ok(logs.some((l) => /WATCHDOG.*execu.*2 fica substitu/.test(l)), 'o log do watchdog tem que dizer que a execução 2 ficou substituída');
    const resumoB = C.getUltimoResumo();
    /* o estado que B deixou — e que a A antiga, ao acordar, teria motivo pra mexer em CADA fase: um Full na fila (o bloco do
       Full moveria pra DESPACHADOS), um conferido pendente (o sync moveria pra VERIFICADO) e um conferido velho já
       sincronizado (o purgarConferidos apagaria) */
    const manB = { 888: { numero: '888', full_ml: true, tem_etiqueta: true } };
    fs.writeFileSync(MANIFEST, JSON.stringify(manB));
    fs.mkdirSync(path.join(dir, '888'), { recursive: true }); fs.writeFileSync(path.join(dir, '888', 'pedido.json'), JSON.stringify({ id: 888, numero: '888', itens: [], marketplace: 'ml', full_ml: true }));
    const confB = { 999: { user: 'x', conferido_em: new Date().toISOString(), sincronizado: false, numero: '999' }, 111: { user: 'x', conferido_em: new Date(Date.now() - 40 * 86400000).toISOString(), sincronizado: true, numero: '111' } };
    fs.writeFileSync(CONFERIDOS, JSON.stringify(confB));
    const manDepoisDeB = JSON.stringify(lerMan());
    /* 2. A acorda com uma lista CHEIA (um pedido novo e o Full) — a foto antiga — e não pode gravar nada nem mexer no resumo */
    const chamadasAntes = chamadas.length;
    presaA.resolve([{ id: 555, numero: '555', situacao: { id: 9 }, loja: { id: 1 } }, { id: 888, numero: '888', situacao: { id: 9 }, loja: { id: 1, unidadeNegocio: { id: 77 } } }]);
    const rA = await pA;
    assert.strictEqual(JSON.stringify(lerMan()), manDepoisDeB, 'A (substituída) gravou o manifesto por cima do de B');
    assert.strictEqual(fs.readFileSync(CONFERIDOS, 'utf8'), JSON.stringify(confB), 'A (substituída) mexeu nos conferidos (sincronizou ou purgou)');
    assert.ok(!fs.existsSync(path.join(dir, '555')), 'A (substituída) não pode ter cacheado o pedido da lista velha');
    assert.ok(fs.existsSync(path.join(dir, '888', 'pedido.json')), 'A (substituída) expurgou do cache o Full 888 com a lista velha (Codex #908: o portão depois da lista)');
    /* (o GET do detalhe feito pela própria listarAtendidos é só leitura; o 555 tem detalhe VÁLIDO de propósito — se A seguisse, cachearia) */
    assert.ok(!fs.readdirSync(dir).some((n) => /^555/.test(n)), 'A (substituída) deixou rastro do 555 no cache');
    assert.strictEqual(C.getUltimoResumo(), resumoB, 'A (substituída) não pode sobrescrever o resumo de B');
    assert.strictEqual(rA, resumoB, 'A devolve o resumo que vale (o de B), não um resumo seu');
    assert.ok(logs.some((l) => /substituída pelo watchdog/.test(l)), 'A tinha que dizer no log que parou por estar substituída: ' + logs.slice(-5).join(' | '));
    assert.ok(!chamadas.slice(chamadasAntes).some((c) => /\/situacoes\//.test(c)), 'A (substituída) moveu pedido no Bling (Full → DESPACHADOS ou conferido → VERIFICADO): ' + chamadas.slice(chamadasAntes).filter((c) => /situacoes/.test(c)).join(' | '));
    /* a trava ficou LIVRE (B já terminou) — próximo cron roda normalmente, geração 4, e ELE (a dona) faz o que A não podia:
       move o Full, sincroniza o conferido pendente e purga o velho — prova de que as recusas acima eram do dono, não da falta
       do que fazer */
    desloc = 0;
    const antesC = chamadas.length; proximaLista = [{ id: 888, numero: '888', situacao: { id: 9 }, loja: { id: 1 } }];
    r = await C.rodarCiclo('C');
    assert.ok(r.pulado !== true && r.geracao === 4, 'depois de tudo o ciclo tem que seguir normal: ' + JSON.stringify(r));
    const movidosPorC = chamadas.slice(antesC).filter((c) => /\/situacoes\//.test(c));
    assert.ok(movidosPorC.some((c) => /\/888\/situacoes\/745123/.test(c)), 'a dona (C) tinha que mover o Full 888 pra DESPACHADOS: ' + movidosPorC.join(' | '));
    assert.ok(movidosPorC.some((c) => /\/999\/situacoes\/24/.test(c)), 'a dona (C) tinha que sincronizar o conferido 999 pra VERIFICADO: ' + movidosPorC.join(' | '));
    const confC = JSON.parse(fs.readFileSync(CONFERIDOS, 'utf8'));
    assert.ok(!confC[111] && confC[999] && confC[999].sincronizado === true, 'a dona (C) purga o conferido velho e marca o 999: ' + JSON.stringify(confC));

    /* 3. A antiga acorda ENQUANTO a nova ainda roda: não pode soltar a trava da nova */
    const presaD = {}; presas.push(presaD); const pD = C.rodarCiclo('D'); await esperaMs(20);
    desloc = 16 * 60 * 1000;
    const presaE = {}; presas.push(presaE); const pE = C.rodarCiclo('E'); await esperaMs(20);   /* E toma a trava (watchdog) e fica presa na lista dela */
    assert.ok(presaE.resolve, 'E tinha que estar rodando (presa na lista)');
    presaD.resolve([]); const rD = await pD;                                                   /* D acorda com E ainda rodando */
    const pulado = await C.rodarCiclo('F');
    assert.strictEqual(pulado.pulado, true, 'com E ainda rodando, o cron tem que ser PULADO — D (substituída) soltou a trava de E');
    assert.strictEqual(rD, C.getUltimoResumo(), 'D não escreve resumo próprio');
    presaE.resolve([]); const rE = await pE;
    assert.ok(rE.geracao === 6 && rE.substituidasPeloWatchdog === 2, 'E termina como dona, geração 6, 2 substituídas: ' + JSON.stringify(rE));
    desloc = 0;
    r = await C.rodarCiclo('G'); assert.ok(r.pulado !== true && r.geracao === 7, 'depois de E a trava está livre: ' + JSON.stringify(r));

    /* 5. substituída NO MEIO do move do Full: A é dona até o PATCH do Full, que fica preso; o watchdog passa a trava a B;
       quando o PATCH volta, A NÃO pode seguir pro sync (o 999 pendente ficaria VERIFICADO com a foto velha) nem gravar */
    { fs.writeFileSync(MANIFEST, JSON.stringify(manB)); fs.writeFileSync(CONFERIDOS, JSON.stringify(confB)); fs.mkdirSync(path.join(dir, '888'), { recursive: true }); fs.writeFileSync(path.join(dir, '888', 'pedido.json'), JSON.stringify({ id: 888, numero: '888', itens: [], marketplace: 'ml', full_ml: true }));
      proximaLista = [{ id: 888, numero: '888', situacao: { id: 9 }, loja: { id: 1 } }]; const presa = { re: /\/888\/situacoes\/745123/ }; presaUrl = presa;
      const pA2 = C.rodarCiclo('A2'); await esperarPresa(presa, 'A2 tinha que estar presa no PATCH do Full');
      desloc = 16 * 60 * 1000; const rB2 = await C.rodarCiclo('B2'); assert.ok(rB2.pulado !== true && rB2.substituidasPeloWatchdog === 3, 'B2 roda pelo watchdog: ' + JSON.stringify(rB2));
      /* B2 (dona) já sincronizou e purgou o que havia; re-semeia o que a A2 antiga encontraria ao acordar */
      fs.writeFileSync(CONFERIDOS, JSON.stringify(confB)); const confSemeado = fs.readFileSync(CONFERIDOS, 'utf8');
      const manDepoisB2 = fs.readFileSync(MANIFEST, 'utf8'); const antes2 = chamadas.length;
      presa.resolve(); await pA2;
      assert.ok(!chamadas.slice(antes2).some((c) => /\/999\/situacoes\/24/.test(c)), 'A2 (substituída no meio do Full) sincronizou o conferido 999 — o portão antes do sync não segurou');
      assert.strictEqual(fs.readFileSync(MANIFEST, 'utf8'), manDepoisB2, 'A2 gravou o manifesto depois de substituída');
      assert.strictEqual(fs.readFileSync(CONFERIDOS, 'utf8'), confSemeado, 'A2 mexeu nos conferidos (sync/purga) depois de substituída');
      desloc = 0; }
    /* 6. substituída NO MEIO do sync: A é dona até o PATCH do conferido, que fica preso; B assume; quando o PATCH volta, A
       não pode purgar os conferidos nem gravar o manifesto final */
    { fs.writeFileSync(MANIFEST, JSON.stringify({})); fs.writeFileSync(CONFERIDOS, JSON.stringify(confB)); try { fs.rmSync(path.join(dir, '888'), { recursive: true, force: true }); } catch (e) {}
      const presa = { re: /\/999\/situacoes\/24/ }; presaUrl = presa;
      const pA3 = C.rodarCiclo('A3'); await esperarPresa(presa, 'A3 tinha que estar presa no PATCH do sync');
      desloc = 16 * 60 * 1000; const rB3 = await C.rodarCiclo('B3'); assert.ok(rB3.pulado !== true && rB3.substituidasPeloWatchdog === 4, 'B3 roda pelo watchdog: ' + JSON.stringify(rB3));
      /* B3 (dona) purgou o 111; re-semeia um velho já sincronizado — se A3 acordar e purgar, ele some */
      const conf3 = JSON.parse(fs.readFileSync(CONFERIDOS, 'utf8')); conf3[222] = { user: 'x', conferido_em: new Date(Date.now() - 40 * 86400000).toISOString(), sincronizado: true, numero: '222' }; fs.writeFileSync(CONFERIDOS, JSON.stringify(conf3));
      const manDepoisB3 = fs.readFileSync(MANIFEST, 'utf8');
      presa.resolve(); await pA3;
      assert.ok(JSON.parse(fs.readFileSync(CONFERIDOS, 'utf8'))[222], 'A3 (substituída no meio do sync) purgou o conferido velho — o portão antes do manifesto final não segurou');
      assert.strictEqual(fs.readFileSync(MANIFEST, 'utf8'), manDepoisB3, 'A3 gravou o manifesto final depois de substituída');
      assert.strictEqual(C.getUltimoResumo(), rB3, 'A3 escreveu o resumo depois de substituída');
      desloc = 0; }
    /* 7. (Codex #908) substituída NO MEIO do detalhe de um pedido NOVO: A passou pela lista como dona e está presa no
       GET /pedidos/vendas/555 do CACHE (a listagem já pediu o detalhe uma vez, pra decidir Full/série — a presa é o 2º);
       o watchdog passa a trava a B; quando o detalhe volta, A NÃO pode cachear o 555 nem gravar o manifesto — é o portão
       depois de CADA await, não só o da lista */
    { fs.writeFileSync(MANIFEST, JSON.stringify({})); fs.writeFileSync(CONFERIDOS, JSON.stringify({})); try { fs.rmSync(path.join(dir, '555'), { recursive: true, force: true }); } catch (e) {}
      proximaLista = [{ id: 555, numero: '555', situacao: { id: 9 }, loja: { id: 1 } }];
      const presa = { re: /\/pedidos\/vendas\/555$/, pular: 1 }; presaUrl = presa;
      const pA4 = C.rodarCiclo('A4'); await esperarPresa(presa, 'A4 tinha que estar presa no detalhe do pedido 555 (o do cache)');
      assert.ok(!fs.existsSync(path.join(dir, '555')), 'antes do detalhe voltar não há cache do 555');
      desloc = 16 * 60 * 1000; proximaLista = []; const rB4 = await C.rodarCiclo('B4'); assert.ok(rB4.pulado !== true && rB4.substituidasPeloWatchdog === 5, 'B4 roda pelo watchdog: ' + JSON.stringify(rB4));
      const manDepoisB4 = fs.readFileSync(MANIFEST, 'utf8'); const antes4 = chamadas.length;
      presa.resolve({ id: 555, numero: '555', numeroLoja: 'L555', situacao: { id: 9 }, loja: { id: 1 }, itens: [{ codigo: 'SKU-1', descricao: 'p', quantidade: 1, valor: 10 }], transporte: {}, contato: { nome: 'x' } }); const rA4 = await pA4;
      assert.ok(!fs.existsSync(path.join(dir, '555')), 'A4 (substituída no meio do detalhe) cacheou o pedido 555 com a lista velha — falta o portão depois do await do detalhe');
      assert.strictEqual(fs.readFileSync(MANIFEST, 'utf8'), manDepoisB4, 'A4 gravou o manifesto depois de substituída');
      assert.strictEqual(rA4, rB4, 'A4 devolve o resumo da dona');
      assert.ok(!chamadas.slice(antes4).some((c) => /\/situacoes\//.test(c)), 'A4 moveu pedido no Bling depois de substituída');
      desloc = 0; }
    /* 8. (Codex #908) substituída NO MEIO de um passo final: o 555 já está no cache com NF e sem DANFE; A passa pela lista e
       pelo portão do começo do laço da DANFE como dona, e fica presa baixando o PDF; B assume; quando o PDF chega, A NÃO
       pode gravar o danfe.pdf nem marcar tem_danfe — o portão tem que vir DEPOIS do await, não só no começo da volta */
    { const snap555 = { id: 555, numero: '555', itens: [], marketplace: 'ml', nf: { id: 5, numero: '10' } };
      /* já cacheado com etiqueta e no schema atual → não reprocessa (o casamento de NF não roda) — só falta a DANFE */
      const SCHEMA_ATUAL = require('../amb-checkout-offline/base').SCHEMA;
      fs.writeFileSync(MANIFEST, JSON.stringify({ 555: { numero: '555', tem_etiqueta: true, schema: SCHEMA_ATUAL, cacheado_em: new Date().toISOString() } }));   /* com data: sem ela o purgar lê "0" como ano 2000 e apaga */ fs.writeFileSync(CONFERIDOS, JSON.stringify({}));
      fs.mkdirSync(path.join(dir, '555'), { recursive: true }); fs.writeFileSync(path.join(dir, '555', 'pedido.json'), JSON.stringify(snap555)); try { fs.unlinkSync(path.join(dir, '555', 'danfe.pdf')); } catch (e) {}
      proximaLista = [{ id: 555, numero: '555', situacao: { id: 9 }, loja: { id: 1 } }];
      const presa = { re: /^https:\/\/pdf\.bling\.test\/danfe-5\.pdf$/ }; presaUrl = presa;
      const pA5 = C.rodarCiclo('A5'); await esperarPresa(presa, 'A5 tinha que estar presa baixando a DANFE do 555');
      desloc = 16 * 60 * 1000; proximaLista = [{ id: 555, numero: '555', situacao: { id: 9 }, loja: { id: 1 } }];   /* B5 vê o 555 também (senão purga o cache dele, legitimamente) */
      const rB5 = await C.rodarCiclo('B5');
      assert.ok(fs.existsSync(path.join(dir, '555', 'pedido.json')) && !fs.existsSync(path.join(dir, '555', 'danfe.pdf')), 'B5 (dona) mantém o 555 e, sem PDF de verdade, não grava DANFE'); assert.ok(rB5.pulado !== true && rB5.substituidasPeloWatchdog === 6, 'B5 roda pelo watchdog: ' + JSON.stringify(rB5));
      const manDepoisB5 = fs.readFileSync(MANIFEST, 'utf8');
      presa.resolve('PDF'); const rA5 = await pA5;
      assert.ok(!fs.existsSync(path.join(dir, '555', 'danfe.pdf')), 'A5 (substituída no meio da baixa da DANFE) gravou o danfe.pdf — falta o portão depois do await');
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, '555', 'pedido.json'), 'utf8')).tem_danfe, undefined, 'A5 marcou tem_danfe depois de substituída');
      assert.strictEqual(fs.readFileSync(MANIFEST, 'utf8'), manDepoisB5, 'A5 gravou o manifesto depois de substituída');
      assert.strictEqual(rA5, rB5, 'A5 devolve o resumo da dona');
      desloc = 0; }
    /* 4. sem watchdog, nada muda: a execução dona segue gravando normalmente (o manifesto ganha o pedido) */
    const presaH = {}; presas.push(presaH); const pH = C.rodarCiclo('H'); await esperaMs(20);
    presaH.resolve([{ id: 777, numero: '777', situacao: { id: 9 }, loja: { id: 1 } }]);
    const rH = await pH;
    assert.ok(rH.geracao === 16 && rH.total === 1 && lerMan() && lerMan()['777'], 'a dona grava o pedido 777 no manifesto: ' + JSON.stringify(rH) + ' ' + JSON.stringify(lerMan()));
  } catch (e) { falhou = e; }
  finally { console.log = _log; console.error = _err; Date.now = _now; clearTimeout(vigia); }
  if (falhou) { console.error('FALHOU:', falhou.stack || falhou.message); process.exit(1); }
  console.log('ok — ciclo com dono: o watchdog passa a trava adiante e a execução substituída, ao acordar, não grava manifesto, não cacheia a lista velha, não move no Bling, não escreve resumo nem solta a trava da nova; a dona segue gravando; geração e substituídas no resumo');
  process.exit(0);
})();
