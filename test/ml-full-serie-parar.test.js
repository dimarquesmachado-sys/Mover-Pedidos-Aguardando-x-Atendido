'use strict';
// b7 — a serie PARA quando o dono pede (&parar=1). Com a retomada automatica do
// b6, nem um deploy a parava: rodando de madrugada e invadindo o horario do galpao,
// nao havia botao. Exercita pararSerie e iniciarSerie DE PRODUCAO com varrerLote
// falso e sleep que nao espera.
const fs = require('fs');
const os = require('os');
const path = require('path');
let falhas = 0;
const ok = (c, o) => { if (!c) falhas++; console.log((c ? 'ok  ' : 'FALHA ') + o); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-full-parar-'));
process.env.ML_FULL_DIR = dir;
delete require.cache[require.resolve('../ml-full.js')];
const mf = require('../ml-full.js');
const I = mf._interno;
const esperarFim = async (e) => { for (let i = 0; i < 4000 && I._serie[e] && I._serie[e].rodando; i++) await new Promise((r) => setImmediate(r)); return I._serie[e]; };
I._serieDeps.sleep = () => Promise.resolve();

(async () => {
  ok(typeof I.pararSerie === 'function', '  pararSerie exportada pra teste');
  // ── 1) parar no meio: a serie para depois do pedaco atual, completa:false, parada no disco ──
  {
    let chamadas = 0;
    I._serieDeps.varrerLote = async () => {
      chamadas++;
      if (chamadas === 2) I.pararSerie('girassol');   // o dono pede parada enquanto o 2o pedaco roda
      return { ok: true, ja_no_bling: 1, pendentes_novas: 0, nao_conferidas: 0, novas: [] };
    };
    I.iniciarSerie('girassol', '20260101', '20260110', { passo: 2, teto: 60, respiroS: 0 });   // 5 pedacos
    const st = await esperarFim('girassol');
    ok(chamadas === 2, `⚠️ parou DEPOIS do pedaco atual: 2 chamadas de 5 (${chamadas})`);
    ok(st.parada_pelo_dono === true && st.completa === false, '⚠️ parada_pelo_dono e completa:false (nao "completa" so porque os 2 feitos fecharam)');
    const disco = I._lerSerieDoDisco('girassol');
    ok(disco && disco.parada_pelo_dono && !disco.interrompida, '  no disco: parada, NAO interrompida');
    ok(I.retomarSeriesInterrompidas().length === 0, '⚠️ o boot NAO retoma a serie parada pelo dono');
  }
  // ── 2) parar durante a espera entre passadas ──
  {
    let chamadas = 0;
    I._serieDeps.varrerLote = async () => { chamadas++; return { ok: true, ja_no_bling: 1, pendentes_novas: 0, nao_conferidas: 2, novas: [] }; };   // nunca fecha
    I._serieDeps.sleep = async (ms) => { if (ms >= 60000) I.pararSerie('amb'); };   // pede parada na espera da passada 2
    I.iniciarSerie('amb', '20260101', '20260104', { passo: 2, teto: 60, respiroS: 0 });   // 2 pedacos
    const st = await esperarFim('amb');
    ok(chamadas === 2 && st.parada_pelo_dono === true && st.completa === false, `  parada na espera entre passadas: nao inicia a passada 2 (${chamadas} chamadas)`);
    I._serieDeps.sleep = () => Promise.resolve();
  }
  // ── 3) o processo morreu com a parada PEDIDA mas nao honrada: e parada, nao interrompida ──
  {
    I._salvarSerie('good', { rodando: true, parar: true, janela: { de: '20260101', ate: '20260110' }, passo: 2, resultados: [{ de: '20260101', ate: '20260102', ok: true, nao_conferidas: 0 }] });
    delete I._serie.good;
    const j = I._lerSerieDoDisco('good');
    ok(j && j.parada_pelo_dono && !j.interrompida && !j.rodando, '⚠️ disco com rodando+parar (processo morreu antes de honrar): lido como PARADA');
    ok(I.retomarSeriesInterrompidas().length === 0, '  ... e o boot nao retoma');
  }
  // ── 4) parar uma serie INTERROMPIDA esperando a retomada do boot ──
  {
    I._salvarSerie('good', { rodando: true, janela: { de: '20260101', ate: '20260110' }, passo: 2, teto: 60, respiro_s: 0, resultados: [{ de: '20260101', ate: '20260102', ok: true, nao_conferidas: 0 }] });
    delete I._serie.good;
    ok(I._lerSerieDoDisco('good').interrompida === true, '  (pre) serie interrompida no disco');
    const r = I.pararSerie('good');
    ok(r.resultado === 'retomada_cancelada', '⚠️ parar uma interrompida cancela a retomada do boot');
    ok(I.retomarSeriesInterrompidas().length === 0 && I._lerSerieDoDisco('good').parada_pelo_dono, '  ... e o boot nao retoma');
  }
  // ── 5) nada rodando ──
  {
    try { fs.unlinkSync(I._arqSerie('amb')); } catch (e) {}
    delete I._serie.amb;
    ok(I.pararSerie('amb').resultado === 'nada_rodando', '  nada rodando: nada_rodando');
  }
  // ── 6) (b6, consertado aqui) erro no MEIO: completa nao pode virar true so porque os processados fecharam ──
  {
    let chamadas = 0;
    I._serieDeps.varrerLote = async () => { chamadas++; if (chamadas === 2) throw new Error('explodiu'); return { ok: true, ja_no_bling: 1, pendentes_novas: 0, nao_conferidas: 0, novas: [] }; };
    I.iniciarSerie('girassol', '20260201', '20260210', { passo: 2, teto: 60, respiroS: 0 });
    const st = await esperarFim('girassol');
    ok(st.erro && st.completa === false, `⚠️ erro no 2o de 5 pedacos: completa:false (antes virava true — so olhava os processados)`);
  }
  // ── a rota existe ──
  const src = fs.readFileSync(path.join(__dirname, '..', 'ml-full.js'), 'utf8');
  ok(/searchParams\.get\('parar'\) === '1'/.test(src) && /\.\.\.pararSerie\(empresa\)/.test(src), '  rota &parar=1');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  console.log('');
  console.log(falhas === 0 ? '=== TODOS OS CASOS PASSARAM' : '=== ' + falhas + ' FALHA(S)');
  process.exit(falhas ? 1 : 0);
})();
