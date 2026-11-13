'use strict';
/* 13/11 (plano multiloja, Fase 3 item 5) — A SINCRONIZAÇÃO DE CUSTO "TRAVADA", PEÇA ÚNICA.

   Toda porta que dispara o `custoSync` (a tartaruga pós-boot, a manutenção de 6 h, o disparo manual, o gatilho do
   histórico) passa por aqui pra pegar a TRAVA DO PROCESSO: a rodada de custo de uma empresa não pode sobrepor a rodada
   pesada de outra no mesmo servidor (o 503 de 13/09). Na Girassol e na AMB isso eram 9 linhas; na GOOD, 49 — ela tem
   também a RE-TENTATIVA: quem chama com `retentar` (o gatilho do histórico, quando há SKU sem custo) não é descartado se
   a trava estiver ocupada, e a rodada que termina com SKU sem custo é refeita em 3 min, até 5 vezes (e de hora em hora
   depois, se a sobra for por falha de requisição).

   A peça é o corpo da GOOD (scripts/teste-custo-sync-travado.js compara com o de antes); o que é da empresa vai por quem
   monta — a chave da trava sai do nome da empresa. Chamada SEM `retentar` (o que a Girassol e a AMB fazem hoje), ela se
   comporta como as 9 linhas delas: pega a trava, roda, solta; trava ocupada = adia sem enfileirar. Quem LIGA o gatilho
   do histórico numa empresa é o arquivo dela (`aoPublicarSkusSemCusto`) — decisão do dono, por causa da cota do Bling no
   horário do galpão; a peça só deixa a capacidade pronta pras três. */

const PECAS = ['_cst', '_histCache', 'custoSync', 'travaPesada'];

function criar(G) {
  if (!G || !G.empresa) throw new Error('lib/checkout/custo-sync-travado: falta empresa');
  for (const n of PECAS) if (!(n in G)) throw new Error('lib/checkout/custo-sync-travado: falta ' + n);
  const CHAVE = 'custo-sync:' + String(G.empresa);
  const travaPesada = G.travaPesada;
  let _custoRetentando = false;
  let _custoRetryEm = 0;   // prazo real (epoch ms) do retry pendente — o status lê daqui
  function custoRetryPendente() {
    if (!_custoRetentando || !_custoRetryEm) return null;
    return { em: new Date(_custoRetryEm).toISOString(), em_min: Math.max(0, Math.ceil((_custoRetryEm - Date.now()) / 60000)) };
  }
  let _custoTentativas = 0;   // rodadas seguidas disparadas pelo histórico que terminaram com SKU sem custo
  const CUSTO_TENTATIVAS_MAX = 5;   // SKU sem custo de verdade no Bling não pode virar loop eterno de 3 em 3 min
  /* Codex #560 (P2, r5): aceita a ESPERA como parâmetro. Padrão 3 min (trava ocupada, sobra
     dentro do teto); 1h depois do teto, quando a sobra é por falha de requisição — aí a causa é
     externa e pode durar, então insistir de 3 em 3 min só martela a cota da conta. */
  function _agendarRetryCusto(esperaMs) {
    if (_custoRetentando) return;
    _custoRetentando = true;
    const _ms = (Number.isFinite(Number(esperaMs)) && Number(esperaMs) > 0) ? Number(esperaMs) : 3 * 60 * 1000;
    _custoRetryEm = Date.now() + _ms;
    const _t = setTimeout(() => { _custoRetentando = false; _custoRetryEm = 0; try { custoSyncTravado(false, true).catch(() => {}); } catch (e) {} }, _ms);
    if (_t.unref) _t.unref();
  }
  async function custoSyncTravado(fresh, retentar) {
    const _t = travaPesada.tentarEntrar(CHAVE);
    if (!_t.ok) {
      console.log('[CUSTO] sync adiado — outra rotina pesada em curso (' + _t.ocupadoPor + ', há ' + _t.haMin + ' min)');
      /* Codex #560 (r3): quem pediu por SKU novo do histórico não pode ser descartado — a lista já
         foi gravada e nada mais dispara o sync. Um único retry pendente, a cada 3 min, até a trava
         liberar (o custoSync relê a lista inteira ao entrar). */
      /* 02/10 — O STATUS PRECISA DIZER QUE ESTÁ NA FILA. O dono rodou, viu `0/0` com
         `inicio: null`, e leu como "não fez nada" — quando era "estou esperando a trava". Ficamos
         várias idas e vindas nisso, e a informação existia aqui dentro o tempo todo, só não
         chegava na tela. Status que esconde o motivo é tão ruim quanto status errado. */
      /* Codex #566 (P2): SÓ MARCA QUANDO VAI VOLTAR. Sem retry, o pedido morre ali — e deixar
         "na fila" gravado faria o status mentir pra sempre, dizendo que alguém ainda vai tentar
         quando ninguém vai. É o mesmo erro que este PR conserta, do avesso: antes escondia o
         motivo, agora prometeria um retry que não existe.
         Sem retry, NÃO mexe na marca nem no timer: são de quem agendou o retry (Codex #566, r3). */
      if (retentar) {
        G._cst.esperando_trava = { por: _t.ocupadoPor, ha_min: _t.haMin, desde: new Date().toISOString(), vai_retentar: true };
        _agendarRetryCusto();
      } else {
        /* não toca em G._cst.esperando_trava nem no timer: esse estado é de quem agendou o retry */
        console.log('[CUSTO] pedido avulso descartado (sem retry) — a trava está com ' + _t.ocupadoPor);
      }
      return false;
    }
    delete G._cst.esperando_trava;   /* entrou: não está mais na fila */
    try {
      const _sobrou = await G.custoSync(fresh);
      /* Codex #560 (r4): a lista do histórico já está no disco, então o gatilho por "SKU novo"
         não dispara de novo. Sobrou SKU sem custo → refaz em 3 min, até CUSTO_TENTATIVAS_MAX. */
      /* Codex #560 (P2, r5): O TETO NÃO PODE VIRAR PARADA DEFINITIVA. Se o Bling estiver fora
         durante as 5 tentativas, zerar o contador e não remarcar nada deixa os SKUs sem custo
         até alguém rodar à mão — e nada mais dispara, porque a lista já está no disco.
         Distingo os dois motivos de sobrar SKU:
           · FALHA DE REQUISIÇÃO (rede, 429, 5xx) → passageira: segue tentando, mas em ritmo
             lento (1h) depois do teto, pra não martelar a cota durante uma queda longa;
           · produto achado SEM custo no Bling → não melhora sozinho: para e fica com o dono,
             que vê a lista no painel. */
      if (retentar) {
        if (_sobrou > 0 && ++_custoTentativas < CUSTO_TENTATIVAS_MAX) _agendarRetryCusto();
        else if (_sobrou > 0 && G._cst.falhas > 0) _agendarRetryCusto(60 * 60 * 1000);
        else _custoTentativas = 0;
      }
      /* o agregado do histórico cacheado antes do sync traz a contagem/margem velhas */
      try { const _hc = G._histCache; for (const _k of Object.keys(_hc)) delete _hc[_k]; } catch (e) {}

    }
    finally { travaPesada.sair(CHAVE); }
  }
  return { custoSyncTravado, custoRetryPendente };
}

module.exports = { criar, PECAS };
