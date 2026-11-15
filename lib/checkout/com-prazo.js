'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   PRAZO PRO PEDIDO INTEIRO (15/11/2026, Codex #883).

   Uma ida à rede sem prazo pode nunca voltar: o outro lado aceita a conexão e emudece, e o `await` fica pendurado pra
   sempre. No chat de análise isso prende a pergunta (o prazo da API do modelo não cobre a consulta); na rotina da
   madrugada prende a etapa — e as seguintes nunca rodam.

   `comPrazo(ms, fn, noEstouro)` roda `fn(sinal)` e devolve o que ela devolver. Se passar de `ms`:
     · o `sinal` é abortado (quem recebeu cancela a conexão de verdade — `fetch(..., { signal })`, `blingGet(u, n, sinal)`);
     · a espera ACABA do mesmo jeito, mesmo que `fn` não obedeça o sinal, e o resultado é `noEstouro()`.
   O prazo cobre tudo o que `fn` faz (buscar o token, ir à rede, ler o corpo). Se `fn` falhar antes do prazo, a falha
   passa adiante como sempre; o que ela fizer DEPOIS de estourar é ignorado (inclusive falhar).
   ───────────────────────────────────────────────────────────────────────────── */
function comPrazo(ms, fn, noEstouro) {
  const ac = new AbortController();
  let relogio = null;
  const estouro = new Promise((resolver) => {
    relogio = setTimeout(() => { try { ac.abort(); } catch (e) { /* o prazo vale mesmo sem conseguir abortar */ } resolver(noEstouro()); }, ms);
  });
  /* (a corrida fica de ouvinte das duas: se `fn` perder e falhar depois, a falha não fica solta — o teste confere) */
  const trabalho = Promise.resolve().then(() => fn(ac.signal));
  return Promise.race([trabalho, estouro]).finally(() => clearTimeout(relogio));
}

/* VÁRIOS PEDIDOS EM SEQUÊNCIA (15/11/2026 — os leitores de anúncios e de saúde da conta): um prazo por pedido E um prazo
   pro conjunto. Devolve `ir(fn, noEstouro, semTempo)`:
     · roda `fn(sinal)` com o que sobrar do total — no máximo `passoMs`; estourou, devolve `noEstouro()`;
     · se o total já acabou (ou sobra menos que `MINIMO_PRA_OUTRO_PEDIDO_MS`), NEM COMEÇA: devolve `semTempo()`.
   Assim um pedido que emudece custa só o prazo dele, e os que já responderam continuam valendo — quem chama entrega
   o que conseguiu ler e diz o que faltou. (O relógio do Node pode disparar uns ms antes do prazo: "sobrou 2 ms" não é
   tempo pra outro pedido.) */
const MINIMO_PRA_OUTRO_PEDIDO_MS = 300;
function prazoEmSequencia(totalMs, passoMs) {
  const acaba = Date.now() + totalMs;
  return (fn, noEstouro, semTempo) => {
    const resta = acaba - Date.now();
    if (resta < MINIMO_PRA_OUTRO_PEDIDO_MS) return Promise.resolve(semTempo());
    return comPrazo(Math.min(passoMs, resta), fn, noEstouro);
  };
}

module.exports = { comPrazo, prazoEmSequencia, MINIMO_PRA_OUTRO_PEDIDO_MS };
