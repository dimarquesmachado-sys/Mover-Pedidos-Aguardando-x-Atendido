'use strict';

/**
 * lib/embarcar-empresa.js — LIGAR UMA EMPRESA COM UM COMANDO (30/08).
 *
 * O pedido do dono, com as palavras dele: "quando for ligar/plugar empresa nova, já ficasse
 * tudo resolvido — não quero ficar tendo que ir atrás de criar supabase, baixar histórico do
 * ML, depois TikTok, depois cancelada do Magalu, caçando code, id e token".
 *
 * O que descobri conferindo antes de escrever, e que torna isso viável:
 *   • o SUPABASE JÁ É MULTI-EMPRESA — lib/supabase.js recebe a empresa e lê
 *     SUPABASE_URL_VENDAS_<EMPRESA> / SUPABASE_KEY_VENDAS_<EMPRESA>. Não há nada a criar,
 *     só a env a preencher (e o diagnóstico abaixo diz exatamente qual falta).
 *   • as coletas de TikTok, Magalu e Shopee já recebem a loja como parâmetro.
 * Ou seja: o trabalho não era construir, era ORQUESTRAR — e ninguém tinha juntado as peças.
 *
 * Esta peça não inventa coleta nova: chama as que existem, na ordem, e diz o que faltou.
 * O diagnóstico roda ANTES e sozinho (?so_conferir=1), pra não descobrir no meio que falta
 * um token e deixar a empresa meio embarcada.
 */

function conferir(empresa) {
  const E = String(empresa || '').toUpperCase();
  const emp = String(empresa || '').toLowerCase();
  const tem = (v) => !!process.env[v];
  const itens = [];

  /* Supabase do histórico — a base de tudo; sem isso não há dashboard */
  itens.push({ nome: 'Supabase do histórico', ok: tem('SUPABASE_URL_VENDAS_' + E) && tem('SUPABASE_KEY_VENDAS_' + E),
    falta: 'SUPABASE_URL_VENDAS_' + E + ' e SUPABASE_KEY_VENDAS_' + E,
    como: 'a TABELA já é multi-empresa (coluna empresa) — basta apontar as envs pro mesmo projeto das outras' });

  /* Bling da empresa — de onde saem os pedidos */
  const blingVar = { girassol: 'BLING_CLIENT_ID', good: 'GOOD_BLING_CLIENT_ID', amb: 'AMB_BLING_CLIENT_ID' }[emp];
  itens.push({ nome: 'Bling', ok: !!blingVar && tem(blingVar), falta: blingVar || '(empresa sem mapeamento de Bling)',
    como: 'autorizar uma vez em /<empresa>/bling/callback' });

  /* Marketplaces — cada um com o seu sinal de "está ligado" */
  itens.push({ nome: 'TikTok', ok: (String(process.env.TIKTOK_LOJAS || 'girassol,amb,good').split(',').map(s => s.trim()).indexOf(emp) >= 0),
    falta: 'nome da empresa em TIKTOK_LOJAS', como: 'acrescentar na env e autorizar em /tiktok/conectar?loja=' + emp });
  itens.push({ nome: 'Magalu', ok: ['girassol', 'good', 'amb'].indexOf(emp) >= 0,
    falta: 'empresa em EMPRESAS_VALIDAS do magalu-oauth', como: 'autorizar em /magalu/conectar?empresa=' + emp });

  const faltando = itens.filter(i => !i.ok);
  return { empresa: emp, pronto: faltando.length === 0, itens, faltando: faltando.map(i => i.nome) };
}

/**
 * Roda as coletas de histórico da empresa, em sequência, tolerando falha de cada uma.
 * `passos` recebe as funções já existentes — nada aqui reimplementa coleta.
 */
async function embarcar(empresa, passos, opcoes) {
  const o = opcoes || {};
  const dias = Math.min(365, Math.max(1, Number(o.dias) || 180));
  const conf = conferir(empresa);
  /* não começa pela metade: se falta credencial, o embarque para aqui e diz o que falta */
  if (!conf.pronto && !o.forcar) {
    return { ok: false, empresa: conf.empresa, parou_antes: true, conferencia: conf,
      erro: 'faltam credenciais: ' + conf.faltando.join(', ') + ' — resolva e rode de novo (ou &forcar=1 pra tentar o que dá)' };
  }
  const feitos = [];
  for (const p of (passos || [])) {
    const t0 = Date.now();
    try {
      const r = await p.rodar(empresa, dias);
      feitos.push({ passo: p.nome, ok: !(r && r.ok === false), segundos: Math.round((Date.now() - t0) / 1000), resumo: r && r.erro ? r.erro : (r && r.resumo) || 'ok' });
    } catch (e) {
      /* uma coleta falhar não pode abortar o embarque inteiro — as outras seguem */
      feitos.push({ passo: p.nome, ok: false, segundos: Math.round((Date.now() - t0) / 1000), resumo: String(e.message || e).slice(0, 140) });
    }
    await new Promise(s => setTimeout(s, 500));
  }
  const falharam = feitos.filter(f => !f.ok);
  return { ok: falharam.length === 0, empresa: conf.empresa, dias, conferencia: conf, passos: feitos,
    falharam: falharam.map(f => f.passo),
    leia: falharam.length ? 'o que falhou pode ser rodado de novo isoladamente — o embarque é idempotente' : 'empresa embarcada: histórico coletado e coletas diárias já cobrem ela' };
}

module.exports = { conferir, embarcar };
