'use strict';
// b9 — as CANCELADAS do ML conferidas contra o Bling. Girassol 02/10: a 48397/serie 2,
// cancelada no ML, nao existia no Bling — e a contabilidade recebe as canceladas no export.
// Exercita varrerLote DE PRODUCAO com ZIP fixture real (adm-zip) e Bling falso.
const os = require('os'); const fs = require('fs'); const path = require('path');
process.env.ML_FULL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mlf-canc-'));   // diretorio PROPRIO (nunca /data)
const AdmZip = require('adm-zip');
const mf = require('../ml-full');
const { varrerLote, _trocarFetchParaTeste } = mf._interno;
let falhas = 0;
const ok = (c, o) => { if (!c) falhas++; console.log((c ? 'ok  ' : 'FALHA ') + o); };
const CH = (n, serie) => '3526042754845600014755' + String(serie).padStart(3, '0') + String(n).padStart(9, '0') + '1234567890';
const xml = (chave, verProc) => '<?xml version="1.0"?><nfeProc><NFe><infNFe Id="NFe' + chave + '"><ide><tpNF>1</tpNF><verProc>' + verProc + '</verProc></ide></infNFe></NFe></nfeProc>';
const A = CH(48001, 2), B = CH(48002, 2), C = CH(48003, 2), D = CH(48004, 1), E = CH(48005, 2);
const z = new AdmZip();
z.addFile('Emitidas_Mercado_Livre/Canceladas/501_' + A + '-procNFe.xml', Buffer.from(xml(A, 'mercadolivre.invoice')));   // no Bling como cancelada
z.addFile('Emitidas_Mercado_Livre/Canceladas/502_' + B + '-procNFe.xml', Buffer.from(xml(B, 'mercadolivre.invoice')));   // ausente
z.addFile('Emitidas_Mercado_Livre/Canceladas/503_' + C + '-procNFe.xml', Buffer.from(xml(C, 'mercadolivre.invoice')));   // VIVA no Bling
z.addFile('Emitidas_Mercado_Livre/Canceladas/504_' + D + '-procNFe.xml', Buffer.from(xml(D, 'Bling v3.1')));             // emitida pelo Bling: nao confere
z.addFile('Emitidas_Mercado_Livre/Canceladas/505_' + E + '-procNFe.xml', Buffer.from(xml(E, 'mercadolivre.invoice')));   // Bling 500
let bNoBlingComoCancelada = false;   // virada no meio do teste
_trocarFetchParaTeste(async (url) => {
  if (url.includes('period/stream')) return { status: 200, buffer: async () => z.toBuffer(), text: async () => '' };
  if (url.includes('/users/me')) return { status: 200, text: async () => JSON.stringify({ id: 999 }) };
  const m = url.match(/\/nfe\?chaveAcesso=(\d{44})/);
  if (m) {
    const ch = m[1], canc = url.includes('&situacao=2');
    if (ch === E) return { status: 500, text: async () => 'erro' };
    if (!canc && ch === C) return { status: 200, text: async () => JSON.stringify({ data: [{ id: 'v' + ch }] }) };   // C na lista PADRAO (valida)
    if (canc && (ch === A || (ch === B && bNoBlingComoCancelada))) return { status: 200, text: async () => JSON.stringify({ data: [{ id: 'c' + ch }] }) };
    return { status: 200, text: async () => JSON.stringify({ data: [] }) };
  }
  const d = url.match(/\/nfe\/[vc](\d{44})/);
  if (d) return { status: 200, text: async () => JSON.stringify({ data: { id: 'x', chaveAcesso: d[1] } }) };
  throw new Error('nao previsto: ' + url);
});
(async () => {
  const r = await varrerLote('girassol', '20260413', '20260414', 60, { tokenML: 'tk', tokenBling: 'tb' });
  ok(r.ok && r.canceladas_no_lote === 5, '  5 canceladas no lote');
  ok(r.canceladas_ok === 1, '⚠️ A: no Bling COMO cancelada = ok');
  ok(r.canceladas_ausentes && r.canceladas_ausentes.length === 1 && r.canceladas_ausentes[0].chave === B && r.canceladas_ausentes[0].numero === '48002', '⚠️ B: AUSENTE do Bling (o caso da 48397) — listada com o numero');
  ok(r.canceladas_vivas_no_bling && r.canceladas_vivas_no_bling.length === 1 && r.canceladas_vivas_no_bling[0].chave === C, '⚠️ C: o ML cancelou e o Bling diz VALIDA — listada (infla o faturamento)');
  ok(!JSON.stringify(r.canceladas_ausentes || []).includes(D) && !JSON.stringify(r.canceladas_vivas_no_bling || []).includes(D), '  D: emitida pelo Bling (serie 1) — nao conferida (o proprio Bling a cancelou)');
  ok(r.nao_conferidas === 1 && JSON.stringify(r.lista_nao_conferidas).includes(E) && /cancelada:/.test(JSON.stringify(r.lista_nao_conferidas)), '  E: Bling 500 = nao conferida (nao sei != nao existe)');
  ok(!r.novas.length, '  nenhuma cancelada vira pendente de importacao');
  const aus = path.join(process.env.ML_FULL_DIR, 'canceladas-ausentes', 'girassol-502-' + B + '.xml');
  ok(fs.existsSync(aus) && fs.readFileSync(aus, 'utf8').includes(B), '⚠️ o XML da ausente foi guardado em canceladas-ausentes/ (o ZIP tipo=canceladas serve dali)');
  ok(!mf._interno.listarArquivos('girassol', 'saida').some((a) => a.arquivo.includes(B)), '  ... e NAO entra no ZIP de saida (nao e pra importar como valida)');
  // a ausente entra no Bling como cancelada: na proxima varredura sai da pasta
  bNoBlingComoCancelada = true;
  const r2 = await varrerLote('girassol', '20260413', '20260414', 60, { tokenML: 'tk', tokenBling: 'tb' });
  ok(r2.canceladas_ok === 2 && !r2.canceladas_ausentes, '  B agora no Bling como cancelada: ok');
  ok(!fs.existsSync(aus) && fs.existsSync(path.join(process.env.ML_FULL_DIR, 'canceladas-resolvidas', 'girassol-502-' + B + '.xml')), '⚠️ ... e o XML saiu de canceladas-ausentes/ (resolvidas/)');
  // teto: canceladas alem do teto viram nao conferidas com motivo de teto
  const r3 = await varrerLote('girassol', '20260413', '20260414', 1, { tokenML: 'tk', tokenBling: 'tb' });
  ok(r3.consultas_bling <= 2 && /teto/.test(JSON.stringify(r3.lista_nao_conferidas || [])), '  teto respeitado: o excedente vira nao conferida por teto (a serie refaz)');
  // a rota do ZIP aceita tipo=canceladas
  const src = fs.readFileSync(path.join(__dirname, '..', 'ml-full.js'), 'utf8');
  ok(/tipo !== 'canceladas'/.test(src) && /canceladas-ausentes/.test(src), '  /ml-full/zip?tipo=canceladas');
  ok(/total_canceladas_ausentes/.test(src) && /total_canceladas_vivas/.test(src), '  a serie soma as canceladas ausentes e vivas');
  try { fs.rmSync(process.env.ML_FULL_DIR, { recursive: true, force: true }); } catch (e) {}
  console.log('');
  console.log(falhas === 0 ? '=== TODOS OS CASOS PASSARAM' : '=== ' + falhas + ' FALHA(S)');
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.log('FALHA (excecao):', e && e.message); process.exit(1); });
