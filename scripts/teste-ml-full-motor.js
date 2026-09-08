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
z.addFile('Emitidas_Mercado_Livre/Canceladas/117_' + '3526096428909100010055002' + '000000117'.padStart(9, '0') + '1234567890' + '-procNFe.xml', Buffer.from(xmlDe('3526096428909100010055002' + '000000117' + '1234567890', 1)));
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
  assert.strictEqual(r.canceladas_no_lote, 1, 'pasta Canceladas fora das candidatas (censo real de 07/09)');
  assert.ok(!r.novas.some(n => n.invoice_id === '117'), 'cancelada nunca vira pendente de importação');
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

  // r3: datas que o V8 normaliza são recusadas (provado: 2026-02-30 → 2 de março)
  const { dataValida } = mf._interno;
  assert.strictEqual(dataValida('20260230'), null, '30 de fevereiro não passa');
  assert.strictEqual(dataValida('20260431'), null, '31 de abril não passa');
  assert.ok(dataValida('20260907'), 'data real passa');

  // r3: a sonda do garantirToken conta no teto (produção); teto=1 é consumido por ela
  const { _trocarBlingTokensParaTeste } = mf._interno;
  _trocarBlingTokensParaTeste({ amb: () => ({ garantirToken: async () => 'tb' }) });
  _trocarFetchParaTeste(async (url) => {
    if (url.includes('period/stream')) return { status: 200, buffer: async () => z.toBuffer(), text: async () => '' };
    if (url.includes('/users/me')) return { status: 200, text: async () => JSON.stringify({ id: 999 }) };
    if (url.includes('/nfe?chaveAcesso=')) return { status: 200, text: async () => JSON.stringify({ data: [] }) };
    throw new Error('não previsto: ' + url);
  });
  fs.rmSync(process.env.ML_FULL_DIR, { recursive: true, force: true });
  fs.mkdirSync(process.env.ML_FULL_DIR, { recursive: true });
  const r6 = await varrerLote('amb', '20260901', '20260901', 1, { tokenML: 'tk' }); // SEM tokenBling: aquisição real (fake)
  assert.ok(r6.consultas_bling <= 1, 'aquisição do token fica FORA do teto (declarada em nota_cota)');
  assert.ok(String(r6.nota_cota || '').includes('fora'), 'nota_cota declara o trabalho opaco do manager');

  // r3: ciclo de vida — depois que o operador importa, a salva é re-conferida e ARQUIVADA
  fs.rmSync(process.env.ML_FULL_DIR, { recursive: true, force: true });
  fs.mkdirSync(process.env.ML_FULL_DIR, { recursive: true });
  let noBlingAgora = [];
  _trocarFetchParaTeste(async (url) => {
    if (url.includes('period/stream')) return { status: 200, buffer: async () => z.toBuffer(), text: async () => '' };
    if (url.includes('/users/me')) return { status: 200, text: async () => JSON.stringify({ id: 999 }) };
    for (const ch of noBlingAgora) {
      if (url.includes('/nfe?chaveAcesso=' + ch)) return { status: 200, text: async () => JSON.stringify({ data: [{ id: 5 }] }) };
    }
    if (url.includes('/nfe/5')) { const ch = noBlingAgora[0]; return { status: 200, text: async () => JSON.stringify({ data: { id: 5, chaveAcesso: ch } }) }; }
    if (url.includes('/nfe?chaveAcesso=')) return { status: 200, text: async () => JSON.stringify({ data: [] }) };
    throw new Error('não previsto: ' + url);
  });
  const rA = await varrerLote('amb', '20260901', '20260901', 60, { tokenML: 'tk', tokenBling: 'tb' });
  assert.ok(rA.novas.some(n => n.chave === CHV(2)), '1ª varredura salva a CHV2');
  noBlingAgora = [CHV(2)]; // operador importou
  const rB = await varrerLote('amb', '20260901', '20260901', 60, { tokenML: 'tk', tokenBling: 'tb' });
  assert.strictEqual(rB.arquivadas_no_bling, 1, 'salva que chegou no Bling é arquivada');
  const { listarArquivos: la2 } = mf._interno;
  assert.ok(!la2('amb', 'saida').some(x => x.arquivo.includes(CHV(2))), 'arquivada some do ZIP de saída');
  const rC = await varrerLote('amb', '20260901', '20260901', 60, { tokenML: 'tk', tokenBling: 'tb' });
  assert.strictEqual(rC.arquivadas_no_bling, 0, 'arquivada não volta ao ciclo');
  assert.strictEqual(rC.pendentes_novas, 0, 'nem vira nova de novo (Bling a tem)');

  // r4: PRESENÇA confirmada vira cache — na re-varredura da mesma janela, zero consulta
  // nelas (ausentes salvas SEGUEM re-conferidas de propósito: é como a arquivadora
  // detecta o import do operador). Cenário isolado: janela onde TUDO está no Bling.
  fs.rmSync(process.env.ML_FULL_DIR, { recursive: true, force: true });
  fs.mkdirSync(process.env.ML_FULL_DIR, { recursive: true });
  _trocarFetchParaTeste(async (url) => {
    if (url.includes('period/stream')) return { status: 200, buffer: async () => z.toBuffer(), text: async () => '' };
    if (url.includes('/users/me')) return { status: 200, text: async () => JSON.stringify({ id: 999 }) };
    const mL = url.match(/\/nfe\?chaveAcesso=(\d{44})/);
    if (mL) return { status: 200, text: async () => JSON.stringify({ data: [{ id: 'i' + mL[1] }] }) };
    const mD = url.match(/\/nfe\/i(\d{44})/);
    if (mD) return { status: 200, text: async () => JSON.stringify({ data: { id: 'i' + mD[1], chaveAcesso: mD[1] } }) };
    throw new Error('não previsto: ' + url);
  });
  const rD1 = await varrerLote('amb', '20260901', '20260901', 60, { tokenML: 'tk', tokenBling: 'tb' });
  assert.ok(rD1.ja_no_bling >= 3 && rD1.consultas_bling > 0, '1ª varredura confirma gastando consulta');
  const rD2 = await varrerLote('amb', '20260901', '20260901', 60, { tokenML: 'tk', tokenBling: 'tb' });
  assert.strictEqual(rD2.consultas_bling, 0, 'presenças em cache: zero consulta na re-varredura');
  assert.strictEqual(rD2.ja_no_bling, rD1.ja_no_bling, 'mesmo retrato, sem gastar');

  // r4: reconferência de SALVA que falha aparece nomeada (nunca varredura 'completa' de mentira)
  // (cache de confirmadas é module-level de propósito — produção quer; o teste reseta)
  mf._interno._limparCacheConfirmadasParaTeste();
  fs.rmSync(process.env.ML_FULL_DIR, { recursive: true, force: true });
  fs.mkdirSync(process.env.ML_FULL_DIR, { recursive: true });
  _trocarFetchParaTeste(async (url) => {
    if (url.includes('period/stream')) return { status: 200, buffer: async () => z.toBuffer(), text: async () => '' };
    if (url.includes('/users/me')) return { status: 200, text: async () => JSON.stringify({ id: 999 }) };
    if (url.includes('/nfe?chaveAcesso=')) return { status: 200, text: async () => JSON.stringify({ data: [] }) };
    throw new Error('não previsto: ' + url);
  });
  await varrerLote('amb', '20260901', '20260901', 60, { tokenML: 'tk', tokenBling: 'tb' }); // salva as ausentes
  _trocarFetchParaTeste(async (url) => {
    if (url.includes('period/stream')) return { status: 200, buffer: async () => z.toBuffer(), text: async () => '' };
    if (url.includes('/users/me')) return { status: 200, text: async () => JSON.stringify({ id: 999 }) };
    if (url.includes('/nfe?chaveAcesso=')) return { status: 500, text: async () => 'instável' };
    throw new Error('não previsto: ' + url);
  });
  const rE = await varrerLote('amb', '20260901', '20260901', 60, { tokenML: 'tk', tokenBling: 'tb' });
  assert.ok(rE.nao_conferidas >= 1 && JSON.stringify(rE.lista_nao_conferidas).includes('reconferência falhou'), 'salva com reconferência falhada é reportada');
  assert.ok(rE.aviso, 'aviso presente — nunca varredura completa de mentira');

  // acerto r5: varreduras simultâneas da mesma empresa — a 2ª recusa educadamente
  const [pA, pB] = [varrerLote('amb', '20260901', '20260901', 60, { tokenML: 'tk', tokenBling: 'tb' }),
                    varrerLote('amb', '20260901', '20260901', 60, { tokenML: 'tk', tokenBling: 'tb' })];
  const [ra2, rb2] = await Promise.all([pA, pB]);
  const recusas = [ra2, rb2].filter(x => x.resultado === 'ja_ha_varredura_em_andamento').length;
  assert.strictEqual(recusas, 1, 'exatamente uma das duas é recusada pela trava');

  // #350 r1: cursor monotônico — rodadas sucessivas cobrem faixas DISJUNTAS até a volta
  mf._interno._limparCacheConfirmadasParaTeste();
  fs.rmSync(process.env.ML_FULL_DIR, { recursive: true, force: true });
  fs.mkdirSync(process.env.ML_FULL_DIR, { recursive: true });
  _trocarFetchParaTeste(async (url) => {
    if (url.includes('period/stream')) return { status: 200, buffer: async () => z.toBuffer(), text: async () => '' };
    if (url.includes('/users/me')) return { status: 200, text: async () => JSON.stringify({ id: 999 }) };
    if (url.includes('/nfe?chaveAcesso=')) return { status: 200, text: async () => JSON.stringify({ data: [] }) };
    throw new Error('não previsto: ' + url);
  });
  const vistas = new Set();
  for (let i = 0; i < 3; i++) {
    const ri = await varrerLote('amb', '20260901', '20260901', 2, { tokenML: 'tk', tokenBling: 'tb' });
    for (const n of ri.novas) { assert.ok(!vistas.has(n.chave), 'faixas disjuntas: ' + n.chave + ' repetiu na rodada ' + i); vistas.add(n.chave); }
  }
  assert.ok(vistas.size >= 4, 'três rodadas de teto=2 cobrem posições distintas (cobriu ' + vistas.size + ')');

  // #350 r1 (P1): cancelada já SALVA vai pra quarentena e some do ZIP
  mf._interno._limparCacheConfirmadasParaTeste();
  fs.rmSync(process.env.ML_FULL_DIR, { recursive: true, force: true });
  fs.mkdirSync(process.env.ML_FULL_DIR, { recursive: true });
  const chCanc = '3526096428909100010055002' + '000000117'.padStart(9, '0') + '1234567890';
  fs.mkdirSync(path.join(process.env.ML_FULL_DIR, 'saida'), { recursive: true });
  fs.writeFileSync(path.join(process.env.ML_FULL_DIR, 'saida', 'amb-117-' + chCanc + '.xml'), xmlDe(chCanc, 1));
  const rq = await varrerLote('amb', '20260901', '20260901', 60, { tokenML: 'tk', tokenBling: 'tb' });
  assert.strictEqual(rq.canceladas_quarentenadas, 1, 'cancelada salva foi quarentenada');
  assert.ok(!mf._interno.listarArquivos('amb', 'saida').some(x => x.arquivo.includes(chCanc)), 'cancelada sumiu do ZIP de saída');

  console.log('OK: motor fase 1 — canceladas quarentenadas, cursor disjunto, trava com 409, token no lock');
})().catch(e => { console.error('FALHOU (motor):', e.message); process.exit(1); });
