'use strict';

/**
 * lib/canario-conserto.js — o canário deixa de só apontar e passa a consertar (06/09).
 *
 * O dono perguntou por que a venda que o canário acha não é reimportada sozinha, e a resposta
 * honesta era: porque ninguém tinha feito. Os dois casos que ele detecta são bem diferentes:
 *
 *   • POUCAS vendas fora do Bling → dá pra reimportar uma a uma, e o sistema já sabe
 *     (girassol/importarPedido.js). É o que esta lib faz.
 *   • MUITAS vendas fora → é integração caída ou token vencido, e aí reimportar uma a uma não
 *     resolve nada: precisa de reautorização no navegador, que nenhum código faz. Esse caso
 *     vira aviso na tela do checkout e do dashboard.
 *
 * AS TRAVAS existem por uma razão medida, não teórica: nesta mesma semana o canário acusou 54
 * vendas que estavam todas no Bling (era a janela de datas). Se ele reimportasse sozinho, teria
 * criado 54 pedidos duplicados — com estoque, NF e imposto. Então:
 *   1. TETO BAIXO. Acima de `maxAuto` vendas não conserta nada: muita falta é sintoma de
 *      integração, não de venda perdida.
 *   2. CONFERE ANTES DE CRIAR. Cada venda é reconferida no Bling na hora, com a janela larga —
 *      se já estiver lá, não duplica.
 *   3. UMA POR VEZ, com pausa, pra não estourar a cota do Bling.
 *   4. REGISTRA TUDO em disco: o que criou, o que pulou e por quê.
 */

const fs = require('fs');
const path = require('path');

function arq(cacheDir) { return path.join(cacheDir, '_canario_conserto.json'); }

function historico(cacheDir, limite) {
  try {
    const h = JSON.parse(fs.readFileSync(arq(cacheDir), 'utf8'));
    return Array.isArray(h) ? h.slice(0, limite || 50) : [];
  } catch (e) { return []; }
}

function anotar(cacheDir, registro) {
  const h = historico(cacheDir, 200);
  h.unshift(Object.assign({ quando: new Date().toISOString() }, registro));
  try { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(arq(cacheDir), JSON.stringify(h.slice(0, 200), null, 2)); } catch (e) {}
}

/**
 * @param resultado  o que canario-marketplace.conferir() devolveu
 * @param ctx        { cacheDir, maxAuto, reimportar(canal, venda) -> {ok, pedido?, erro?},
 *                     jaEstaNoBling(canal, venda) -> bool }
 */
async function consertar(resultado, ctx) {
  const maxAuto = ctx.maxAuto || 5;
  const saida = { tentou: 0, criados: [], pulados: [], erros: [], nao_automatico: [] };
  if (!resultado || !resultado.ok || !Array.isArray(resultado.alertas)) return saida;

  for (const a of resultado.alertas) {
    const canal = a.canal;
    const info = (resultado.por_canal || {})[canal] || {};
    const faltando = info.exemplos || [];
    /* trava 1: muita falta = integração, não venda perdida. Não mexe — só sinaliza. */
    if (a.gravidade === 'grave' || a.faltando > maxAuto) {
      saida.nao_automatico.push({
        canal, faltando: a.faltando, de: a.de, pct: a.pct,
        motivo: a.faltando > maxAuto
          ? (a.faltando + ' vendas fora do Bling — acima do teto de ' + maxAuto + ' pra conserto automático. Muita falta é sintoma de integração caída, e reimportar uma a uma não resolveria.')
          : 'o canário classificou como GRAVE (provável integração caída ou token vencido)',
        o_que_fazer: a.o_que_fazer || null
      });
      continue;
    }
    if (typeof ctx.reimportar !== 'function') continue;
    for (const venda of faltando.slice(0, maxAuto)) {
      saida.tentou++;
      /* trava 2: reconfere na hora, com a janela larga — o canário pode ter errado */
      if (typeof ctx.jaEstaNoBling === 'function') {
        let ja = false;
        try { ja = await ctx.jaEstaNoBling(canal, venda); } catch (e) { ja = false; }
        if (ja) { saida.pulados.push({ canal, venda, motivo: 'reconferido: já está no Bling — o canário errou, nada a fazer' }); continue; }
      }
      let r = null;
      try { r = await ctx.reimportar(canal, venda); }
      catch (e) { r = { ok: false, erro: String(e.message || e).slice(0, 200) }; }
      if (r && r.ok) saida.criados.push({ canal, venda, pedido: r.pedido || null });
      else saida.erros.push({ canal, venda, erro: (r && r.erro) || 'falhou sem mensagem' });
      /* trava 3: uma por vez, com pausa */
      await new Promise(s => setTimeout(s, 1500));
    }
  }
  /* trava 4: registro do que foi feito */
  if (saida.tentou || saida.nao_automatico.length) anotar(ctx.cacheDir, saida);
  return saida;
}

module.exports = { consertar, historico };
