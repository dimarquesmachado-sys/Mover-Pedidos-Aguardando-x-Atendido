'use strict';

/**
 * lib/ml-billing-mapa.js — o mapa de tarifas por pedido, SEM carregar o billing inteiro (04/09).
 *
 * O QUE QUEBROU: o _ml_billing.json chegou a 96.293 tarifas — 15 MB em disco e ~28 MB de heap
 * a cada JSON.parse. O gbo-app fazia esse parse em SETE pontos (mapa do backfill, cards do
 * dashboard, canário, rotas de consulta). Bastavam alguns coincidirem pra estourar os 512 MB
 * do plano e o Node abortar com status 134 — foi o que derrubou o serviço três vezes em 03/09
 * e duas em 04/09, sempre com o backfill em curso, às vezes com só 14 pedidos varridos.
 *
 * O arquivo cresceu por causa das PRÓPRIAS melhorias da véspera: classificar tudo, guardar 90
 * caracteres de descrição e o campo `cartao` engordaram cada registro, e o re-sync completo
 * trouxe 12 períodos de uma vez.
 *
 * COMO RESOLVE: o mapa que interessa é minúsculo — soma de comissão e frete por número de
 * pedido. Em vez de carregar tudo pra montá-lo toda vez, esta lib:
 *   1. lê o billing UMA vez em STREAM (nunca o arquivo inteiro na memória);
 *   2. grava o resultado num índice pequeno em disco (_ml_billing_mapa.json);
 *   3. nas próximas chamadas devolve o índice, se ele for mais novo que o billing.
 * Assim o backfill não paga o custo de 28 MB a cada mês, e nenhuma rota paga duas vezes.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CATS_PEDIDO = new Set(['comissao', 'mp', 'parcelamento', 'antecipacao']);

function arqMapa(cacheDir) { return path.join(cacheDir, '_ml_billing_mapa.json'); }
function arqBilling(cacheDir) { return path.join(cacheDir, '_ml_billing.json'); }

/** O índice em disco ainda vale? (existe e é mais novo que o billing) */
function indiceValido(cacheDir) {
  try {
    const a = fs.statSync(arqMapa(cacheDir)), b = fs.statSync(arqBilling(cacheDir));
    return a.mtimeMs >= b.mtimeMs;
  } catch (e) { return false; }
}

/**
 * Monta o mapa lendo o billing em stream. O JSON é um objeto único, então não dá pra ler
 * linha a linha como JSONL — mas o arquivo é gravado com indentação de 2 espaços, o que põe
 * uma tarifa por bloco. Lemos por pedaços e extraímos os campos que importam com um
 * varredor de chaves, sem materializar o objeto todo.
 */
async function montar(cacheDir) {
  const com = {}, fre = {};
  const poe = (alvo, chave, v) => { if (!chave) return; const k = String(chave); alvo[k] = Math.round(((alvo[k] || 0) + v) * 100) / 100; };
  const arq = arqBilling(cacheDir);
  if (!fs.existsSync(arq)) return { com, fre, tarifas: 0, vazio: true };

  /* uma tarifa por linha no arquivo indentado: {"d":"...","v":1.23,"c":"comissao","o":"200...","p":null,...}
     lemos linha a linha e pegamos só as 4 chaves necessárias, com regex — sem JSON.parse do todo */
  const rl = readline.createInterface({ input: fs.createReadStream(arq, { encoding: 'utf8' }), crlfDelay: Infinity });
  let n = 0, buf = '';
  for await (const linha of rl) {
    /* o arquivo é gravado com JSON.stringify(obj, null, 2): cada tarifa ocupa várias linhas.
       Acumulamos até fechar a chave e então extraímos. */
    buf += linha;
    if (buf.indexOf('}') < 0) continue;
    const mv = /"v"\s*:\s*(-?[\d.]+)/.exec(buf);
    const mc = /"c"\s*:\s*"([^"]*)"/.exec(buf);
    if (mv && mc) {
      const cat = mc[1];
      const alvo = CATS_PEDIDO.has(cat) ? com : (cat === 'frete' ? fre : null);
      if (alvo) {
        const v = Number(mv[1]) || 0;
        const mo = /"o"\s*:\s*"?([^",}]*)"?/.exec(buf);
        const mp = /"p"\s*:\s*"?([^",}]*)"?/.exec(buf);
        const o = mo && mo[1] !== 'null' ? mo[1] : null;
        const p = mp && mp[1] !== 'null' ? mp[1] : null;
        poe(alvo, o, v);
        if (p && p !== o) poe(alvo, p, v);
      }
      n++;
    }
    buf = '';
  }
  return { com, fre, tarifas: n };
}

/** Mapa pronto: usa o índice em disco quando válido, senão monta e grava. */
async function mapas(cacheDir, opcoes) {
  const o = opcoes || {};
  if (!o.forcar && indiceValido(cacheDir)) {
    try {
      const m = JSON.parse(fs.readFileSync(arqMapa(cacheDir), 'utf8'));
      if (m && m.com && m.fre) return Object.assign(m, { doIndice: true });
    } catch (e) { /* índice corrompido: remonta */ }
  }
  const m = await montar(cacheDir);
  try { fs.writeFileSync(arqMapa(cacheDir), JSON.stringify(m)); } catch (e) {}
  return Object.assign(m, { doIndice: false });
}

module.exports = { mapas, montar, indiceValido };
