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

module.exports = { comPrazo };
