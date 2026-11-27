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

   Codex #999 (27/11), a função inteira revista:
     · a lista vai até AMANHÃ (o Bling omite as vendas de hoje quando dataFinal = hoje — o mesmo contorno do ciclo do checkout);
     · quem o checkout JÁ tratou (rota-cancelados-tratar: devolução feita / nota cancelada) sai — `lerTratados()`;
     · o que está em aberto no registro (nota valendo, outra situação, "não sei") é conferido de novo MESMO fora da janela
       da listagem — senão a nota cancelada depois ficaria pra sempre no aviso;
     · as leituras RODAM: lê primeiro quem nunca foi lido, depois quem foi lido há mais tempo — ninguém fica sem vez;
     · cada leitura do Bling tem PRAZO (e é abortada): uma chamada pendurada não trava a vigia; estourou, a rodada para.

   criar({ empresa, blingGet(caminho, tentativas, signal), garantirSitCancel(bg), lerConferidos(), cacheDir, lerTratados?(), lojaMkt?, agora?, prazoMs?,
           indiceDevolucoes? (lib/checkout/devolucoes-indice: { atualizar, devolucoesDe }) })
     → { varrer({ dias, leituras }), ler(), pendentes(), emAndamento(), ARQ }
   ───────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');

const ARQ = 'cancelados-bling-nf.json';
const PROVA_LOCAL_DIAS = 28;      /* os conferidos são apagados aos 30 dias; 28 dá folga (a mesma do relatório do painel) */
const GUARDA_DIAS = 150;          /* o registro de quem já foi visto; mais velho que isso sai */
const PRAZO_MS = 90 * 1000;        /* por leitura do Bling (como fundo, a vez no porteiro pode demorar) */
const PAGINAS_MAX = 20;           /* por situação de cancelamento */
const FINAIS = new Set(['nf_cancelada', 'sem_nf', 'bipado', 'tratado', 'devolvida']);
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
  /* o que o checkout já tratou (devolução feita / nota cancelada pelo admin): Set de ids. Falhou a leitura = ninguém. */
  const tratadosAgora = () => { try { const t = typeof o.lerTratados === 'function' ? o.lerTratados() : null; return t instanceof Set ? t : new Set(); } catch (e) { return new Set(); } };

  /* UMA ida ao Bling, com prazo e aborto: o que estoura vira { prazo: true } — e nunca deixa promessa solta */
  async function ida(caminho) {
    const ac = new AbortController(); let tm = null;
    const chamada = Promise.resolve().then(() => o.blingGet(caminho, 3, ac.signal));
    const prazo = new Promise((res) => { tm = setTimeout(() => { ac.abort(); res({ ok: false, status: 0, data: null, prazo: true }); }, o.prazoMs || PRAZO_MS); });
    try { return await Promise.race([chamada, prazo]); } catch (e) { return null; } finally { clearTimeout(tm); }
  }
  /* uma leitura de detalhe: { d } quando veio o objeto; { falhou } em qualquer outro caso (nunca vira "não tem") */
  async function le(caminho) {
    const r = await ida(caminho);
    if (r && r.ok && r.data && r.data.data && typeof r.data.data === 'object') return { d: r.data.data };
    return { falhou: (r && r.status) || 0, prazo: !!(r && r.prazo) };
  }

  /* varrer({ dias, leituras }) → resumo. `leituras` = teto de leituras de DETALHE (pedido/nota) nesta rodada. */
  async function varrer(op) {
    const _d = Math.floor(Number(op && op.dias));
    const dias = _d >= 1 ? Math.min(180, _d) : 3;   /* sem valor, ou valor torto: 3 dias */
    const _t = Math.floor(Number(op && op.leituras));
    const teto = _t >= 1 ? Math.min(2000, _t) : 40;
    if (rodando) return { ok: false, etapa: 'rodando', erro: 'já tem uma varredura em andamento' };
    rodando = true;
    const resumo = { ok: true, dias, cancelados_no_bling: 0, bipados: 0, ja_resolvidos: 0, lidos: 0, nf_valendo: 0, nf_outra: 0, nf_cancelada: 0, sem_nf: 0, nao_sei: 0, ficaram_pra_proxima: 0, devolvidas: 0 };
    try {
      let sit = null, prazoNaSit = false;
      try { sit = await o.garantirSitCancel(async (c) => { const r = await ida(c); if (r && r.prazo) prazoNaSit = true; return r; }); } catch (e) { sit = null; }
      const sids = (sit && Array.isArray(sit.ids) ? sit.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      /* sem saber qual é a situação "cancelado" não dá pra listar — e NADA do registro é mexido */
      if (!sids.length) return { ok: false, etapa: 'sem_situacao', erro: prazoNaSit ? 'o Bling não respondeu no prazo (situações dos pedidos)' : 'não achei a situação "Cancelado" dos pedidos no Bling desta empresa' };
      const t0 = agora();
      /* até AMANHÃ: com dataFinal = hoje o Bling omite as vendas do próprio dia (ver listarAtendidos em ciclo-empresa) */
      const de = dia(t0 - dias * 864e5), ate = dia(t0 + 864e5);
      const achados = new Map();
      let estourou = false;
      for (const sid of sids) {
        if (estourou) break;
        for (let pag = 1; pag <= PAGINAS_MAX; pag++) {
          const r = await ida('/pedidos/vendas?idsSituacoes=' + sid + '&dataInicial=' + de + '&dataFinal=' + ate + '&limite=100&pagina=' + pag);
          /* página que não veio: a lista está incompleta — para aqui e diz (o que já veio segue valendo) */
          if (!r || !r.ok || !r.data || !Array.isArray(r.data.data)) { resumo.lista_incompleta = 'o Bling não devolveu a página ' + pag + ' da situação ' + sid + ' (' + (r && r.prazo ? 'passou do prazo' : ((r && r.status) || 'sem resposta')) + ')'; if (r && r.prazo) estourou = true; break; }
          for (const p of r.data.data) { const id = so(p && p.id, /^\d{1,20}$/); if (id) achados.set(id, p); }
          if (r.data.data.length < 100) break;
        }
      }
      resumo.cancelados_no_bling = achados.size;
      const reg = ler();
      const conf = o.lerConferidos() || {};
      const tratados = tratadosAgora();
      const corte = t0 - GUARDA_DIAS * 864e5;
      for (const k of Object.keys(reg.pedidos)) { const t = Date.parse(reg.pedidos[k] && reg.pedidos[k].visto_em); if (!(t >= corte)) delete reg.pedidos[k]; }
      /* quem conferir: os da lista + o que está EM ABERTO no registro e a lista (limitada à janela) não trouxe */
      const candidatos = new Map(achados);
      for (const id of Object.keys(reg.pedidos)) { const a = reg.pedidos[id]; if (!candidatos.has(id) && a && !a.tratado && !FINAIS.has(a.estado)) candidatos.set(id, null); }
      const fila = [];
      for (const [id, p] of candidatos) {
        const ant = reg.pedidos[id];
        if (ant && (ant.tratado || FINAIS.has(ant.estado))) { resumo.ja_resolvidos++; continue; }
        /* fora da lista desta rodada: os dados são os que o registro já tinha (e o `visto_em` não anda) */
        const base = p ? { numero: p.numero != null ? p.numero : null, numero_loja: so(p.numeroLoja, /^[\w-]{1,40}$/), loja_id: so(p.loja && p.loja.id, /^\d{1,20}$/), data: so(p.data, /^\d{4}-\d{2}-\d{2}/), visto_em: new Date(t0).toISOString() }
          : { numero: ant.numero != null ? ant.numero : null, numero_loja: ant.numero_loja || null, loja_id: ant.loja_id || null, data: ant.data || null, visto_em: ant.visto_em };
        base.marketplace = (o.lojaMkt && base.loja_id && o.lojaMkt[base.loja_id]) || null;
        /* o checkout já tratou (devolução feita ou nota cancelada, com o pedido movido pra Cancelado): não é pendência */
        if (tratados.has(id)) { reg.pedidos[id] = Object.assign(base, { estado: 'tratado' }); resumo.ja_resolvidos++; continue; }
        /* o galpão conferiu: saiu daqui — é do Devoluções */
        if (conf[id]) { reg.pedidos[id] = Object.assign(base, { estado: 'bipado' }); resumo.bipados++; continue; }
        fila.push({ id, ant, base, vez: ant && ant.lido_em ? (Date.parse(ant.lido_em) || 0) : 0 });
      }
      /* a vez de cada um: quem nunca foi lido primeiro; depois, quem foi lido há mais tempo (o empate segue a ordem da lista) */
      fila.sort((a, b) => a.vez - b.vez);
      let gastas = 0;
      for (const { id, ant, base } of fila) {
        let nfId = ant && COM_NOTA.has(ant.estado) ? ant.nf_id : null;
        /* cabe inteiro no orçamento? (pedido + nota = 2 leituras; só a nota = 1) — pedido lido pela metade não vira veredito.
           Estourou o prazo numa leitura: o Bling está preso — a rodada para, e o resto fica pra próxima. */
        if (estourou || gastas + (nfId ? 1 : 2) > teto) { resumo.ficaram_pra_proxima++; continue; }
        base.lido_em = new Date(t0).toISOString();
        if (!nfId) {
          gastas++;
          const ped = await le('/pedidos/vendas/' + id);
          if (ped.prazo) estourou = true;
          if (!ped.d) { reg.pedidos[id] = Object.assign(base, { estado: 'nao_sei', motivo: ped.prazo ? 'pedido_prazo' : 'pedido_http_' + ped.falhou }); resumo.nao_sei++; continue; }
          nfId = so(ped.d.notaFiscal && ped.d.notaFiscal.id, /^[1-9]\d{0,19}$/);
          if (!nfId) { reg.pedidos[id] = Object.assign(base, { estado: 'sem_nf' }); resumo.sem_nf++; resumo.lidos++; continue; }
        }
        gastas++;
        const nf = await le('/nfe/' + nfId);
        if (nf.prazo) estourou = true;
        /* a nota não veio: quem já tinha veredito de nota (valendo/outra) FICA com ele — falha de leitura não tira ninguém do aviso */
        if (!nf.d) { const tinha = ant && COM_NOTA.has(ant.estado) ? ant.estado : null; reg.pedidos[id] = Object.assign({}, tinha ? ant : {}, base, { estado: tinha || 'nao_sei', motivo: nf.prazo ? 'nota_prazo' : 'nota_http_' + nf.falhou, nf_id: nfId }); resumo[tinha || 'nao_sei']++; continue; }
        resumo.lidos++;
        const s = sitDe(nf.d);
        /* a nota que o Bling devolveu tem que ser a que o pedido aponta */
        if (String(nf.d.id) !== nfId || s == null) { reg.pedidos[id] = Object.assign(base, { estado: 'nao_sei', motivo: s == null ? 'nota_sem_situacao' : 'nota_diferente', nf_id: nfId }); resumo.nao_sei++; continue; }
        if (s === 2) { reg.pedidos[id] = Object.assign(base, { estado: 'nf_cancelada', nf_id: nfId, nf_numero: nf.d.numero != null ? String(nf.d.numero) : null }); resumo.nf_cancelada++; continue; }
        const estado = SIT_VALENDO.has(s) ? 'nf_valendo' : 'nf_outra';
        reg.pedidos[id] = Object.assign(base, { estado, nf_id: nfId, nf_numero: nf.d.numero != null ? String(nf.d.numero) : null,
          nf_emissao: so(nf.d.dataEmissao || nf.d.dataOperacao, /^\d{4}-\d{2}-\d{2}/), nf_situacao: s, nf_loja_id: so(nf.d.loja && nf.d.loja.id, /^\d{1,20}$/), nf_chave: so(String(nf.d.chaveAcesso == null ? '' : nf.d.chaveAcesso).replace(/\D/g, ''), /^\d{44}$/) });
        resumo[estado]++;
      }
      /* 27/11 — A NOTA JÁ FOI DEVOLVIDA? O Bling não diz na nota de venda; diz no XML da nota de DEVOLUÇÃO, que referencia a
         chave da venda (lib/checkout/devolucoes-indice). Quem tem a nota valendo e a chave conhecida é confrontado: achou a
         devolução autorizada que a referencia, sai do aviso sozinho — com o número da devolução. Falhou o índice, nada muda. */
      if (o.indiceDevolucoes && !estourou) {
        const abertos = Object.keys(reg.pedidos).filter((id) => { const p = reg.pedidos[id]; return p && p.estado === 'nf_valendo' && !p.tratado && p.nf_chave && /^\d{4}-\d{2}-\d{2}/.test(String(p.nf_emissao || '')); });
        if (abertos.length) {
          const desde = abertos.map((id) => String(reg.pedidos[id].nf_emissao).slice(0, 10)).sort()[0];
          let ri = null;
          try { ri = await o.indiceDevolucoes.atualizar({ desde, ler: ida, leituras: 20 }); } catch (e) { ri = { ok: false, etapa: 'erro' }; }
          resumo.indice_devolucoes = ri && typeof ri === 'object' ? ri : { ok: false };
          /* Codex #1003: o prazo estourou no índice (ou numa conferência): o Bling está preso — PARA, e o resto fica pra próxima */
          if (resumo.indice_devolucoes.parou_no_prazo) estourou = true;
          for (const id of abertos) {
            if (estourou) break;
            let cands = []; try { cands = o.indiceDevolucoes.devolucoesDe(reg.pedidos[id].nf_chave); } catch (e) { cands = []; }
            if (!Array.isArray(cands) || !cands.length) continue;
            /* o índice guarda o que leu um dia: cada devolução candidata é conferida AGORA — é ela mesma, é nota de ENTRADA e segue
               valendo (não foi cancelada depois). A 1ª que confere dá baixa; nenhuma conferiu, o pedido fica no aviso. */
            let achou = null;
            for (const dv of cands.slice(0, 5)) {
              if (!dv || !dv.id || !/^\d{1,20}$/.test(String(dv.id))) continue;
              const dvAgora = await le('/nfe/' + dv.id);
              if (dvAgora.prazo) { estourou = true; break; }
              if (dvAgora.d && String(dvAgora.d.id) === String(dv.id) && Number(dvAgora.d.tipo) === 0 && SIT_VALENDO.has(sitDe(dvAgora.d))) { achou = dv; break; }
            }
            if (!achou) { resumo.devolucao_nao_confirmada = (resumo.devolucao_nao_confirmada || 0) + 1; continue; }
            reg.pedidos[id] = Object.assign(reg.pedidos[id], { estado: 'devolvida', devolucao_id: String(achou.id), devolucao_numero: achou.numero != null ? String(achou.numero) : null, devolvida_vista_em: new Date(t0).toISOString() });
            resumo.devolvidas++; resumo.nf_valendo = Math.max(0, resumo.nf_valendo - 1);
          }
        }
      }
      if (estourou) resumo.parou_no_prazo = true;
      reg.rodou_em = new Date(t0).toISOString(); reg.dias = dias; reg.ultimo = resumo;
      gravar(reg);
      return resumo;
    } finally { rodando = false; }
  }

  /* as notas valendo que ninguém tratou ainda — o que o aviso mostra */
  function pendentes() {
    const reg = ler(), t = agora(), out = [], tratados = tratadosAgora();
    for (const id of Object.keys(reg.pedidos)) {
      const p = reg.pedidos[id];
      if (!p || p.estado !== 'nf_valendo' || p.tratado || tratados.has(id)) continue;   /* tratado no checkout sai NA HORA, sem esperar a rodada */
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
    /* o que a vigia tirou do aviso sozinha por ter achado a devolução no Bling (os últimos 15 dias) — pra conferir */
    const devolvidas = Object.keys(reg.pedidos).filter((id) => { const p = reg.pedidos[id]; return p && p.estado === 'devolvida' && t - Date.parse(p.devolvida_vista_em) < 15 * 864e5; })
      .map((id) => ({ pedido_id: id, numero: reg.pedidos[id].numero, nf_numero: reg.pedidos[id].nf_numero, devolucao_id: reg.pedidos[id].devolucao_id, devolucao_numero: reg.pedidos[id].devolucao_numero }));
    return { rodou_em: reg.rodou_em || null, pendentes: out, outras, devolvidas };
  }

  return { varrer, ler, pendentes, emAndamento: () => rodando, ARQ };
}

module.exports = { criar, ARQ, PROVA_LOCAL_DIAS, GUARDA_DIAS, SIT_VALENDO };
