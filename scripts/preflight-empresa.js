#!/usr/bin/env node
'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   PREFLIGHT DE EMPRESA — testa o que existe FORA do código (15/09/2026).

   Bloqueador nº 5 da auditoria de prontidão: "testar Supabase e credenciais de
   Bling/ML/Shopee/Magalu/TikTok sem imprimir segredos, antes de permitir cron".

   A diferença entre este comando e o `empresa.js validar`:

     · `validar`  → a env EXISTE? (olha só o ambiente, roda em qualquer lugar)
     · `preflight`→ a env FUNCIONA? (bate nos serviços de verdade, precisa rodar
                    onde as credenciais estão — o Render, não o sandbox)

   Por que isso importa: env preenchida com valor errado passa no `validar` e
   quebra no primeiro cron, de madrugada. O preflight troca "descobrir em
   produção" por "descobrir antes".

   ⚠️ NUNCA imprime valor de credencial — só o que respondeu e o código HTTP.

   O teste de isolamento do Supabase escreve uma LINHA SENTINELA e a remove no
   fim. Ele é opt-in (--escrever) de propósito: escrever em base de produção sem
   alguém ter pedido é o tipo de ajuda que ninguém agradece.
   ──────────────────────────────────────────────────────────────────────────── */

const { carregar } = require('../lib/empresas/registro');
const supa = require('../lib/supabase');

const ESCREVER = process.argv.includes('--escrever');

function ok(msg)   { console.log('  ✓ ' + msg); }
function ruim(msg) { console.log('  ✗ ' + msg); return 1; }
function nota(msg) { console.log('  · ' + msg); }

async function checarSupabase(id) {
  console.log('\nSupabase (histórico de vendas)');
  let problemas = 0;

  const c = supa.cfg(id);
  if (!c.url || !c.key) {
    return ruim('faltam SUPABASE_URL_VENDAS_' + id.toUpperCase() + ' / SUPABASE_KEY_VENDAS_' + id.toUpperCase());
  }
  ok('credenciais presentes (url e key)');

  /* 1. a tabela responde? */
  const r = await supa.req(id, null, 'GET', '/rest/v1/vendas_historico?select=empresa&limit=1');
  if (!r.ok) {
    problemas += ruim('a tabela vendas_historico não respondeu (HTTP ' + r.status + ') — confira URL, chave e se a tabela existe');
    return problemas;
  }
  ok('tabela vendas_historico responde');

  /* 2. a coluna `empresa` existe? sem ela, o filtro por empresa não isola nada e
     uma loja lê os números da outra — o pior sintoma possível, porque parece certo. */
  const rf = await supa.req(id, null, 'GET', '/rest/v1/vendas_historico?empresa=eq.' + id + '&select=empresa&limit=1');
  if (!rf.ok) problemas += ruim('filtro por empresa falhou (HTTP ' + rf.status + ') — a coluna `empresa` existe?');
  else ok('filtro empresa=eq.' + id + ' aceito');

  /* 3. quantas linhas esta empresa já tem */
  const n = await supa.count(id, null, 'empresa=eq.' + id);
  if (n == null) nota('não consegui contar as linhas (Content-Range ausente) — não é bloqueio');
  else nota('linhas já gravadas para ' + id + ': ' + n);

  /* 4. isolamento de verdade: escreve uma sentinela e confere que ela NÃO aparece
     no filtro de outra empresa. Só com --escrever. */
  if (!ESCREVER) {
    nota('isolamento não testado (rode com --escrever pra gravar e remover uma linha sentinela)');
    return problemas;
  }

  const marca = 'PREFLIGHT-' + Date.now();
  const linha = { empresa: id, numero_loja: marca, data_venda: new Date().toISOString().slice(0, 10) };
  const ins = await supa.req(id, null, 'POST', '/rest/v1/vendas_historico', [linha]);
  if (!ins.ok) {
    problemas += ruim('não consegui INSERIR a sentinela (HTTP ' + ins.status + ') — política de escrita (RLS) ou colunas obrigatórias');
  } else {
    ok('inserção aceita');
    const lida = await supa.req(id, null, 'GET', '/rest/v1/vendas_historico?numero_loja=eq.' + marca + '&select=empresa');
    const achou = lida.ok && Array.isArray(lida.data) && lida.data.length;
    if (!achou) problemas += ruim('inseri mas não consegui LER a sentinela de volta');
    else if (lida.data[0].empresa !== id) problemas += ruim('a sentinela voltou com empresa="' + lida.data[0].empresa + '" — isolamento quebrado');
    else ok('sentinela lida de volta com a empresa certa');

    const del = await supa.req(id, null, 'DELETE', '/rest/v1/vendas_historico?numero_loja=eq.' + marca);
    if (!del.ok) problemas += ruim('NÃO consegui remover a sentinela ' + marca + ' — remova à mão, ela ficaria no histórico');
    else ok('sentinela removida');
  }
  return problemas;
}

async function checarBling(registro, id) {
  console.log('\nBling');
  const env = (s) => registro.nomeEnv(id, s);
  const faltam = ['BLING_CLIENT_ID', 'BLING_CLIENT_SECRET'].filter(s => !process.env[env(s)]);
  if (faltam.length) return ruim('faltam ' + faltam.map(env).join(', '));
  ok('credenciais presentes');
  /* não dá pra validar client_id/secret sem o fluxo OAuth completo; o que se pode dizer
     honestamente é que existem. O token em si só nasce na autorização inicial. */
  nota('só a autorização inicial prova o par id/secret — o preflight não tem como validar sozinho');
  return 0;
}

async function checarML(registro, id) {
  console.log('\nMercado Livre');
  const env = (s) => registro.nomeEnv(id, s);
  const faltam = ['ML_CLIENT_ID', 'ML_CLIENT_SECRET'].filter(s => !process.env[env(s)]);
  if (faltam.length) return ruim('faltam ' + faltam.map(env).join(', '));
  ok('credenciais presentes');

  /* o dono do refresh: duas contas renovando o mesmo token de uso único deixa uma com
     token morto. Isto é o risco nº 1 da auditoria e aparece aqui, antes do cron. */
  const e = registro.obter(id);
  const dono = (e.donoHoje && (e.donoHoje.mercadolivre || e.donoHoje.ml)) || null;
  if (dono && dono !== 'mover-pedidos') {
    nota('o refresh desta conta é do serviço "' + dono + '" — este serviço deve LER o token, nunca renovar');
  }
  return 0;
}

async function principal() {
  const alvo = process.argv[2];
  if (!alvo || alvo.startsWith('--')) {
    console.log('uso: node scripts/preflight-empresa.js <empresa> [--escrever]');
    console.log('     --escrever grava e remove uma linha sentinela pra provar o isolamento');
    console.log('\nRode ONDE as credenciais estão (o Render), não no sandbox.');
    return 2;
  }
  const registro = carregar({ servico: 'mover-pedidos' });
  const e = registro.obter(alvo);
  if (!e) { console.error('✗ "' + alvo + '" não está no contrato.'); return 1; }

  console.log('PREFLIGHT — ' + e.nome + ' (' + e.id + ')');
  console.log('Confere se as credenciais FUNCIONAM, não só se existem. Nenhum valor é impresso.');

  let problemas = 0;
  problemas += await checarSupabase(e.id);
  if (registro.temCapacidade(e.id, 'fiscal')) problemas += await checarBling(registro, e.id);
  if (registro.temCapacidade(e.id, 'ml')) problemas += await checarML(registro, e.id);

  console.log(problemas
    ? '\n✗ ' + problemas + ' problema(s) — NÃO libere os crons desta empresa ainda.'
    : '\n✓ preflight limpo' + (ESCREVER ? ' (isolamento provado com sentinela).' : ' — rode com --escrever pra provar o isolamento do Supabase.'));
  return problemas ? 1 : 0;
}

principal().then(c => process.exit(c)).catch(e => { console.error('✗ preflight quebrou: ' + (e.message || e)); process.exit(1); });
