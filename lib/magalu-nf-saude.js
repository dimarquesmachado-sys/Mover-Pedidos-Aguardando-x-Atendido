'use strict';
/* 13/11 — A SAÚDE DA RODADA DAS NOTAS DA MAGALU (magalu-oauth, "NF Full").
   Caso real (12/11, AMB): a extensão avisou "o servidor não verifica a Magalu desde 11/11 23:02 (15h atrás) — alguma coisa
   travou, confira o serviço no Render". O dia teve vários deploys; a rodada leva minutos (há 2 min de espera entre as
   empresas) e um reinício no meio a mata — e ninguém a refazia até o próximo horário da agenda (6h, 12h, 18h, 23h).
   Além disso o "verificado" de cada empresa era lido da ÚLTIMA rodada: uma rodada só de outra empresa (o botão "só GOOD")
   ou interrompida apagava a informação desta, e o aviso acendia sem a empresa ter falhado.

   Esta peça guarda a última verificação BOA de CADA empresa (não some com a rodada seguinte) e decide quando refazer:
   · empresa sem verificação boa há mais que o limite (o maior intervalo da agenda, com folga) → recuperar SÓ ela;
   · no máximo uma recuperação a cada `esperaMs` (se a Magalu está fora, não adianta martelar);
   · com uma rodada em andamento, espera.
   Pura: recebe o estado e devolve a decisão. Quem agenda e quem grava é o magalu-oauth. */

const LIMITE_MS = 7.5 * 3600000;   /* a agenda tem no máximo 7h entre duas rodadas (23h → 6h); 7h30 dá a folga da própria rodada */
const ESPERA_MS = 60 * 60000;      /* entre duas recuperações */

/** junta ao mapa { empresa: ISO } as empresas que a rodada terminada verificou com sucesso ("sem notas" também é sucesso). */
function registrarRodada(mapa, estado) {
  const out = Object.assign({}, (mapa && typeof mapa === 'object') ? mapa : {});
  if (!estado || !estado.fim || !Array.isArray(estado.resultado)) return out;
  for (const l of estado.resultado) if (l && l.empresa && l.ok) out[String(l.empresa)] = { em: estado.fim, vazio: !!l.vazio };
  return out;
}

/** a última verificação boa da empresa: { em, vazio } ou null. Aceita o formato antigo (só a rodada) como reserva. */
function verificadoDe(mapa, estado, empresa) {
  const m = mapa && mapa[empresa];
  if (m && m.em) return { em: m.em, vazio: !!m.vazio };
  const l = estado && estado.fim && Array.isArray(estado.resultado) ? estado.resultado.find((x) => x && x.empresa === empresa) : null;
  return (l && l.ok) ? { em: estado.fim, vazio: !!l.vazio } : null;
}

/** decide se é hora de refazer. Devolve { recuperar, quais, motivo }. */
function precisaRecuperar(o) {
  const agora = o.agoraMs, limite = o.limiteMs == null ? LIMITE_MS : o.limiteMs, espera = o.esperaMs == null ? ESPERA_MS : o.esperaMs;
  const empresas = Array.isArray(o.empresas) ? o.empresas : [];
  if (o.rodando) return { recuperar: false, quais: [], motivo: 'rodada em andamento' };
  if (!empresas.length) return { recuperar: false, quais: [], motivo: 'nenhuma empresa ativa' };
  const atrasadas = empresas.filter((e) => {
    const v = verificadoDe(o.verificados, o.estado, e);
    const t = v ? Date.parse(v.em) : NaN;
    return !(isFinite(t) && agora - t <= limite);
  });
  if (!atrasadas.length) return { recuperar: false, quais: [], motivo: 'todas verificadas dentro do prazo' };
  const ultimaTentativa = Number(o.ultimaRecuperacaoMs) || 0;
  if (ultimaTentativa && agora - ultimaTentativa < espera) return { recuperar: false, quais: atrasadas, motivo: 'já tentei recuperar há pouco' };
  return { recuperar: true, quais: atrasadas, motivo: 'sem verificação boa há mais de ' + (Math.round(limite / 360000) / 10) + ' h' };
}

module.exports = { registrarRodada, verificadoDe, precisaRecuperar, LIMITE_MS, ESPERA_MS };
