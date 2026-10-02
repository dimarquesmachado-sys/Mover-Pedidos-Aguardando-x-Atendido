'use strict';
// b6 — A SERIE SE CUIDA SOZINHA: refaz em passadas os pedacos que nao fecharam
// (cota/429/transitorio), e um reinicio no meio e retomado no boot. Pedido do
// dono (02/10): "faz um jeito de chamar o ano todo, e se der erro, ja dar retry
// automatico de onde parou". Exercita iniciarSerie DE PRODUCAO com varrerLote
// falso e sleep que nao espera.
const fs = require('fs');
const os = require('os');
const path = require('path');
let falhas = 0;
const ok = (c, o) => { if (!c) falhas++; console.log((c ? 'ok  ' : 'FALHA ') + o); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-full-serie-auto-'));
process.env.ML_FULL_DIR = dir;
delete require.cache[require.resolve('../ml-full.js')];
const mf = require('../ml-full.js');
const I = mf._interno;
const esperarFim = async (empresa) => { for (let i = 0; i < 2000 && I._serie[empresa] && I._serie[empresa].rodando; i++) await new Promise((r) => setImmediate(r)); return I._serie[empresa]; };
I._serieDeps.sleep = () => Promise.resolve();   // nao espera de verdade

(async () => {
  // ── 1) pedaco que fica com nao_conferidas na passada 1 fecha na passada 2 ──
  {
    const chamadas = [];
    I._serieDeps.varrerLote = async (emp, de, ate) => {
      chamadas.push(de + '→' + ate);
      const vez = chamadas.filter((c) => c === de + '→' + ate).length;
      if (de === '20260103' && vez === 1) return { ok: true, ja_no_bling: 2, pendentes_novas: 0, nao_conferidas: 4, novas: [] };   // cota no meio
      return { ok: true, ja_no_bling: 3, pendentes_novas: 1, nao_conferidas: 0, novas: ['x'] };
    };
    const r = I.iniciarSerie('girassol', '20260101', '20260106', { passo: 2, teto: 60, respiroS: 0 });
    ok(r.ok && r.iniciada && r.pedacos.length === 3 && /refeitos sozinhos/.test(r.mensagem), '  3 pedacos, mensagem diz que refaz sozinho');
    ok(I.iniciarSerie('girassol', '20260101', '20260102', {}).resultado === 'ja_ha_serie_em_andamento', '  2a serie da mesma empresa enquanto roda: ja_ha_serie_em_andamento');
    const st = await esperarFim('girassol');
    ok(st.completa === true && st.passada === 2, `⚠️ pedaco com cota na passada 1 foi REFEITO na passada 2 e a serie fechou COMPLETA (passada ${st.passada})`);
    ok(st.resultados.length === 3 && st.fechados === 3 && st.pedacos_nao_fechados.length === 0, '  3 resultados (o refeito SUBSTITUIU, nao duplicou), 3 fechados');
    ok(chamadas.length === 4, `  4 chamadas ao varrerLote: 3 na passada 1 + so o pendente na passada 2 (${chamadas.length})`);
    ok(st.total_ja_no_bling === 9 && st.total_pendentes_novas === 3 && st.total_nao_conferidas === 0, `  totais RECONTADOS (nao somados 2x): ja_no_bling ${st.total_ja_no_bling}, pendentes ${st.total_pendentes_novas}, nao conferidas ${st.total_nao_conferidas}`);
    const disco = I._lerSerieDoDisco('girassol');
    ok(disco && disco.completa === true && !disco.interrompida, '  no disco: completa, nao interrompida');
  }
  // ── 2) pedaco que falha SEMPRE: para no teto de passadas, declarado ──
  {
    I._serieDeps.varrerLote = async (emp, de) => (de === '20260103' ? { ok: false, resultado: 'lote_400' } : { ok: true, ja_no_bling: 1, pendentes_novas: 0, nao_conferidas: 0, novas: [] });
    I.iniciarSerie('amb', '20260101', '20260106', { passo: 2, teto: 60, respiroS: 0 });
    const st = await esperarFim('amb');
    ok(st.completa === false && st.passada === I.MAX_PASSADAS && st.pedacos_nao_fechados.length === 1 && st.pedacos_nao_fechados[0] === '20260103→20260104',
       `⚠️ falha deterministica: ${I.MAX_PASSADAS} passadas e para, DECLARANDO o pedaco nao fechado (nao gira pra sempre)`);
    ok(st.resultados.length === 3, '  3 resultados (nao acumula entradas repetidas do falho)');
  }
  // ── 3) RETOMADA NO BOOT: serie morta no disco com 1 de 3 fechado ──
  {
    delete I._serie.good;
    I._salvarSerie('good', { rodando: true, janela: { de: '20260101', ate: '20260106' }, passo: 2, teto: 60, respiro_s: 0,
      resultados: [{ de: '20260101', ate: '20260102', ok: true, nao_conferidas: 0 }] });
    const chamadas = [];
    I._serieDeps.varrerLote = async (emp, de, ate) => { chamadas.push(de + '→' + ate); return { ok: true, ja_no_bling: 1, pendentes_novas: 0, nao_conferidas: 0, novas: [] }; };
    const feitas = I.retomarSeriesInterrompidas();
    ok(feitas.length === 1 && feitas[0].empresa === 'good' && feitas[0].a_partir_de === '20260103' && feitas[0].de === '20260101' && feitas[0].ate === '20260106', '⚠️ boot: a serie morta da GOOD foi RETOMADA (janela original 01→06, a partir do dia seguinte ao ultimo fechado, 03)');
    const st = await esperarFim('good');
    // Codex #565 (P2): a retomada relanca a JANELA ORIGINAL carregando os fechados — status completo, nao encurtado
    ok(st.completa === true && st.janela.de === '20260101' && st.janela.ate === '20260106' && st.pedacos === 3 && st.resultados.length === 3 && chamadas.length === 2,
       `⚠️ retomada: janela ORIGINAL (${st.janela.de}→${st.janela.ate}), ${st.pedacos} pedacos, ${st.resultados.length} resultados (1 previo + 2 refeitos), so ${chamadas.length} chamadas ao Bling`);
    ok(st.retomada && st.retomada.pedacos_ja_fechados === 1 && /reinicio/.test(st.retomada.motivo), '  o status diz que foi retomada e quantos ja estavam fechados');
    ok(st.total_ja_no_bling === 2, `  totais RECONTADOS com os previos (o previo nao tinha ja_no_bling; os 2 refeitos tem 1 cada = ${st.total_ja_no_bling})`);
    ok(I.retomarSeriesInterrompidas().length === 0, '  2o boot: nada a retomar (a serie terminou)');
    // serie morta com TUDO fechado: marca no disco e nao relanca
    I._salvarSerie('amb', { rodando: true, janela: { de: '20260101', ate: '20260102' }, passo: 2, resultados: [{ de: '20260101', ate: '20260102', ok: true, nao_conferidas: 0 }] });
    delete I._serie.amb;
    ok(I.retomarSeriesInterrompidas().length === 0 && I._lerSerieDoDisco('amb').completa === true && !I._lerSerieDoDisco('amb').interrompida, '  serie morta ja completa: marcada no disco, nao relanca');
    // Codex #565 (P2): morreu ANTES do 1o pedaco fechar (resultados vazios) — retoma do INICIO, nao fica abandonada
    delete I._serie.good;
    I._salvarSerie('good', { rodando: true, janela: { de: '20260101', ate: '20260104' }, passo: 2, teto: 60, respiro_s: 0, resultados: [] });
    const lidoVazio = I._lerSerieDoDisco('good');
    ok(lidoVazio.interrompida && lidoVazio.retomar_de === '20260101', '⚠️ morta sem nenhum pedaco fechado: retomar_de = inicio original (antes ficava null e o boot pulava pra sempre)');
    const chamadas2 = [];
    I._serieDeps.varrerLote = async (emp, de, ate) => { chamadas2.push(de); return { ok: true, ja_no_bling: 0, pendentes_novas: 0, nao_conferidas: 0, novas: [] }; };
    ok(I.retomarSeriesInterrompidas().length === 1, '  e o boot a relanca');
    await esperarFim('good');
    ok(chamadas2.length === 2 && I._serie.good.completa === true, '  ... do inicio: 2 pedacos feitos');
    // Codex #565 (P2): morreu ESPERANDO a proxima passada — o boot respeita o backoff persistido (agenda, nao relanca na hora)
    delete I._serie.amb;
    const futuro = new Date(Date.now() + 20 * 60000).toISOString();
    I._salvarSerie('amb', { rodando: true, janela: { de: '20260101', ate: '20260102' }, passo: 2, teto: 60, respiro_s: 0, proxima_passada_em: futuro, resultados: [{ de: '20260101', ate: '20260102', ok: true, nao_conferidas: 3 }] });
    const f2 = I.retomarSeriesInterrompidas();
    ok(f2.length === 1 && f2[0].agendada_para === futuro && !(I._serie.amb && I._serie.amb.rodando), '⚠️ backoff persistido (proxima passada daqui a 20 min): a retomada e AGENDADA pra esse instante, nao disparada agora');
    // Codex #565 (P2): a falha retem detalhe/detalheRetry
    delete I._serie.girassol;
    I._serieDeps.varrerLote = async () => ({ ok: false, resultado: 'erro_lote_400', detalhe: 'corpo da API: invalid date range', detalheRetry: null });
    I.iniciarSerie('girassol', '20260101', '20260102', { passo: 2, teto: 60, respiroS: 0 });
    const stF = await esperarFim('girassol');
    ok(stF.resultados[0].detalhe === 'corpo da API: invalid date range', '⚠️ falha deterministica: o detalhe da API fica no checkpoint (diagnostico apos as 6 passadas)');
  }
  // ── Codex #565 r2: os 4 ──
  {
    // (1) Retry-After maior que a espera da passada: a proxima passada espera o Retry-After
    delete I._serie.girassol;
    const esperas = [];
    I._serieDeps.sleep = async (ms) => { esperas.push(ms); };
    let vez = 0;
    I._serieDeps.varrerLote = async () => (++vez <= 3 ? { ok: false, resultado: 'transitorio_tente_de_novo', retryAfterS: 900, retry_after_s: 900 } : { ok: true, ja_no_bling: 1, pendentes_novas: 0, nao_conferidas: 0, novas: [] });
    I.iniciarSerie('girassol', '20260101', '20260102', { passo: 2, teto: 60, respiroS: 0 });
    const stR = await esperarFim('girassol');
    ok(stR.completa === true && esperas.includes(900 * 1000), `⚠️ Retry-After de 900s > espera da passada 2 (120s): esperou os 900s (${esperas.filter((x) => x >= 900000).length}x)`);
    I._serieDeps.sleep = () => Promise.resolve();
    // (4) pendentes = novas + ja_baixadas: a passada 2 ve os XMLs da passada 1 como ja_baixadas — o total nao zera
    delete I._serie.amb;
    let v2 = 0;
    I._serieDeps.varrerLote = async () => (++v2 === 1 ? { ok: true, ja_no_bling: 0, pendentes_novas: 3, nao_conferidas: 2, novas: ['a', 'b', 'c'] } : { ok: true, ja_no_bling: 0, pendentes_novas: 0, ja_baixadas: 3, nao_conferidas: 0, novas: [] });
    I.iniciarSerie('amb', '20260101', '20260102', { passo: 2, teto: 60, respiroS: 0 });
    const stP = await esperarFim('amb');
    ok(stP.completa === true && stP.total_pendentes_novas === 3, `⚠️ passada 2 reportou os 3 XMLs como ja_baixadas: total_pendentes continua 3 (${stP.total_pendentes_novas}), nao zera com arquivo a importar`);
    // (3) retomada carrega TODOS os previos (inclusive o falho): checkpoint sem lacuna
    delete I._serie.good;
    I._salvarSerie('good', { rodando: true, comecou: 'C1', janela: { de: '20260101', ate: '20260106' }, passo: 2, teto: 60, respiro_s: 0,
      resultados: [{ de: '20260101', ate: '20260102', ok: false, resultado: 'lote_400' }, { de: '20260103', ate: '20260104', ok: true, nao_conferidas: 0 }, { de: '20260105', ate: '20260106', ok: true, nao_conferidas: 0 }] });
    I._serieDeps.varrerLote = async () => { throw new Error('nao deveria chegar: o teste le o checkpoint INICIAL da retomada'); };
    const feitasG = I.retomarSeriesInterrompidas();
    const disco0 = JSON.parse(fs.readFileSync(path.join(dir, 'ml-full-serie-good.json'), 'utf8'));
    ok(feitasG.length === 1 && disco0.resultados.length === 3 && disco0.resultados[0].ok === false, '⚠️ checkpoint inicial da retomada tem os 3 previos (inclusive o FALHO): um 2o reinicio nao pula o pedaco 1');
    await esperarFim('good');
    // (2) resume AGENDADO revalida: outra serie rodou e terminou antes do timer -> cancela
    delete I._serie.amb;
    const fut = new Date(Date.now() + 10 * 60000).toISOString();
    I._salvarSerie('amb', { rodando: true, comecou: 'VELHA', janela: { de: '20260101', ate: '20260102' }, passo: 2, teto: 60, respiro_s: 0, proxima_passada_em: fut, resultados: [{ de: '20260101', ate: '20260102', ok: true, nao_conferidas: 2 }] });
    let timerCb = null; const _st = global.setTimeout;
    global.setTimeout = (fn, ms) => { if (ms > 60000) { timerCb = fn; return { unref() {} }; } return _st(fn, ms); };
    I.retomarSeriesInterrompidas();
    global.setTimeout = _st;
    // enquanto o timer esperava, o operador rodou OUTRA serie da amb que terminou
    I._salvarSerie('amb', { rodando: false, comecou: 'NOVA', terminou: 'x', janela: { de: '20260201', ate: '20260202' }, resultados: [{ de: '20260201', ate: '20260202', ok: true, nao_conferidas: 0 }], completa: true });
    let lancou = false;
    I._serieDeps.varrerLote = async () => { lancou = true; return { ok: true, ja_no_bling: 0, pendentes_novas: 0, nao_conferidas: 0, novas: [] }; };
    const _dn = Date.now; Date.now = () => _dn() + 11 * 60000;   // o prazo persistido ja passou quando o timer dispara
    if (timerCb) timerCb();
    Date.now = _dn;
    await new Promise((r) => setTimeout(r, 30));
    ok(timerCb && !lancou && !(I._serie.amb && I._serie.amb.rodando), '⚠️ resume agendado, mas outra serie rodou antes do timer: CANCELADO (nao sobrescreve o checkpoint novo)');
    // Codex #565 r3 (P2): backoff persistido > 1h: a 1a fatia de 1h NAO relanca — reagenda ate o prazo
    delete I._serie.amb;
    const longe = new Date(Date.now() + 3 * 3600000).toISOString();
    I._salvarSerie('amb', { rodando: true, comecou: 'LONGE', janela: { de: '20260101', ate: '20260102' }, passo: 2, teto: 60, respiro_s: 0, proxima_passada_em: longe, resultados: [{ de: '20260101', ate: '20260102', ok: true, nao_conferidas: 2 }] });
    const timers = []; const _st2 = global.setTimeout;
    global.setTimeout = (fn, ms) => { if (ms > 60000) { timers.push({ fn, ms }); return { unref() {} }; } return _st2(fn, ms); };
    I.retomarSeriesInterrompidas();
    let lancou2 = false;
    I._serieDeps.varrerLote = async () => { lancou2 = true; return { ok: true, ja_no_bling: 0, pendentes_novas: 0, nao_conferidas: 0, novas: [] }; };
    timers[0].fn();   // dispara a 1a fatia (1h) com o prazo ainda a ~2h
    global.setTimeout = _st2;
    await new Promise((r) => setTimeout(r, 30));
    ok(timers[0].ms === 3600000 && timers.length === 2 && !lancou2, '⚠️ backoff de 3h: a fatia de 1h dispara e REAGENDA (nao relanca antes do prazo persistido)');
    // Codex #565 r3 (P2): o orcamento de passadas atravessa o reinicio
    delete I._serie.good;
    I._salvarSerie('good', { rodando: true, comecou: 'P6', janela: { de: '20260101', ate: '20260102' }, passo: 2, teto: 60, respiro_s: 0, passada: I.MAX_PASSADAS, resultados: [{ de: '20260101', ate: '20260102', ok: false, resultado: 'lote_400' }] });
    let n6 = 0;
    I._serieDeps.varrerLote = async () => { n6++; return { ok: false, resultado: 'lote_400' }; };
    I.retomarSeriesInterrompidas();
    await esperarFim('good');
    ok(n6 === 1 && I._serie.good.passada === I.MAX_PASSADAS && I._serie.good.completa === false, `⚠️ morreu na passada ${I.MAX_PASSADAS}: a retomada faz so ESSA passada (${n6} chamada), nao mais ${I.MAX_PASSADAS}`);
  }
  // ── o index.js chama no boot ──
  const idx = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  ok(/require\('\.\/ml-full'\)\.retomarSeriesInterrompidas\(\)/.test(idx) && /7 \* 60000/.test(idx), '  index.js: retomada 7 min apos o boot');
  ok(typeof mf.retomarSeriesInterrompidas === 'function', '  exportada no modulo');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  console.log('');
  console.log(falhas === 0 ? '=== TODOS OS CASOS PASSARAM' : '=== ' + falhas + ' FALHA(S)');
  process.exit(falhas ? 1 : 0);
})();
