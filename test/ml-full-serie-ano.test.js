'use strict';
// A serie encadeada do motor ML Full aceita ate UM ANO (era 31 dias). Pedido do
// dono (02/10): "temos como fazer essa puxada da Girassol do ano todo?". O teto
// segurava so a duracao; pedacos, retry e respiro ja aguentam. Serie longa vive
// em memoria: a resposta AVISA que deploy/reinicio no meio interrompe.
const fs = require('fs');
const path = require('path');
let falhas = 0;
const ok = (c, o) => { if (!c) falhas++; console.log((c ? 'ok  ' : 'FALHA ') + o); };

const src = fs.readFileSync(path.join(__dirname, '..', 'ml-full.js'), 'utf8');
const sem = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

ok(/const MAX_DIAS_SERIE = 366;/.test(sem), '⚠️ teto da serie: 366 dias');
ok(/\(tAte - tDe\) >= MAX_DIAS_SERIE \* 86400000/.test(sem), '  a validacao usa o teto');
ok(!/>= 31 \* 86400000\) \{/.test(sem), '  o 31 cravado na validacao sumiu');
ok(/no m.ximo ' \+ MAX_DIAS_SERIE \+ ' dias corridos na s.rie \(um ano\)/.test(sem), '  a mensagem de erro diz o teto novo');
ok(/aviso_serie_longa/.test(sem) && /\(tAte - tDe\) >= 31 \* 86400000 \?/.test(sem), '⚠️ serie > 31 dias: a resposta traz aviso_serie_longa (deploy/reinicio interrompe; status mostra onde parou)');
ok(/INTERROMPE a serie/.test(sem) && /como_retomar/.test(sem) && /sem deploy ate terminar/.test(sem), '  o aviso diz o risco e o que fazer (e e VERDADEIRO: o progresso esta em disco)');
ok(/ml-full b5/.test(src), '  versao b5');
// a conta dos pedacos: um ano com passo 2 = 183 pedacos (nao estoura nada)
{
  const DIA = 86400000;
  const tDe = Date.UTC(2026, 0, 1), tAte = Date.UTC(2026, 11, 31);
  const passo = 2; let n = 0;
  for (let t = tDe; t <= tAte; t += passo * DIA) n++;
  ok(n === 183, `  ano inteiro com passo 2 = ${n} pedacos`);
  ok((tAte - tDe) < 366 * DIA, '  01/01 -> 31/12 passa no teto de 366');
  ok(!((Date.UTC(2026, 6, 1) - Date.UTC(2025, 0, 1)) < 366 * DIA), '  ano e meio NAO passa');
}
// Codex #563 (P2): a serie persiste em disco; depois do reinicio o status mostra INTERROMPIDA e como retomar
{
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-full-serie-'));
  process.env.ML_FULL_DIR = dir;
  delete require.cache[require.resolve('../ml-full.js')];
  const mf = require('../ml-full.js');
  const I = mf._interno || {};
  ok(typeof I._salvarSerie === 'function' && typeof I._lerSerieDoDisco === 'function', '  _salvarSerie e _lerSerieDoDisco exportados pra teste');
  if (I._salvarSerie) {
    // simula uma serie que estava RODANDO quando o processo morreu, com 2 pedacos feitos
    I._salvarSerie('girassol', { rodando: true, comecou: 'x', terminou: null, janela: { de: '20260101', ate: '20260930' }, pedacos: 183, feitos: 2, passo: 2, teto: 200, respiro_s: 60,
      total_ja_no_bling: 3, total_pendentes_novas: 0, total_nao_conferidas: 0,
      resultados: [{ de: '20260101', ate: '20260102', ok: true }, { de: '20260103', ate: '20260104', ok: true }], erro: null });
    const lido = I._lerSerieDoDisco('girassol');
    ok(lido && lido.interrompida === true && lido.rodando === false, '⚠️ serie "rodando" no disco + memoria vazia = INTERROMPIDA (o processo morreu)');
    ok(lido && lido.ultimo_pedaco_feito === '20260103→20260104', '  ultimo pedaco feito vem do disco');
    // Codex r2 (P2): a URL de retomada precisa de de+ate — o ate ORIGINAL vem de `janela`
    ok(lido && lido.retomar_de === '20260105' && /de=20260105&ate=20260930/.test(lido.como_retomar), '⚠️ sem falha: retoma no DIA SEGUINTE ao ultimo ok, com o ate ORIGINAL da serie na URL');
    // Codex r2 (P1): se o ultimo pedaco FALHOU, retoma do `de` DELE (nao do ate — pularia o 1o dia)
    I._salvarSerie('girassol', { rodando: true, janela: { de: '20260101', ate: '20260930' }, pedacos: 183, feitos: 3,
      resultados: [{ de: '20260101', ate: '20260102', ok: true }, { de: '20260103', ate: '20260104', ok: true }, { de: '20260105', ate: '20260106', ok: false, resultado: 'transitorio_tente_de_novo' }] });
    const lidoF = I._lerSerieDoDisco('girassol');
    ok(lidoF && lidoF.retomar_de === '20260105' && /primeiro pedaco NAO FECHADO/.test(lidoF.como_retomar), '⚠️ ultimo pedaco FALHOU: retoma do de DELE (20260105), nao do ate (pularia o dia 05)');
    ok(lidoF && /\(FALHOU\)/.test(lidoF.ultimo_pedaco_feito), '  e o ultimo pedaco aparece marcado como FALHOU');
    // falho no MEIO seguido de ok: retoma do primeiro falho
    I._salvarSerie('girassol', { rodando: true, janela: { de: '20260101', ate: '20260930' }, pedacos: 183, feitos: 3,
      resultados: [{ de: '20260101', ate: '20260102', ok: false }, { de: '20260103', ate: '20260104', ok: true }, { de: '20260105', ate: '20260106', ok: true }] });
    ok(I._lerSerieDoDisco('girassol').retomar_de === '20260101', '  falho no MEIO: retoma do primeiro falho');
    // Codex r3 (P1): ok:true com nao_conferidas > 0 NAO esta fechado — retoma dele
    I._salvarSerie('girassol', { rodando: true, janela: { de: '20260101', ate: '20260930' }, pedacos: 183, feitos: 3,
      resultados: [{ de: '20260101', ate: '20260102', ok: true, nao_conferidas: 0 }, { de: '20260103', ate: '20260104', ok: true, nao_conferidas: 5 }, { de: '20260105', ate: '20260106', ok: true, nao_conferidas: 0 }] });
    const lidoNC = I._lerSerieDoDisco('girassol');
    ok(lidoNC.retomar_de === '20260103' && /NAO FECHADO/.test(lidoNC.como_retomar), '⚠️ pedaco ok mas com 5 nao conferidas (cota): NAO esta fechado — retoma dele (senao essas notas nunca mais seriam conferidas)');
    ok(/5 NAO CONFERIDA/.test(I._lerSerieDoDisco('girassol').ultimo_pedaco_feito) === false, '  (o ultimo pedaco aqui fechou limpo; a marca aparece so no ultimo)');
    // Codex r2 (P2): ML_FULL_DIR que ainda nao existe — mkdir antes de gravar
    const sub = path.join(dir, 'ainda', 'nao', 'existe');
    process.env.ML_FULL_DIR = sub;
    delete require.cache[require.resolve('../ml-full.js')];
    const mf2 = require('../ml-full.js');
    mf2._interno._salvarSerie('amb', { rodando: false, janela: { de: 'a', ate: 'b' }, resultados: [] });
    ok(fs.existsSync(path.join(sub, 'ml-full-serie-amb.json')), '⚠️ grava mesmo com o diretorio inexistente (mkdir recursive)');
    process.env.ML_FULL_DIR = dir;
    delete require.cache[require.resolve('../ml-full.js')];
    // serie que TERMINOU: nao e interrompida
    I._salvarSerie('amb', { rodando: false, terminou: 'y', janela: { de: 'a', ate: 'b' }, pedacos: 2, feitos: 2, resultados: [{ de: 'a', ate: 'b', ok: true }] });
    ok(I._lerSerieDoDisco('amb') && !I._lerSerieDoDisco('amb').interrompida, '  serie terminada no disco NAO e interrompida');
    ok(I._lerSerieDoDisco('good') === null, '  empresa sem arquivo: null');
    // arquivo corrompido: null, nao lanca
    fs.writeFileSync(path.join(dir, 'ml-full-serie-good.json'), '{ quebrado');
    ok(I._lerSerieDoDisco('good') === null, '  arquivo corrompido: null (nunca lanca)');
    // o checkpoint e gravado a cada pedaco e no fim (fonte)
    ok(/_salvarSerie\(empresa, st\);   \/\/ b5: checkpoint por pedaco/.test(src), '  checkpoint a cada pedaco');
    ok(/janela: \{ de, ate \},/.test(src), '  o st persiste a janela ORIGINAL (de/ate)');
    ok(/function _aaaammdd\(ts\)/.test(src) && !/retomarDe = t \? iso\(/.test(src), '  a retomada usa _aaaammdd (escopo de modulo) — iso() so existe dentro do handler');
    ok(/finally \{ st\.rodando = false; st\.terminou = new Date\(\)\.toISOString\(\); _salvarSerie\(empresa, st\); \}/.test(src), '  e no fim');
    ok(/const st = _serie\[empresa\] \|\| _lerSerieDoDisco\(empresa\) \|\| null;/.test(src), '  o status le do disco quando a memoria esta vazia');
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
}

console.log('');
console.log(falhas === 0 ? '=== TODOS OS CASOS PASSARAM' : '=== ' + falhas + ' FALHA(S)');
process.exit(falhas ? 1 : 0);
