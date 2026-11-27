'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   PEDIDO QUE O BLING JÁ CANCELOU, COM A NOTA AINDA VALENDO — A VIGIA (27/11/2026, peça única, as três empresas).

   O caso real (Girassol, Mercado Livre, 26/11): o cliente cancela no marketplace minutos depois de comprar; a integração
   cancela o PEDIDO no Bling sozinha; o pedido sai de "Atendido" e some da fila do checkout — e a NF, já emitida, fica
   AUTORIZADA sem ninguém ver. O aviso do checkout (rota-cancelados-tratar) só olha quem AINDA está na fila; esse caso
   passa por fora dele. O dono: "no bling tao canceladas sim, logo nao tao no checkout. mas aih q mora o perigo, as nf
   foram geradas e tao lá". E antes: "tem como varredura de vendas canceladas antigas q nao tiveram as nf canceladas ou
   devolução nf feita? … canceladas nao postadas!!".

   O QUE ESTA PEÇA FAZ (só leitura no Bling; grava só o próprio registro):
     1. lista no Bling os pedidos em situação de cancelamento da janela (poucas páginas);
     2. tira os que o galpão CONFERIU (bipou) — esses saíram, são assunto do Devoluções;
     3. dos outros, lê o pedido (a nota dele) e a nota: cancelada → fim; AUTORIZADA → fica no registro como "nota valendo";
     4. guarda o que já viu: pedido resolvido (nota cancelada, sem nota, bipado) NÃO é lido de novo; "nota valendo" só
        relê a nota (uma chamada) pra saber se já foi cancelada.
   Tem ORÇAMENTO de leituras por rodada (a cota do Bling é da conta): o que não coube fica pra rodada seguinte.

   ⚠️ "NÃO POSTADO" AQUI SÓ TEM UMA PROVA NOSSA: o pedido não está nos conferidos. O checkout guarda os conferidos por 30
   dias — pedido com mais de 28 dias NÃO tem prova de que não foi bipado (`prova_local: false`). A confirmação do
   MARKETPLACE (sem sinal de envio) é de quem age em cima desta lista, não desta peça.
   ⚠️ Devolução já emitida não aparece na API do Bling: a lista mostra a NF de VENDA ainda autorizada; quem acusa a
   duplicata é a Toolbox na hora de gerar.

   criar({ empresa, blingGet, garantirSitCancel(bg), lerConferidos(), cacheDir, lojaMkt?, agora? })
     → { varrer({ dias, leituras }), ler(), pendentes(), ARQ }
   ───────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');

const ARQ = 'cancelados-bling-nf.json';
const PROVA_LOCAL_DIAS = 28;      /* os conferidos são apagados aos 30 dias; 28 dá folga (a mesma do relatório do painel) */
const GUARDA_DIAS = 150;          /* o registro de quem já foi visto; mais velho que isso sai */
const PAGINAS_MAX = 20;           /* por situação de cancelamento */
const FINAIS = new Set(['nf_cancelada', 'sem_nf', 'bipado']);
/* situação da NF no Bling com efeito fiscal: 5 Autorizada, 6 Emitida DANFE, 7 Registrada. 2 = Cancelada. As outras (pendente,
   rejeitada, denegada, aguardando…) NÃO pedem cancelamento nem devolução — ficam à parte (`nf_outra`), com o número da
   situação à vista, e são relidas a cada rodada (a pendente pode ser autorizada depois). */
const SIT_VALENDO = new Set([5, 6, 7]);
const COM_NOTA = new Set(['nf_valendo', 'nf_outra']);

function criar(o) {
  if (!o || !o.empresa) throw new Error('lib/checkout/cancelados-bling-vigia: falta empresa');
  for (const k of ['blingGet', 'garantirSitCancel', 'lerConferidos']) if (typeof o[k] !== 'function') throw new Error('lib/checkout/cancelados-bling-vigia (' + o.empresa + '): falta ' + k);
  if (!o.cacheDir) throw new Error('lib/checkout/cancelados-bling-vigia (' + o.empresa + '): falta cacheDir');
  const C = require('../fiscal/nf-conserto-endereco');
  const agora = o.agora || (() => Date.now());
  const arq = path.join(String(o.cacheDir), ARQ);
  let rodando = false;

  function ler() {
    try { const d = JSON.parse(fs.readFileSync(arq, 'utf8')); return d && typeof d === 'object' && !Array.isArray(d) && d.pedidos && typeof d.pedidos === 'object' && !Array.isArray(d.pedidos) ? d : { pedidos: {} }; }
    catch (e) { if (e && e.code === 'ENOENT') return { pedidos: {} }; throw e; }
  }
  function gravar(d) { const tmp = arq + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(d)); fs.renameSync(tmp, arq); }

  /* a situação da nota (número puro ou { valor }); ausente/torta = null — Number(null) daria 0, que pareceria "valendo" */
  const sitDe = (n) => { const b = n && n.situacao && typeof n.situacao === 'object' ? n.situacao.valor : n && n.situacao; if (b == null || b === '' || typeof b === 'boolean') return null; const v = Number(b); return Number.isInteger(v) && v > 0 ? v : null; };
  const dia = (t) => new Date(t).toISOString().slice(0, 10);
  const so = (v, re) => (v != null && re.test(String(v)) ? String(v) : null);
  /* uma leitura do Bling: { d } quando veio o objeto; { falhou } em qualquer outro caso (nunca vira "não tem") */
  async function le(caminho) {
    try { const r = await o.blingGet(caminho); if (r && r.ok && r.data && r.data.data && typeof r.data.data === 'object') return { d: r.data.data }; return { falhou: (r && r.status) || 0 }; }
    catch (e) { return { falhou: 0 }; }
  }

  /* varrer({ dias, leituras }) → resumo. `leituras` = teto de leituras de DETALHE (pedido/nota) nesta rodada. */
  async function varrer(op) {
    const _d = Math.floor(Number(op && op.dias));
    const dias = _d >= 1 ? Math.min(180, _d) : 3;   /* sem valor, ou valor torto: 3 dias */
    const _t = Math.floor(Number(op && op.leituras));
    const teto = _t >= 1 ? Math.min(2000, _t) : 40;
    if (rodando) return { ok: false, etapa: 'rodando', erro: 'já tem uma varredura em andamento' };
    rodando = true;
    const resumo = { ok: true, dias, cancelados_no_bling: 0, bipados: 0, ja_resolvidos: 0, lidos: 0, nf_valendo: 0, nf_outra: 0, nf_cancelada: 0, sem_nf: 0, nao_sei: 0, ficaram_pra_proxima: 0 };
    try {
      let sit = null;
      try { sit = await o.garantirSitCancel(o.blingGet); } catch (e) { sit = null; }
      const sids = (sit && Array.isArray(sit.ids) ? sit.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      /* sem saber qual é a situação "cancelado" não dá pra listar — e NADA do registro é mexido */
      if (!sids.length) return { ok: false, etapa: 'sem_situacao', erro: 'não achei a situação "Cancelado" dos pedidos no Bling desta empresa' };
      const t0 = agora();
      const de = dia(t0 - dias * 864e5), ate = dia(t0);
      const achados = new Map();
      for (const sid of sids) {
        for (let pag = 1; pag <= PAGINAS_MAX; pag++) {
          let r = null;
          try { r = await o.blingGet('/pedidos/vendas?idsSituacoes=' + sid + '&dataInicial=' + de + '&dataFinal=' + ate + '&limite=100&pagina=' + pag); } catch (e) { r = null; }
          /* página que não veio: a lista está incompleta — para aqui e diz (o que já veio segue valendo) */
          if (!r || !r.ok || !r.data || !Array.isArray(r.data.data)) { resumo.lista_incompleta = 'o Bling não devolveu a página ' + pag + ' da situação ' + sid + ' (' + ((r && r.status) || 'sem resposta') + ')'; break; }
          for (const p of r.data.data) { const id = so(p && p.id, /^\d{1,20}$/); if (id) achados.set(id, p); }
          if (r.data.data.length < 100) break;
        }
      }
      resumo.cancelados_no_bling = achados.size;
      const reg = ler();
      const conf = o.lerConferidos() || {};
      const corte = t0 - GUARDA_DIAS * 864e5;
      for (const k of Object.keys(reg.pedidos)) { const t = Date.parse(reg.pedidos[k] && reg.pedidos[k].visto_em); if (!(t >= corte)) delete reg.pedidos[k]; }
      let gastas = 0;
      for (const [id, p] of achados) {
        const ant = reg.pedidos[id];
        if (ant && (ant.tratado || FINAIS.has(ant.estado))) { resumo.ja_resolvidos++; continue; }
        const base = { numero: p.numero != null ? p.numero : null, numero_loja: so(p.numeroLoja, /^[\w-]{1,40}$/), loja_id: so(p.loja && p.loja.id, /^\d{1,20}$/), data: so(p.data, /^\d{4}-\d{2}-\d{2}/), visto_em: new Date(t0).toISOString() };
        base.marketplace = (o.lojaMkt && base.loja_id && o.lojaMkt[base.loja_id]) || null;
        /* o galpão conferiu: saiu daqui — é do Devoluções */
        if (conf[id]) { reg.pedidos[id] = Object.assign(base, { estado: 'bipado' }); resumo.bipados++; continue; }
        let nfId = ant && COM_NOTA.has(ant.estado) ? ant.nf_id : null;
        /* cabe inteiro no orçamento? (pedido + nota = 2 leituras; só a nota = 1) — pedido lido pela metade não vira veredito */
        if (gastas + (nfId ? 1 : 2) > teto) { resumo.ficaram_pra_proxima++; continue; }
        if (!nfId) {
          gastas++;
          const ped = await le('/pedidos/vendas/' + id);
          if (!ped.d) { reg.pedidos[id] = Object.assign(base, { estado: 'nao_sei', motivo: 'pedido_http_' + ped.falhou }); resumo.nao_sei++; continue; }
          nfId = so(ped.d.notaFiscal && ped.d.notaFiscal.id, /^[1-9]\d{0,19}$/);
          if (!nfId) { reg.pedidos[id] = Object.assign(base, { estado: 'sem_nf' }); resumo.sem_nf++; resumo.lidos++; continue; }
        }
        gastas++;
        const nf = await le('/nfe/' + nfId);
        /* a nota não veio: quem já tinha veredito de nota (valendo/outra) FICA com ele — falha de leitura não tira ninguém do aviso */
        if (!nf.d) { const tinha = ant && COM_NOTA.has(ant.estado) ? ant.estado : null; reg.pedidos[id] = Object.assign(base, tinha ? ant : {}, { estado: tinha || 'nao_sei', motivo: 'nota_http_' + nf.falhou, nf_id: nfId, visto_em: base.visto_em }); resumo[tinha || 'nao_sei']++; continue; }
        resumo.lidos++;
        const s = sitDe(nf.d);
        /* a nota que o Bling devolveu tem que ser a que o pedido aponta */
        if (String(nf.d.id) !== nfId || s == null) { reg.pedidos[id] = Object.assign(base, { estado: 'nao_sei', motivo: s == null ? 'nota_sem_situacao' : 'nota_diferente', nf_id: nfId }); resumo.nao_sei++; continue; }
        if (s === 2) { reg.pedidos[id] = Object.assign(base, { estado: 'nf_cancelada', nf_id: nfId, nf_numero: nf.d.numero != null ? String(nf.d.numero) : null }); resumo.nf_cancelada++; continue; }
        const estado = SIT_VALENDO.has(s) ? 'nf_valendo' : 'nf_outra';
        reg.pedidos[id] = Object.assign(base, { estado, nf_id: nfId, nf_numero: nf.d.numero != null ? String(nf.d.numero) : null,
          nf_emissao: so(nf.d.dataEmissao || nf.d.dataOperacao, /^\d{4}-\d{2}-\d{2}/), nf_situacao: s, nf_loja_id: so(nf.d.loja && nf.d.loja.id, /^\d{1,20}$/) });
        resumo[estado]++;
      }
      reg.rodou_em = new Date(t0).toISOString(); reg.dias = dias; reg.ultimo = resumo;
      gravar(reg);
      return resumo;
    } finally { rodando = false; }
  }

  /* as notas valendo que ninguém tratou ainda — o que o aviso mostra */
  function pendentes() {
    const reg = ler(), t = agora(), out = [];
    for (const id of Object.keys(reg.pedidos)) {
      const p = reg.pedidos[id];
      if (!p || p.estado !== 'nf_valendo' || p.tratado) continue;
      const horas = C.horasDesde(p.nf_emissao, t);
      /* em DIAS DE CALENDÁRIO (a data do pedido não tem hora) */
      const idade = p.data ? (Date.parse(dia(t)) - Date.parse(String(p.data).slice(0, 10))) / 864e5 : null;
      out.push({ pedido_id: id, numero: p.numero, numero_loja: p.numero_loja, marketplace: p.marketplace, data: p.data, nf_numero: p.nf_numero, nfe_id: p.nf_id,
        horas_desde_a_emissao: horas == null ? null : Math.round(horas * 10) / 10,
        acao: horas == null ? null : (horas < C.HORAS_PRA_CANCELAR ? 'cancelar' : 'devolucao'),
        /* sem prova de bipagem (pedido mais velho que o registro dos conferidos): não dá pra dizer "não postado" por aqui */
        prova_local: idade != null && isFinite(idade) && idade >= 0 && idade <= PROVA_LOCAL_DIAS });
    }
    out.sort((a, b) => Number(a.numero || 0) - Number(b.numero || 0));
    /* nota em outra situação (nem autorizada, nem cancelada): à vista, sem ação */
    const outras = Object.keys(reg.pedidos).filter((id) => reg.pedidos[id] && reg.pedidos[id].estado === 'nf_outra')
      .map((id) => ({ pedido_id: id, numero: reg.pedidos[id].numero, nf_numero: reg.pedidos[id].nf_numero, nf_situacao: reg.pedidos[id].nf_situacao }));
    return { rodou_em: reg.rodou_em || null, pendentes: out, outras };
  }

  return { varrer, ler, pendentes, emAndamento: () => rodando, ARQ };
}

module.exports = { criar, ARQ, PROVA_LOCAL_DIAS, GUARDA_DIAS };
