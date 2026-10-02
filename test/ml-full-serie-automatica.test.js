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
    ok(feitas.length === 1 && feitas[0].empresa === 'good' && feitas[0].de === '20260103' && feitas[0].ate === '20260106', '⚠️ boot: a serie morta da GOOD foi RETOMADA do dia seguinte ao ultimo fechado (20260103) ate o ate ORIGINAL');
    const st = await esperarFim('good');
    ok(st.completa === true && st.retomada_de === '20260101' && chamadas.length === 2, `  retomada fechou os 2 pedacos que faltavam (${chamadas.length} chamadas) e lembra o de ORIGINAL (${st.retomada_de})`);
    ok(I.retomarSeriesInterrompidas().length === 0, '  2o boot: nada a retomar (a serie terminou)');
    // serie morta com TUDO fechado: marca no disco e nao relanca
    I._salvarSerie('amb', { rodando: true, janela: { de: '20260101', ate: '20260102' }, passo: 2, resultados: [{ de: '20260101', ate: '20260102', ok: true, nao_conferidas: 0 }] });
    delete I._serie.amb;
    ok(I.retomarSeriesInterrompidas().length === 0 && I._lerSerieDoDisco('amb').completa === true && !I._lerSerieDoDisco('amb').interrompida, '  serie morta ja completa: marcada no disco, nao relanca');
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
