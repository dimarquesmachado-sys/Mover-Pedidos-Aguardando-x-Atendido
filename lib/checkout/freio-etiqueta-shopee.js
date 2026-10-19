'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   FREIO DA ETIQUETA SHOPEE (19/10/2026) — peça única pros três checkouts.

   Quando o Bling não traz a etiqueta da Shopee, o ciclo busca DIRETO no serviço da Shopee (multi-loja). Sem freio, um
   pedido que não vai resolver sozinho repete a mesma chamada a cada ciclo pra sempre (30/07, AMB: o caso 2577 falhou
   18x seguidas). A AMB tinha um freio na cópia dela — 3 falhas e ESPERA 1 HORA — e a GOOD e a Girassol não tinham
   nenhum. O dono (19/10): "quase 1 hora pra testar de novo... não pode demorar tudo isso".

   Agora, igual nas três: as 2 primeiras falhas tentam de novo no ciclo seguinte; da 3ª em diante a espera dobra —
   5, 10, 20 e no máximo 30 min. E o botão "🔄 Bling agora" do painel ZERA o freio (zerar): consertou a chave ou a
   Shopee liberou, um clique tenta de novo na hora. Vive em memória (um reinício também zera — de propósito: o freio
   é economia de chamada, não decisão).
   ───────────────────────────────────────────────────────────────────────────── */

const ESPERAS_MIN = [5, 10, 20, 30];   // da 3ª falha em diante

function esperaMs(n) {
  if (!(n >= 3)) return 0;
  return ESPERAS_MIN[Math.min(n - 3, ESPERAS_MIN.length - 1)] * 60000;
}

function criarFreio(agoraFn) {
  const agora = typeof agoraFn === 'function' ? agoraFn : () => Date.now();
  const m = new Map();
  return {
    /* null = pode tentar; senão { n, ultimo, faltaMin } */
    estado(chave) {
      const s = m.get(String(chave)); if (!s) return null;
      const falta = (s.ts + esperaMs(s.n)) - agora();
      return falta > 0 ? { n: s.n, ultimo: s.ultimo || null, faltaMin: Math.max(1, Math.ceil(falta / 60000)) } : null;
    },
    falhou(chave, motivo) { const a = m.get(String(chave)) || { n: 0 }; m.set(String(chave), { n: a.n + 1, ts: agora(), ultimo: motivo || a.ultimo || null }); },
    ok(chave) { m.delete(String(chave)); },
    zerar() { const n = m.size; m.clear(); return n; },
    tamanho() { return m.size; },
  };
}

module.exports = { criarFreio, esperaMs, ESPERAS_MIN };
