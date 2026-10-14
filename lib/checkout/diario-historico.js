'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   ROTINA DIÁRIA DO HISTÓRICO — para empresa que ainda não tem noturna própria (14/10/2026).

   Achado da foto do histórico da GOOD (14/10): os dias paravam em 30/09. Girassol e AMB têm
   uma noturna às 03:30 que refaz os últimos dias no Supabase; a GOOD não tinha nenhuma rotina
   diária — o histórico dela só andava quando alguém rodava o backfill na mão, e o painel em
   "Hoje"/"Mês" ficava vazio. Esta peça faz a parte do HISTÓRICO da noturna, com a empresa como
   parâmetro (nasce multi-empresa; hoje só a GOOD usa):
     1) espera a trava do backfill ficar livre (o backfill da GOOD roda pelo módulo da Girassol,
        e a noturna da Girassol usa a mesma trava às 03:30);
     2) refaz os últimos `dias` (padrão 3) pela data da venda — o mesmo que a noturna faz;
     3) roda o resgate (lib/checkout/backfill-resgate.js): pedido que nasceu com data antiga.
   Saídas: `adiado` e `ja_rodando` esperam e tentam de novo (dentro do orçamento de esperas);
   abortado/erro/resposta desconhecida PARAM e pulam o resgate — a janela de 3 dias de amanhã
   e o resgate cobrem o dia que falhou. Nada aqui inventa sucesso: sem resposta = não fechou.
   ──────────────────────────────────────────────────────────────────────────── */

const dormePadrao = ms => new Promise(r => setTimeout(r, ms));
/* dia no calendário de São Paulo (−3h), menos N dias */
function diaSP(ms, menosDias) { return new Date(Number(ms) - 3 * 3600 * 1000 - (Number(menosDias) || 0) * 864e5).toISOString().slice(0, 10); }

const NAO_FECHOU = ['abortado', 'erro', 'adiado', 'ja_rodando', 'desconhecido'];

async function rodarDiario(dep) {
  const d0 = dep || {};
  const agora = (d0.agoraMs != null && isFinite(Number(d0.agoraMs))) ? Number(d0.agoraMs) : Date.now();
  const dorme = d0.dorme || dormePadrao;
  const esperaMs = (d0.esperaMs != null) ? Number(d0.esperaMs) : 5 * 60 * 1000;
  const maxEsperas = (d0.maxEsperas != null) ? Number(d0.maxEsperas) : 18;   /* 18 × 5 min = 1h30 */
  const dias = Math.max(1, Math.min(30, Number(d0.dias) || 3));
  const de = diaSP(agora, dias), ate = diaSP(agora, 0);
  const out = { ok: false, empresa: d0.empresa || null, de, ate, inicio: new Date(agora).toISOString(), esperas: 0 };
  if (!d0.empresa || typeof d0.backfillVendas !== 'function') { out.erro = 'contexto incompleto (empresa, backfillVendas)'; out.fim = new Date().toISOString(); return out; }

  let r;
  for (;;) {
    if (typeof d0.ocupado === 'function' && d0.ocupado()) {
      if (out.esperas >= maxEsperas) {
        out.backfill = { desfecho: 'ja_rodando', msg: 'a trava do backfill ficou ocupada a janela toda — fica pra amanhã (a janela de ' + dias + ' dias e o resgate cobrem)' };
        out.resgate = { pulado: 'o backfill do dia não rodou' }; out.fim = new Date().toISOString(); return out;
      }
      out.esperas++; await dorme(esperaMs); continue;
    }
    try { r = await d0.backfillVendas(de, ate, d0.empresa); } catch (e) { r = { ok: false, desfecho: 'erro', msg: String((e && e.message) || e) }; }
    const des = r && r.desfecho;
    if ((des === 'ja_rodando' || des === 'adiado' || (r && r.adiado)) && out.esperas < maxEsperas) { out.esperas++; await dorme(esperaMs); continue; }
    break;
  }
  const des = (r && r.desfecho) || (r == null ? 'desconhecido' : (r.ok === false ? 'erro' : 'ok'));
  out.backfill = { desfecho: des, pedidos: r && r.pedidos, gravados: r && r.gravados, erros: r && r.erros,
                   msg: (r && (r.msg || r.adiado)) || null, transitorio: r ? r.transitorio : undefined };
  const fechou = r && r.ok !== false && NAO_FECHOU.indexOf(des) < 0 && !r.adiado;
  if (!fechou) { out.resgate = { pulado: 'o backfill do dia não fechou (' + des + ') — resgate fica pra próxima' }; out.fim = new Date().toISOString(); return out; }

  if (typeof d0.resgatar === 'function') {
    try {
      const plano = typeof d0.planoResgate === 'function' ? d0.planoResgate(agora) : undefined;
      const rr = await d0.resgatar(plano);
      out.resgate = rr ? { ok: rr.ok !== false, por: rr.por, faltando: rr.faltando, resgatados: rr.resgatados, adiados: rr.adiados, memo_falhou: rr.memo_falhou,
                           erro: rr.erro || rr.ultimo_erro || null } : { ok: false, erro: 'o resgate não respondeu' };
    } catch (e) { out.resgate = { ok: false, erro: String((e && e.message) || e) }; }
  } else out.resgate = { pulado: 'sem resgate nesta empresa' };
  /* o resgate devolve ok:true COM `adiados` (dia que não fechou) e `memo_falhou` (fila só em memória):
     nos dois casos ainda falta pedido — a rodada não fechou (Codex #688) */
  const rg = out.resgate || {};
  out.ok = !(rg.ok === false || (Array.isArray(rg.adiados) && rg.adiados.length > 0) || rg.memo_falhou === true);
  if (!out.ok && rg.ok !== false && !rg.erro) rg.erro = 'resgate deixou dia(s) adiado(s)';
  out.fim = new Date().toISOString();
  return out;
}

module.exports = { rodarDiario, diaSP };
