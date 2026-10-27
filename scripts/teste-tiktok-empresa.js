'use strict';
/* 24/10 — o TikTok nas três empresas pelas MESMAS peças: a coleta do financeiro (lib/tiktok-financeiro, já era peça) e a
   CORREÇÃO DA TARIFA (lib/tiktok-completar), cujo embrulho era cópia na Girassol e na AMB e que a GOOD não tinha. Prova:
   · o completador DA empresa lê o arquivo DELA (_tiktok_financeiro_<empresa>.json), consulta e corrige o histórico DELA
     (supaReq com a chave da empresa) e limpa o cache do painel quando alguma linha mudou;
   · a simulação não limpa o cache (nada mudou); sem o arquivo da empresa, responde o erro e não toca no histórico;
   · Girassol e AMB usam a peça (sem cópia); a GOOD ganha a coleta e a correção (agenda fora do galpão, esperando o
     backfill dela) e a rota manual da fábrica deixa de responder "sem peça". */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const { criarCompletadorDaEmpresa } = require('../lib/tiktok-completar');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-'));
  process.env.TIKTOK_CACHE_DIR = dir;
  fs.writeFileSync(path.join(dir, '_tiktok_financeiro_good.json'), JSON.stringify({ pedidos: { 'TK1': { tarifa: 30 } } }));
  fs.writeFileSync(path.join(dir, '_tiktok_financeiro_girassol.json'), JSON.stringify({ pedidos: { 'TK1': { tarifa: 99 } } }));
  const log = [];
  const linha = { id: 7, numero_pedido: '1', numero_loja: 'TK1', data_venda: '2026-10-01', valor_nota: 100, valor_produto: 100, custo: 40, comissao: 11, frete_vendedor: 0, imposto: 5, margem: 44 };
  const supaReq = async (emp, metodo, caminho, corpo) => {
    log.push([emp, metodo, caminho.slice(0, 40), corpo || null]);
    if (metodo === 'GET') return { ok: true, status: 200, body: JSON.stringify(/offset=0\b/.test(caminho) ? [linha] : []) };
    return { ok: true, status: 200, body: JSON.stringify([{ id: 7 }]) };   /* como o PostgREST com select=id: devolve a linha mexida */
  };
  let limpou = 0;
  const comp = criarCompletadorDaEmpresa('good', { supaReq, aoAtualizar: () => { limpou++; } });
  // simulação: nada muda, o cache fica
  let r = await comp(45, { simular: true });
  assert.ok(r && r.ok, 'simulação falhou: ' + JSON.stringify(r).slice(0, 200));
  assert.strictEqual(limpou, 0, 'a simulação limpou o cache do painel');
  assert.ok(log.every(l => l[0] === 'good') && !log.some(l => l[1] === 'PATCH'), 'a simulação mexeu no histórico (ou em outra empresa)');
  // de verdade: corrige a linha DA GOOD com a tarifa do arquivo DELA (30, não os 99 da Girassol) e limpa o cache
  log.length = 0;
  r = await comp(45, {});
  assert.ok(r && r.ok && r.linhas_atualizadas >= 1, 'não corrigiu: ' + JSON.stringify(r).slice(0, 200));
  assert.ok(log.some(l => l[0] === 'good' && l[1] === 'PATCH') && log.every(l => l[0] === 'good'), 'a correção não foi no histórico da GOOD');
  const patch = log.find(l => l[1] === 'PATCH');
  assert.strictEqual(patch[3].comissao, 30, 'a tarifa veio do arquivo de OUTRA empresa: ' + JSON.stringify(patch[3]));
  assert.strictEqual(limpou, 1, 'a correção não limpou o cache do painel');
  // empresa sem arquivo do financeiro: erro, sem tocar no histórico
  log.length = 0;
  r = await criarCompletadorDaEmpresa('amb', { supaReq })(45, {});
  assert.ok(r && r.ok === false && /vazio/.test(r.erro) && log.length === 0, 'sem o arquivo da empresa tinha que parar antes do histórico: ' + JSON.stringify(r));
  fs.rmSync(dir, { recursive: true, force: true });

  // as três empresas pela peça
  for (const [arq, emp] of [['girassol-backup-offline/gbo-app.js', 'girassol'], ['amb-checkout-offline/index.js', 'amb'], ['good-checkout-offline/index.js', 'good']]) {
    const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
    assert.ok(new RegExp("require\\('\\.\\./lib/tiktok-completar'\\)\\.criarCompletadorDaEmpresa\\('" + emp + "', \\{").test(s), arq + ': a correção da tarifa não é a peça');
    assert.ok(!/async function completarTarifaTikTok\(dias, opts\) \{/.test(s), arq + ': sobrou a cópia do embrulho');
    assert.ok(new RegExp("require\\('\\.\\./lib/tiktok-financeiro'\\)\\.criarColetorDaEmpresa\\('" + emp + "', \\{").test(s), arq + ': a coleta do financeiro não é a peça');
  }
  const gs = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
  /* 27/10: na GOOD, a coleta e a correção rodam na madrugada única (a correção depois do backfill; a madrugada pula o backfill com um da GOOD rodando) */
  assert.ok(/_noturnaGood = require\('\.\.\/lib\/checkout\/noturna-empresa'\)\.criarNoturna\(\{\s*\n\s*empresa: 'good', prefixo: '\/good-checkout-offline',/.test(gs) && /noturna: \(\) => _noturnaGood\.rotinaNoturna\('cron'\)/.test(gs) && /noturna: '0 4 \* \* \*'/.test(gs) && /coletarFinanceiroTikTok: \(\.\.\.a\) => coletarFinanceiroTikTokGood\(\.\.\.a\)/.test(gs) && /completarTarifaTikTok: \(\.\.\.a\) => completarTarifaTikTokGood\(\.\.\.a\)/.test(gs) && /backfillEstado: \(\) => \{/.test(gs), 'GOOD: a coleta e a correção não estão na madrugada');
  assert.ok(/completarTarifaTikTok: \(\.\.\.a\) => completarTarifaTikTokGood\(\.\.\.a\)/.test(gs), 'GOOD: a rota manual da fábrica segue sem a peça');
  console.log('ok — TikTok: correção da tarifa por empresa (arquivo, histórico e cache DELA); Girassol e AMB sem cópia; a GOOD coleta e corrige');
  process.exit(0);
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
