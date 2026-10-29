/* 14/10 — parecer do Codex (6.3): TROCA SEGURA DO PERIODO DO HISTORICO.
   Substitui o teste-backfill-delete-recusado (o DELETE direto saiu dos escritores). Roda a peca de PRODUCAO
   (lib/checkout/troca-periodo-historico.js) contra um Supabase de mentira que imita a funcao
   trocar_periodo_historico do sql/historico-troca-segura.sql (transacao: tudo ou nada), e confere que os
   DOIS escritores (Girassol/GOOD e AMB) usam a peca. Criterio do parecer: falha em qualquer etapa deixa a
   versao anterior intacta e o desfecho NUNCA e ok. */
'use strict';
const assert = require('assert');
const fs = require('fs'); const path = require('path');
const { trocarPeriodoHistorico } = require('../lib/checkout/troca-periodo-historico');
let falhas = 0;
const ok = (c, o) => { if (!c) { falhas++; console.log('FALHA ' + o); } else console.log('ok   ' + o); };

function banco(opt) {
  opt = opt || {};
  const b = {
    hist: [
      { empresa: 'good', numero_pedido: 'V1', data_venda: '2026-09-02', valor_produto: 10 },
      { empresa: 'good', numero_pedido: 'V2', data_venda: '2026-09-15', valor_produto: 20 },
      { empresa: 'good', numero_pedido: 'V3', data_venda: '2026-09-30', valor_produto: 30 },
      { empresa: 'good', numero_pedido: 'FORA', data_venda: '2026-10-01', valor_produto: 99 },
      { empresa: 'girassol', numero_pedido: 'G1', data_venda: '2026-09-10', valor_produto: 7 },
    ],
    rasc: [], chamadas: [], posts: 0, trocas: new Set(), canceladas: new Set(),
  };
  b.req = async (empresa, metodo, caminho, corpo) => {
    b.chamadas.push(metodo + ' ' + caminho.split('?')[0]);
    const q = new URLSearchParams((caminho.split('?')[1]) || '');
    if (caminho.startsWith('vendas_historico_rascunho')) {
      if (opt.semTabela) return { ok: false, status: 404, body: '{"code":"PGRST205"}' };
      if (metodo === 'DELETE') {
        const lote = (q.get('lote') || '').replace(/^eq\./, ''); const corte = (q.get('criado_em') || '').replace(/^lt\./, '');
        b.rasc = b.rasc.filter((r) => !((lote && r.lote === lote) || (corte && r.empresa === empresa && r.criado_em < corte)));
        return { ok: true, status: 204, body: '' };
      }
      if (metodo === 'POST') {
        b.posts++;
        if (opt.falhaPost && b.posts === opt.falhaPost) return { ok: false, status: 503, body: 'indisponivel' };
        for (const r of corpo) b.rasc.push(Object.assign({ criado_em: new Date().toISOString() }, r));
        return { ok: true, status: 201, body: '' };
      }
      if (metodo === 'GET') {
        if (opt.getFalha) return { ok: false, status: 0, erro: 'rede' };
        const lote = (q.get('lote') || '').replace(/^eq\./, '');
        return { ok: true, status: 200, body: JSON.stringify(b.rasc.filter((r) => r.lote === lote).slice(0, 1).map((r) => ({ lote: r.lote }))) };
      }
    }
    if (caminho === 'rpc/resolver_troca_historico') {
      if (opt.semResolver) return { ok: false, status: 404, body: '{"code":"PGRST202"}' };
      if (opt.resolverFalha) return { ok: false, status: 500, body: 'erro' };
      b.status = (b.status || 0) + 1;
      if (opt.rodandoAte && b.status < opt.rodandoAte) return { ok: true, status: 200, body: JSON.stringify({ resultado: 'rodando' }) };
      if (opt.rodandoAte && b.status === opt.rodandoAte && b.pendente) b.pendente();   // a troca lenta termina agora
      if (b.trocas.has(corpo.p_lote)) return { ok: true, status: 200, body: JSON.stringify({ resultado: 'confirmada' }) };
      b.canceladas.add(corpo.p_lote); b.rasc = b.rasc.filter((r) => r.lote !== corpo.p_lote);
      return { ok: true, status: 200, body: JSON.stringify({ resultado: 'cancelada' }) };
    }
    if (caminho === 'rpc/trocar_periodo_historico') {
      if (opt.semFuncao) return { ok: false, status: 404, body: '{"code":"PGRST202"}' };
      if (opt.rpcRecusa) return { ok: false, status: 400, body: '{"message":"rascunho incompleto"}' };
      if (opt.rpcPerdeAntes) { b.atrasada = () => b.req(empresa, 'POST', 'rpc/trocar_periodo_historico', Object.assign({}, corpo)); opt.rpcPerdeAntes = false; return { ok: false, status: 503, body: '' }; }     // nao aplicou (ficou na fila)
      if (opt.rpcLenta) {   // a troca segue rodando no banco e a resposta HTTP desiste antes
        const c2 = corpo; b.pendente = () => {
          if (b.canceladas.has(c2.p_lote)) return;   // cancelado: a troca atrasada e desfeita no banco
          const doLote = b.rasc.filter((r) => r.lote === c2.p_lote);
          b.hist = b.hist.filter((r) => !(r.empresa === c2.p_empresa && r.data_venda >= c2.p_de && r.data_venda <= c2.p_ate));
          for (const r of doLote) { const y = Object.assign({}, r); delete y.lote; delete y.criado_em; b.hist.push(y); }
          b.rasc = b.rasc.filter((r) => r.lote !== c2.p_lote);
          b.trocas.add(c2.p_lote);
        };
        return { ok: false, status: 504, body: 'gateway timeout' };
      }
      const { p_empresa, p_de, p_ate, p_lote, p_esperadas } = corpo;            // a MESMA regra do SQL, tudo ou nada
      if (b.canceladas.has(p_lote)) return { ok: false, status: 409, body: '{"message":"duplicate key (lote cancelado)"}' };
      const doLote = b.rasc.filter((r) => r.lote === p_lote);
      if (doLote.length !== p_esperadas) return { ok: false, status: 400, body: '{"message":"rascunho incompleto"}' };
      const antes = b.hist.length;
      b.hist = b.hist.filter((r) => !(r.empresa === p_empresa && r.data_venda >= p_de && r.data_venda <= p_ate));
      const apagadas = antes - b.hist.length;
      for (const r of doLote) { const y = Object.assign({}, r); delete y.lote; delete y.criado_em; b.hist.push(y); }
      b.rasc = b.rasc.filter((r) => r.lote !== p_lote);
      b.trocas.add(p_lote);
      if (opt.rpcPerdeDepois) return { ok: false, status: 0, erro: 'rede caiu depois de aplicar' };
      return { ok: true, status: 200, body: JSON.stringify({ ok: true, apagadas, inseridas: doLote.length }) };
    }
    return { ok: false, status: 500, erro: 'rota de mentira desconhecida: ' + metodo + ' ' + caminho };
  };
  return b;
}
const NOVAS = [
  { empresa: 'good', numero_pedido: 'N1', data_venda: '2026-09-03', valor_produto: 11 },
  { empresa: 'good', numero_pedido: 'N2', data_venda: '2026-09-20', valor_produto: 22, uf: 'SP' },   // chave a mais (uf)
  { empresa: 'good', numero_pedido: 'N3', data_venda: '2026-09-21', valor_produto: 33 },
];
const lerLotesDe = (linhas, n) => async function* () { for (let i = 0; i < linhas.length; i += n) yield linhas.slice(i, i + n).map((x) => Object.assign({}, x)); };
const rodar = (b, extra) => trocarPeriodoHistorico(Object.assign({ empresa: 'good', de: '2026-09-01', ate: '2026-09-30',
  supaReq: b.req, lerLotes: lerLotesDe(NOVAS, 2), esperadas: NOVAS.length, dorme: async () => {} }, extra || {}));
const periodoGood = (b) => b.hist.filter((r) => r.empresa === 'good' && r.data_venda <= '2026-09-30').map((r) => r.numero_pedido).sort().join(',');
const intacto = (b) => periodoGood(b) === 'V1,V2,V3' && b.hist.some((r) => r.numero_pedido === 'FORA') && b.hist.some((r) => r.numero_pedido === 'G1');

(async () => {
  { const b = banco(); const r = await rodar(b);
    ok(r.ok && r.desfecho === 'ok' && periodoGood(b) === 'N1,N2,N3' && b.rasc.length === 0, '⚠️ sucesso: o periodo vira a versao nova inteira e o rascunho some');
    ok(b.hist.some((x) => x.numero_pedido === 'FORA') && b.hist.some((x) => x.numero_pedido === 'G1'), '  fora do periodo e outra empresa ficam intactos');
    ok(r.apagadas === 3 && r.inseridas === 3, '  a troca devolve quantas apagou e quantas inseriu');
    ok(b.hist.find((x) => x.numero_pedido === 'N1').uf === null, '  lote com chaves diferentes e normalizado (PGRST102)'); }
  { const b = banco({ falhaPost: 2 }); const r = await rodar(b);
    ok(!r.ok && r.desfecho === 'abortado' && intacto(b) && b.rasc.length === 0 && !b.chamadas.includes('POST rpc/trocar_periodo_historico'),
      '⚠️ lote recusado no meio: ABORTA, o historico fica INTACTO, o rascunho e limpo e a troca nem e chamada'); }
  { const b = banco({ semTabela: true }); const r = await rodar(b);
    ok(!r.ok && r.nao_preparado && intacto(b) && /sql\/historico-troca-segura\.sql/.test(r.msg), '⚠️ banco sem o script: ABORTA pedindo o script — nunca cai no jeito antigo'); }
  { const b = banco({ semFuncao: true }); const r = await rodar(b);
    ok(!r.ok && r.nao_preparado && intacto(b) && b.rasc.length === 0, '  tabela sem a funcao: idem, e limpa o rascunho'); }
  { const b = banco({ rpcRecusa: true }); const r = await rodar(b);
    ok(!r.ok && !r.transitorio && intacto(b) && b.rasc.length === 0, '  o banco recusa a troca (400): historico intacto, rascunho limpo'); }
  { const b = banco({ rpcPerdeDepois: true }); const r = await rodar(b);
    ok(r.ok && r.confirmado_por === 'registro da troca no banco' && periodoGood(b) === 'N1,N2,N3', '⚠️ resposta perdida DEPOIS de aplicar: o banco resolve como confirmada -> ok'); }
  { const b = banco({ rpcPerdeAntes: true }); const r = await rodar(b);
    ok(!r.ok && !r.incerto && intacto(b) && b.rasc.length === 0 && /lote cancelado/.test(r.msg), '⚠️ resposta perdida e a troca nao rodou: o banco CANCELA o lote -> ABORTA, historico intacto');
    const tarde = await b.atrasada();
    ok(!tarde.ok && intacto(b), '⚠️ a troca ATRASADA (estava na fila) chega depois do cancelamento e e desfeita — o historico continua intacto (Codex #694)'); }
  { const b = banco({ rpcLenta: true, rodandoAte: 4 }); const r = await rodar(b);
    ok(r.ok && periodoGood(b) === 'N1,N2,N3' && b.status === 4, '⚠️ troca LENTA: o banco diz rodando, o backfill espera e confirma quando termina (' + b.status + ' consultas)'); }
  { const b = banco({ rpcPerdeAntes: true, semResolver: true }); const r = await rodar(b);
    ok(!r.ok && r.incerto && intacto(b) && b.rasc.length === 3, '  script antigo sem o resolver: nao da pra cercar a troca atrasada -> INCERTO, sem apagar nada'); }
  { const b = banco({ rpcPerdeAntes: true, resolverFalha: true }); const r = await rodar(b);
    ok(!r.ok && r.incerto && intacto(b), '  o resolver tambem falha: INCERTO (nunca ok, nunca "nao tocado")'); }
  { const b = banco(); const r = await rodar(b, { esperadas: 5 });
    ok(!r.ok && intacto(b) && b.rasc.length === 0 && !b.chamadas.includes('POST rpc/trocar_periodo_historico'), '  rascunho com menos linhas que o coletado: ABORTA antes da troca'); }
  { const b = banco(); const velho = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
    b.rasc.push({ lote: 'abandonado', criado_em: velho, empresa: 'good', numero_pedido: 'X' });
    b.rasc.push({ lote: 'de-outra', criado_em: velho, empresa: 'girassol', numero_pedido: 'Y' });
    const r = await rodar(b);
    ok(r.ok && !b.rasc.some((x) => x.lote === 'abandonado') && b.rasc.some((x) => x.lote === 'de-outra'), '  rascunho abandonado (reinicio) da empresa e limpo; o de outra empresa nao'); }

  { // Codex #694: periodo SEM venda e a troca nao chegou ao banco — rascunho vazio NAO prova a troca
    const b = banco({ rpcPerdeAntes: true }); const r = await rodar(b, { lerLotes: lerLotesDe([], 2), esperadas: 0 });
    ok(!r.ok && intacto(b) && /NAO aconteceu/.test(r.msg), '⚠️ periodo sem venda + troca que nao chegou ao banco: o banco cancela o lote -> ABORTA, historico intacto');
    const tarde = await b.atrasada();
    ok(!tarde.ok && intacto(b), '⚠️ periodo sem venda: a troca atrasada (0 = 0 passaria na contagem) bate no lote cancelado e e desfeita'); }
  { const b = banco({ rpcPerdeDepois: true }); const r = await rodar(b, { lerLotes: lerLotesDe([], 2), esperadas: 0 });
    ok(r.ok && periodoGood(b) === '' && r.confirmado_por === 'registro da troca no banco', '  periodo sem venda + troca confirmada: o REGISTRO da troca prova (o periodo fica vazio)'); }
  { const b = banco({ rpcPerdeAntes: true, semResolver: true }); const r = await rodar(b, { lerLotes: lerLotesDe([], 2), esperadas: 0 });
    ok(!r.ok && r.incerto && intacto(b), '  periodo sem venda, sem o resolver: INCERTO'); }
  // os dois escritores usam a peca e nao apagam/gravam mais o periodo direto
  /* 29/10 (3b-2): a AMB roda o backfill COMPARTILHADO — o escritor do período é um só (o da Girassol, conferido abaixo) */
  ok(fs.readFileSync(path.join(__dirname, '..', 'amb-checkout-offline/index.js'), 'utf8').includes("require('../girassol-backup-offline/gbo-app').backfillVendas(de, ate, 'amb', _ctxBackfillAmb())"), '⚠️ amb: roda o backfill compartilhado (o escritor único)');
  for (const f of ['girassol-backup-offline/gbo-app.js']) {
    const s = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    const i = s.indexOf("require('../lib/checkout/troca-periodo-historico').trocarPeriodoHistorico");
    ok(i > 0 && /esperadas: coletados, dorme \}\);/.test(s.slice(i, i + 300)), '⚠️ ' + f + ' troca o periodo pela peca segura');
    // so o escritor do PERIODO (backfillVendas) — o refazer do frete Magalu e outra rotina, com rollback proprio
    const ini = s.indexOf('async function backfillVendas'); const fim = s.indexOf('_backfill.fora = foraDoPeriodo;', ini);
    const bf = (ini >= 0 && fim > ini) ? s.slice(ini, fim) : '';
    ok(bf && !/'DELETE',\s*'vendas_historico\?empresa=eq\.'/.test(bf) && !/'POST',\s*'vendas_historico',/.test(bf),
       '  ' + f + ': o backfill nao apaga nem grava mais o periodo direto no historico');
  }
  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'historico-troca-segura.sql'), 'utf8');
  ok(/information_schema\.columns c[\s\S]{0,200}table_name = 'vendas_historico'[\s\S]{0,400}execute format\('insert into public\.vendas_historico \(%s\) select %s/.test(sql)
     && /veio preenchida em % linha\(s\) — nada trocado/.test(sql), '⚠️ o SQL copia so as colunas que o historico DESTE projeto tem (a Girassol nao tem credito_ml) e recusa perder dado (Codex #694)');
  ok(/alter table public\.vendas_historico_rascunho enable row level security;/.test(sql) && /revoke all on table public\.vendas_historico_rascunho from anon, authenticated;/.test(sql)
     && /revoke execute on function public\.trocar_periodo_historico\([^)]*\) from public, anon, authenticated;/.test(sql)
     && /grant execute on function public\.trocar_periodo_historico\([^)]*\) to service_role;/.test(sql)
     && /perform pg_advisory_xact_lock\(hashtext\('vh_troca:' \|\| p_lote\)\);/.test(sql) && /perform pg_advisory_xact_lock\(hashtext\('vh_troca_empresa:' \|\| p_empresa\)\);/.test(sql) , '⚠️ rascunho e troca so pro servico (RLS, revoke da chave publica, grant ao service_role — Codex #694)');
  ok(/delete from vendas_historico where empresa = p_empresa and data_venda >= p_de and data_venda <= p_ate/.test(sql)
     && /if v_rasc <> p_esperadas then\s*raise exception/.test(sql) && /delete from vendas_historico_rascunho where lote = p_lote/.test(sql),
     '  o SQL confere a quantidade, apaga com o MESMO filtro de antes, copia e limpa o rascunho');

  // Codex #694: o cliente do banco nao pede corpo vazio pra FUNCAO (senao o status da troca nunca e lido)
  {
    const sup = require('../lib/supabase.js'); const vistos = [];
    const fOrig = global.fetch;
    global.fetch = async (url, op) => { vistos.push({ url, prefer: op.headers.Prefer }); return { ok: true, status: 200, text: async () => '{"rodando":false,"rascunho":0}' }; };
    process.env.SUPABASE_URL_VENDAS_TESTE = 'https://x.supabase.co'; process.env.SUPABASE_KEY_VENDAS_TESTE = 'k';
    const r1 = await sup.req('teste', null, 'POST', 'rpc/troca_historico_status', { p_lote: 'L' });
    await sup.req('teste', null, 'POST', 'vendas_historico_rascunho', [{ a: 1 }]);
    global.fetch = fOrig;
    ok(vistos[0] && vistos[0].prefer !== 'return=minimal' && /"rodando":false/.test(r1.body || ''), '⚠️ chamada de funcao (rpc/) volta com o resultado no corpo (sem return=minimal) — Codex #694');
    ok(vistos[1] && vistos[1].prefer === 'return=minimal', '  gravacao comum continua com return=minimal');
  }
  console.log('');
  if (falhas) { console.log('FALHOU: ' + falhas + ' caso(s)'); process.exit(1); }
  console.log('OK: troca segura do periodo — falha em qualquer etapa deixa o historico como estava; os 2 escritores usam a peca');
})().catch((e) => { console.log('FALHOU (excecao): ' + (e && e.stack)); process.exit(1); });
