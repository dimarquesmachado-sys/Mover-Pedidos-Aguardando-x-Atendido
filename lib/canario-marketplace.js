'use strict';
// ════════════════════════════════════════════════════════════════════════════════
//  CANÁRIO MARKETPLACE × BLING — código único, multi-empresa (16/08/2026)
// ════════════════════════════════════════════════════════════════════════════════
//  Pedido do Diego, depois do token Bling↔Shopee da Girassol expirar em silêncio:
//  *"o Bling não é o rei, quem manda tem que ser o marketplace. Tinha que ter um canário
//   pegando os dados dos marketplaces e comparando com o Bling — senão dá discrepância."*
//
//  O ESTRAGO QUE ISSO PEGA (caso real de 15-16/08): 28 pedidos da Shopee não desceram
//  para o Bling porque o token da integração venceu (dura ~365 dias e o Bling NÃO avisa).
//  Sintoma que chegou primeiro: o Jodda mostrava R$ 15 mil de faturamento no dia e o
//  nosso painel R$ 11 mil — a diferença era exatamente os pedidos ausentes. Antes disso,
//  o mesmo aconteceu com a GOOD em 11/08 (estoquista um dia inteiro sem pedido Shopee).
//
//  A regra que este canário implementa: a VENDA existe no marketplace. Se ela não está
//  no Bling, o Bling é que está errado — e alguém precisa saber HOJE, não no fechamento.
//
//  ctx = { listarNoMarketplace(canal, deTs, ateTs) -> [ids]     (null = canal sem fonte)
//          listarNoBling(de, ate) -> { canal: Set(numero_loja) }
//          empresa }
const _dia = ts => new Date(ts * 1000).toISOString().slice(0, 10);

async function conferir(ctx, dias, canais) {
  const nDias = Math.min(30, Math.max(1, Number(dias) || 3));
  const fim = Math.floor(Date.now() / 1000);
  const ini = fim - nDias * 86400;
  const alvo = (canais && canais.length) ? canais : ['shopee', 'tiktok', 'ml'];

  let noBling = {};
  try { noBling = await ctx.listarNoBling(_dia(ini), _dia(fim)); }
  catch (e) { return { ok: false, erro: 'não consegui listar o Bling: ' + String(e.message || e).slice(0, 160) }; }

  const porCanal = {};
  const alertas = [];
  const naoVerificados = [];
  for (const canal of alvo) {
    let ids = null;
    try { ids = await ctx.listarNoMarketplace(canal, ini, fim); }
    catch (e) {
      // Codex (P1): se a consulta ao marketplace FALHA, o canário não pode dizer que está
      // tudo certo — ele não verificou nada. Canal com erro deixa o veredito indeterminado.
      porCanal[canal] = { erro: String(e.message || e).slice(0, 200), verificado: false };
      naoVerificados.push(canal);
      continue;
    }
    if (ids === null) { porCanal[canal] = { sem_fonte: true, nota: 'sem API conectada para este canal — nada a comparar' }; continue; }

    // Codex (P2/P1): lista truncada = comparação sem valor. O coletor sinaliza com
    // `{ incompleto: true }` e o canal fica NÃO VERIFICADO em vez de acusar falso positivo.
    if (ids && ids.incompleto) {
      porCanal[canal] = { erro: 'lista do marketplace veio TRUNCADA (' + (ids.motivo || 'limite de páginas') + ') — comparação não confiável', verificado: false };
      naoVerificados.push(canal);
      continue;
    }
    const doBling = noBling[canal] || new Set();
    const faltando = ids.filter(x => !doBling.has(String(x).trim()));
    const pct = ids.length ? Math.round(faltando.length / ids.length * 1000) / 10 : 0;
    porCanal[canal] = {
      no_marketplace: ids.length, no_bling: doBling.size,
      faltando_no_bling: faltando.length, pct_faltando: pct,
      exemplos: faltando.slice(0, 15)
    };
    // ⚠️ o alerta é por AUSÊNCIA, não por diferença de valor: pedido que existe na venda e
    // não existe no Bling é venda que some do dashboard, do imposto e do estoque.
    if (faltando.length >= 3 || (faltando.length >= 1 && pct >= 10)) {
      alertas.push({
        canal, faltando: faltando.length, de: ids.length, pct,
        provavel: 'integração Bling↔' + canal + ' caída ou token expirado (vence ~365 dias e o Bling não avisa)',
        o_que_fazer: 'Bling → Canais de venda → ' + canal + ' → reautorizar; depois rode o backfill do período'
      });
    }
  }
  return {
    ok: true, empresa: ctx.empresa || null, dias: nDias,
    periodo: { de: _dia(ini), ate: _dia(fim) },
    por_canal: porCanal, alertas,
    nao_verificados: naoVerificados,
    veredito: alertas.length
      ? '🔴 ' + alertas.length + ' canal(is) com venda que NÃO chegou ao Bling — ver `alertas`'
      : (naoVerificados.length
          ? '⚠️ INDETERMINADO: não consegui verificar ' + naoVerificados.join(', ') + ' — o silêncio aqui NÃO quer dizer que está tudo certo'
          : '✅ todo pedido do marketplace no período está no Bling'),
    nota: 'a fonte da verdade é o MARKETPLACE. O Bling é espelho: o que está lá e não aqui é problema do espelho, não da venda.'
  };
}

module.exports = { conferir };
