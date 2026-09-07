'use strict';
/* Cenários do MOTOR (b3) em PROCESSO PRÓPRIO — o teste principal tem IIFE assíncrona
   com esperas; trocar o fetch no mesmo processo atropelaria a tabela dela no meio.
   Exercita varrerLote de produção com ZIP fixture REAL (adm-zip) e Bling falso.
   Matriz: simbólica ignorada · ausente vira arquivo (por tipo) · presente não vira ·
   erro de consulta NÃO conclui · anomalia chave nome≠XML · idempotência.
   Rodar: node scripts/teste-ml-full-motor.js (ele aloca o próprio tmp — env é ignorada) */
const os = require('os'); const fs = require('fs'); const path = require('path');
/* Codex #349 r2: o teste SEMPRE aloca diretório PRÓPRIO — herdar ML_FULL_DIR do
   ambiente e depois dar rmSync nele apagaria /data/ml-full de verdade se alguém
   rodasse o teste dentro do container. Env herdada é ignorada de propósito. */
process.env.ML_FULL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mlf-motor-'));
const assert = require('assert');
const AdmZip = require('adm-zip');
const mf = require('../ml-full');
const { varrerLote, lerTpNF, classificarEntradaZip, _trocarFetchParaTeste } = mf._interno;

const CHV = (n) => '3526096428909100010055002' + String(n).padStart(9, '0') + '1234567890';
const xmlDe = (chave, tp) => '<?xml version="1.0"?><NFe><infNFe Id="NFe' + chave + '"><ide><tpNF>' + tp + '</tpNF></ide></infNFe></NFe>';

const z = new AdmZip();
z.addFile('Emitidas_Mercado_Livre/Notas de venda/111_' + CHV(1) + '-procNFe.xml', Buffer.from(xmlDe(CHV(1), 1)));
z.addFile('Emitidas_Mercado_Livre/Notas de venda/112_' + CHV(2) + '-procNFe.xml', Buffer.from(xmlDe(CHV(2), 1)));
z.addFile('Emitidas_Mercado_Livre/Notas de devolução/113_' + CHV(3) + '-procNFe.xml', Buffer.from(xmlDe(CHV(3), 0)));
z.addFile('Emitidas_Mercado_Livre/Outros documentos/Notas de retiro simbólica/114_' + CHV(4) + '-procNFe.xml', Buffer.from(xmlDe(CHV(4), 1)));
z.addFile('Emitidas_Mercado_Livre/Notas de venda/115_' + CHV(5) + '-procNFe.xml', Buffer.from(xmlDe(CHV(9), 1))); // anomalia
z.addFile('Emitidas_Mercado_Livre/Notas de venda/116_' + CHV(6) + '-procNFe.xml', Buffer.from(xmlDe(CHV(6), 1)));

assert.strictEqual(lerTpNF(xmlDe(CHV(3), 0)), 'entrada');
const cl = classificarEntradaZip('Emitidas_Mercado_Livre/Notas de venda/111_' + CHV(1) + '-procNFe.xml');
assert.strictEqual(cl.invoice_id, '111'); assert.strictEqual(cl.chave, CHV(1)); assert.strictEqual(cl.pasta, 'Notas de venda');

_trocarFetchParaTeste(async (url) => {
  if (url.includes('period/stream')) return { status: 200, buffer: async () => z.toBuffer(), text: async () => '' };
  if (url.includes('/users/me')) return { status: 200, text: async () => JSON.stringify({ id: 999, nickname: 'T' }) };
  if (url.includes('/nfe?chaveAcesso=' + CHV(1))) return { status: 200, text: async () => JSON.stringify({ data: [{ id: 71 }] }) };
  if (url.includes('/nfe/71')) return { status: 200, text: async () => JSON.stringify({ data: { id: 71, chaveAcesso: CHV(1) } }) };
  if (url.includes('/nfe?chaveAcesso=' + CHV(6))) return { status: 500, text: async () => 'erro' };
  if (url.includes('/nfe?chaveAcesso=')) return { status: 200, text: async () => JSON.stringify({ data: [] }) };
  throw new Error('teste não previu: ' + url);
});

(async () => {
  const r = await varrerLote('amb', '20260901', '20260901', 60, { tokenML: 'tk', tokenBling: 'tb' });
  assert.strictEqual(r.ok, true, JSON.stringify(r).slice(0, 200));
  assert.strictEqual(r.ignoradas_simbolicas, 1, 'retiro simbólica fora (política v1)');
  assert.strictEqual(r.ja_no_bling, 1, 'presente no Bling não vira arquivo');
  assert.strictEqual(r.pendentes_novas, 2, 'ausentes viram arquivo');
  assert.ok(r.novas.some(n => n.tipo === 'entrada' && n.chave === CHV(3)), 'devolução caiu em entrada/');
  assert.ok(r.novas.some(n => n.tipo === 'saida' && n.chave === CHV(2)), 'venda caiu em saida/');
  assert.strictEqual(r.nao_conferidas, 1, 'o 500 do Bling NÃO conclui — fica pra próxima');
  assert.strictEqual((r.anomalias || []).length, 1, 'chave do nome ≠ chave do XML é anomalia, não arquivo');
  assert.strictEqual(r.censo_pastas['Notas de venda'], 4);
  assert.strictEqual(r.censo_pastas['Notas de devolução'], 1);

  const r2 = await varrerLote('amb', '20260901', '20260901', 60, { tokenML: 'tk', tokenBling: 'tb' });
  assert.strictEqual(r2.pendentes_novas, 0, 'idempotente: já salvas não repetem');
  assert.strictEqual(r2.ja_baixadas, 2);

  // r1: teto HONESTO — orçamento 1 não banca lista+detalhe; conta a chamada real
  fs.rmSync(process.env.ML_FULL_DIR, { recursive: true, force: true });
  fs.mkdirSync(process.env.ML_FULL_DIR, { recursive: true });
  const r3 = await varrerLote('amb', '20260901', '20260901', 1, { tokenML: 'tk', tokenBling: 'tb' });
  assert.ok(r3.consultas_bling <= 1, 'teto=1 nunca passa de 1 chamada real (fez ' + r3.consultas_bling + ')');
  assert.ok(r3.nao_conferidas >= 1 && JSON.stringify(r3.lista_nao_conferidas).includes('teto'), 'cortadas pelo teto ficam nomeadas');

  // r1: raiz NÃO é saída — arquivo legado é classificado pelo tpNF (o caso real da 7935)
  const { listarArquivos } = mf._interno;
  fs.writeFileSync(path.join(process.env.ML_FULL_DIR, 'amb-nota-777.xml'), xmlDe(CHV(7), 0)); // devolução na raiz
  fs.writeFileSync(path.join(process.env.ML_FULL_DIR, 'amb-nota-778.xml'), xmlDe(CHV(8), 1)); // venda na raiz
  fs.writeFileSync(path.join(process.env.ML_FULL_DIR, 'amb-nota-779.xml'), 'lixo sem tpNF');
  const ent = listarArquivos('amb', 'entrada').map(x => x.arquivo);
  const sai = listarArquivos('amb', 'saida').map(x => x.arquivo);
  assert.ok(ent.includes('amb-nota-777.xml') && !sai.includes('amb-nota-777.xml'), 'devolução da raiz vai pro ZIP de ENTRADA');
  assert.ok(sai.includes('amb-nota-778.xml') && !ent.includes('amb-nota-778.xml'), 'venda da raiz vai pro ZIP de saída');
  assert.ok(!ent.includes('amb-nota-779.xml') && !sai.includes('amb-nota-779.xml'), 'ilegível fica fora dos tipados');
  assert.strictEqual(listarArquivos('amb', null).find(x => x.arquivo === 'amb-nota-779.xml').tipo, 'desconhecido');

  // r2: legado da RAIZ com a MESMA chave não vira segunda cópia (dedup por chave)
  fs.rmSync(process.env.ML_FULL_DIR, { recursive: true, force: true });
  fs.mkdirSync(process.env.ML_FULL_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.ML_FULL_DIR, 'amb-nota-999.xml'), xmlDe(CHV(3), 0)); // devolução legada, nome sem chave
  const r4 = await varrerLote('amb', '20260901', '20260901', 60, { tokenML: 'tk', tokenBling: 'tb' });
  assert.ok(!r4.novas.some(n => n.chave === CHV(3)), 'chave já na raiz legada não grava cópia tipada');
  assert.ok(r4.ja_baixadas >= 1, 'legado conta como já baixada');

  // r2: lista com 2 itens pra chave única = filtro ignorado ⇒ nao_conferida (nunca conclui)
  _trocarFetchParaTeste(async (url) => {
    if (url.includes('period/stream')) return { status: 200, buffer: async () => z.toBuffer(), text: async () => '' };
    if (url.includes('/users/me')) return { status: 200, text: async () => JSON.stringify({ id: 999 }) };
    if (url.includes('/nfe?chaveAcesso=')) return { status: 200, text: async () => JSON.stringify({ data: [{ id: 1 }, { id: 2 }] }) };
    throw new Error('não previsto: ' + url);
  });
  fs.rmSync(process.env.ML_FULL_DIR, { recursive: true, force: true });
  fs.mkdirSync(process.env.ML_FULL_DIR, { recursive: true });
  const r5 = await varrerLote('amb', '20260901', '20260901', 60, { tokenML: 'tk', tokenBling: 'tb' });
  assert.strictEqual(r5.pendentes_novas, 0, 'filtro ignorado nunca conclui ausência');
  assert.ok(JSON.stringify(r5.lista_nao_conferidas).includes('filtro ignorado'), 'motivo nomeado');

  // r2: exceção no DETALHE conta as 2 chamadas reais (o teto não é furado por fantasma)
  const { blingTemChave } = mf._interno;
  _trocarFetchParaTeste(async (url) => {
    if (url.includes('/nfe?chaveAcesso=')) return { status: 200, text: async () => JSON.stringify({ data: [{ id: 9 }] }) };
    if (url.includes('/nfe/9')) throw new Error('ETIMEDOUT no detalhe');
    throw new Error('não previsto: ' + url);
  });
  const b9 = await blingTemChave('tb', CHV(1), 60);
  assert.strictEqual(b9.verificada, false);
  assert.strictEqual(b9.chamadas, 2, 'exceção no detalhe devolve 2 chamadas, não 1');

  console.log('OK: motor fase 1 — matriz completa + teto honesto + raiz classificada + dedup por chave + filtro-ignorado + contagem na exceção');
})().catch(e => { console.error('FALHOU (motor):', e.message); process.exit(1); });
