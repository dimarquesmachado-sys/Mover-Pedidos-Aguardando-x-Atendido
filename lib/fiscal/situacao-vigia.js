'use strict';
/* 12/11 — A VIGIA DAS NOTAS EM "CONSULTAR SITUAÇÃO" (pedido do dono: "em 99% dos casos clicar em Consultar situação já
   resolve; aí sim, se der erro e não resolver, vale a pena vir um alerta no checkout do admin, igual a gente fez pro CEP").

   Quem FAZ a consulta é a Toolbox, dentro do Bling aberto num navegador (o Bling não aceita essa chamada do servidor).
   Esta peça é a memória e o alarme do servidor, por empresa:
   · guarda desde quando cada nota está parada e o que a última consulta automática respondeu;
   · quando a nota some da lista do Bling E a conferência individual confirma que ela saiu de "Consultar situação"
     (destravou, foi cancelada…), esquece dela e TIRA o aviso;
   · põe o aviso no checkout do admin (lib/nf-travadas, tipo `consultar_situacao`) quando:
       – a consulta automática tentou e NÃO destravou (a SEFAZ respondeu outra coisa, o Bling não gravou…), ou
       – a nota está parada há mais de `limiteMin` minutos e ninguém a consultou (nenhum Bling aberto com a Toolbox).
     "Não logado" não é resposta da nota: vale como "ninguém consultou".
   Uma peça só, a empresa por parâmetro. Sem Bling aqui dentro: quem lista é o chamador (`listar`). */
const fs = require('fs');
const path = require('path');
const nfTravadas = require('../nf-travadas');

const TIPO = 'consultar_situacao';
const COMO = 'No Bling: Notas Fiscais → 3 pontinhos da nota → Consultar situação. Se a SEFAZ recusar, corrija o que ela apontar e envie a nota de novo.';

function criar(cfg) {
  if (!cfg || !cfg.dirTravadas) throw new Error('lib/fiscal/situacao-vigia: falta dirTravadas');
  if (typeof cfg.listar !== 'function') throw new Error('lib/fiscal/situacao-vigia: falta listar');
  const dir = cfg.dirTravadas;
  const agora = cfg.agora || (() => Date.now());
  const limiteMin = cfg.limiteMin == null ? 30 : cfg.limiteMin;
  const intervaloMs = cfg.intervaloMs == null ? 15 * 60000 : cfg.intervaloMs;
  const maxConfirmar = cfg.maxConfirmar == null ? 10 : cfg.maxConfirmar;
  const arq = path.join(dir, '_nf_consultar_situacao.json');
  let mem = null, ultimaVigia = 0, vigiando = null;

  function ler() {
    if (mem) return mem;
    try { mem = JSON.parse(fs.readFileSync(arq, 'utf8')); } catch (e) { mem = null; }
    if (!mem || typeof mem !== 'object' || !mem.nfs || typeof mem.nfs !== 'object') mem = { nfs: {} };
    return mem;
  }
  function gravar() {
    try { fs.mkdirSync(dir, { recursive: true }); require('../escrita-atomica').gravarAtomico(arq, JSON.stringify(mem, null, 2)); return true; } catch (e) { return false; }
  }
  /* a emissão vem do Bling como "AAAA-MM-DD HH:MM:SS", hora de Brasília */
  const emissaoMs = (s) => { const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(String(s || '')); const t = m ? Date.parse(m[1] + 'T' + m[2] + '-03:00') : NaN; return isNaN(t) ? null : t; };
  const tempo = (min) => (min >= 120 ? Math.floor(min / 60) + ' h' : (min >= 60 ? '1 h ' + (min - 60) + ' min' : min + ' min'));
  const tentou = (u) => !!(u && u.via && u.via !== 'nao_logado');
  /* 'sem_confirmacao' = o Bling aceitou a gravação e a Toolbox só não conseguiu reler a lista: "não sei" não é falha */
  const falhou = (u) => tentou(u) && ['validada', 'gravada', 'sem_confirmacao'].indexOf(u.via) === -1;

  /* decide o aviso de UMA nota que continua parada */
  function avaliar(id, e) {
    const t0 = Math.min(emissaoMs(e.dataEmissao) || Infinity, Date.parse(e.desde) || Infinity);
    const min = isFinite(t0) ? Math.max(0, Math.floor((agora() - t0) / 60000)) : 0;
    const u = e.ultimo;
    let motivo = null;
    if (falhou(u)) {
      motivo = 'Parada em "Consultar situação" — a consulta automática tentou e não destravou: '
        + (u.via === 'nao_autorizada' ? 'a SEFAZ respondeu ' + (u.cStat || '?') + ' — ' + (u.xMotivo || 'sem motivo')
          : (u.erro || (u.via === 'sem_resposta' ? 'o Bling não devolveu a resposta da SEFAZ' : u.via)));
    } else if (min >= limiteMin) {
      motivo = 'Parada em "Consultar situação" há ' + tempo(min) + ' e nenhuma consulta automática passou por ela'
        + (u && u.via === 'nao_logado' ? ' (a Toolbox tentou, mas o Bling não estava logado naquele navegador)' : ' (o Bling desta empresa precisa estar aberto num navegador com a Toolbox)');
    }
    if (!motivo) return false;
    nfTravadas.registrarAviso(dir, { tipo: TIPO, nfeId: id, numero: e.numero, motivo, comoResolver: COMO, detalhe: 'emitida em ' + (e.dataEmissao || '?'), desde: e.desde });
    return true;
  }

  /** a lista de AGORA do Bling (filtro "Consultar situação") → atualiza a memória e os avisos.
      Codex #856: a lista é "da janela" (últimos dias, com teto de páginas) — uma nota que NÃO veio nela pode continuar
      parada (mais antiga que a janela, ou cortada pelo teto). Então sumir da lista não basta pra tirar o aviso: cada nota
      que sumiu é CONFERIDA uma a uma (`cfg.confirmar(id, dataEmissao)` → true = segue parada, false = saiu mesmo, null =
      não deu pra saber). Só `false` tira; "não sei" mantém. No máximo `maxConfirmar` conferências por rodada (cota do
      Bling) — as demais ficam pra próxima. Sem `confirmar` (empresa que não o expõe), vale a lista. Uma rodada por vez. */
  let fila = Promise.resolve();
  function reconciliar(lista) {
    const vez = fila.then(() => _reconciliar(lista));
    fila = vez.catch(() => {});
    return vez;
  }
  async function _reconciliar(lista) {
    if (!Array.isArray(lista)) return { total: 0, avisadas: 0, saiu: 0 };
    const est = ler(), agoraISO = new Date(agora()).toISOString(), vistos = new Set();
    for (const nf of lista) {
      if (!nf || nf.id == null) continue;
      const id = String(nf.id); vistos.add(id);
      const e = est.nfs[id] || (est.nfs[id] = { desde: agoraISO, tentativas: 0 });
      e.numero = nf.numero || e.numero || null; e.dataEmissao = nf.dataEmissao || e.dataEmissao || null; e.ultima_vista = agoraISO;
    }
    /* quem a vigia conhece (memória ou aviso) e não veio na lista */
    const sumiram = new Map();
    for (const id of Object.keys(est.nfs)) if (!vistos.has(id)) sumiram.set(id, est.nfs[id].dataEmissao || null);
    for (const a of nfTravadas.avisosDoTipo(dir, TIPO)) {
      const id = String(a.nfe_id);
      if (!vistos.has(id) && !sumiram.has(id)) sumiram.set(id, (/emitida em (\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/.exec(String(a.detalhe || '')) || [])[1] || null);
    }
    /* Codex #856: rodízio — quem foi conferido há mais tempo (ou nunca) vai primeiro, pra cota não ser sempre das mesmas */
    if (!est.conferida || typeof est.conferida !== 'object') est.conferida = {};
    for (const id of vistos) delete est.conferida[id];
    for (const id of Object.keys(est.conferida)) if (!sumiram.has(id)) delete est.conferida[id];
    const ordem = [...sumiram].sort((a, b) => (Date.parse(est.conferida[a[0]]) || 0) - (Date.parse(est.conferida[b[0]]) || 0));
    let saiu = 0, conferidas = 0;
    const seguem = [];
    for (const [id, emissao] of ordem) {
      let aindaParada = false;   /* sem como conferir, vale a lista */
      if (typeof cfg.confirmar === 'function') {
        if (!emissao) aindaParada = false;                       /* sem a data não há como conferir nunca: sai */
        else if (conferidas >= maxConfirmar) aindaParada = null;  /* fica pra próxima rodada */
        else { conferidas++; est.conferida[id] = agoraISO; try { aindaParada = await cfg.confirmar(id, emissao); } catch (e) { aindaParada = null; } }
      }
      if (aindaParada === false) { delete est.nfs[id]; delete est.conferida[id]; nfTravadas.resolverAviso(dir, TIPO, id); saiu++; }
      else if (est.nfs[id]) seguem.push(id);
    }
    let avisadas = 0;
    for (const id of vistos) if (avaliar(id, est.nfs[id])) avisadas++;
    for (const id of seguem) if (avaliar(id, est.nfs[id])) avisadas++;
    gravar();
    return { total: vistos.size + seguem.length, avisadas, saiu };
  }

  /** o que a consulta automática (Toolbox) respondeu pra cada nota. Falha vira aviso NA HORA. */
  function receberResultados(resultados, origem) {
    if (!Array.isArray(resultados)) return { recebidos: 0 };
    const est = ler(), agoraISO = new Date(agora()).toISOString();
    let n = 0;
    for (const r of resultados.slice(0, 50)) {
      if (!r || r.id == null || !/^\d{1,20}$/.test(String(r.id))) continue;
      const id = String(r.id);
      const e = est.nfs[id] || (est.nfs[id] = { desde: agoraISO, tentativas: 0, numero: r.numero || null });
      e.ultimo = { quando: agoraISO, via: String(r.via || '').slice(0, 30), cStat: r.cStat ? String(r.cStat).slice(0, 6) : null,
        xMotivo: r.xMotivo ? String(r.xMotivo).slice(0, 200) : null, erro: r.erro ? String(r.erro).slice(0, 200) : null, origem: String(origem || '').slice(0, 20) };
      if (tentou(e.ultimo)) e.tentativas = (e.tentativas || 0) + 1;
      if (falhou(e.ultimo)) avaliar(id, e);
      n++;
    }
    gravar();
    return { recebidos: n };
  }

  /** confere a lista no Bling, no máximo uma vez a cada `intervaloMs` (uma chamada de listagem) — é o que faz o aviso
      aparecer mesmo quando nenhuma Toolbox está rodando. Erro ao listar não mexe em nada ("não sei" não tira aviso). */
  async function vigiarSeDevido() {
    if (vigiando) return vigiando;
    if (agora() - ultimaVigia < intervaloMs) return null;
    vigiando = (async () => {
      try { const lista = await cfg.listar(); ultimaVigia = agora(); return reconciliar(lista); }
      finally { vigiando = null; }
    })();
    return vigiando;
  }
  function estado() { return JSON.parse(JSON.stringify(ler())); }
  return { reconciliar, receberResultados, vigiarSeDevido, estado, TIPO };
}
module.exports = { criar, TIPO };
