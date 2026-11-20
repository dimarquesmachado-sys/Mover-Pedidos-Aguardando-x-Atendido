'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   CONSERTO DA NF RECUSADA PELO ML — AS NOTAS ANTIGAS QUE FICARAM PRA TRÁS (20/11/2026).

   O conserto cria, emite e entrega ao ML a nota NOVA. A nota recusada (a antiga) continua autorizada no Bling: são duas
   notas pra mesma venda até alguém cancelar ou devolver a antiga. A regra do dono: cancelar, que "fica visível, mais fácil
   de ver e saber q realmente cancelou"; e "se passar de 24h da emissão da NF, aí sim, gera a NF devolução".
   Cancelar e devolver só se fazem por dentro da tela do Bling (a API não cancela nota) — então o que o servidor garante é
   que a nota antiga NÃO SEJA ESQUECIDA: esta rota diz quais estão pendentes e o que cabe a cada uma, e o checkout mostra.

   GET <prefixo>/nf-conserto-antigas
       → { ok, total, antigas: [{ nfe_id, numero, nova_numero, pedido_ml, horas_desde_a_emissao, acao, consertada_em }] }
         `acao`: 'cancelar' (menos de 24 h da emissão), 'devolucao' (24 h ou mais) ou null (não sei a data).
       De passagem, olha no Bling as que estão pendentes (poucas por chamada, e cada uma no máximo de meia em meia hora):
       a que já aparece CANCELADA sai da lista sozinha — cancelou, sumiu, sem ninguém avisar o sistema.
   GET <prefixo>/nf-conserto-antigas?resolver=<id da nota antiga>&como=devolvida|cancelada&confirma=sim
       → tira da lista por decisão de quem tratou (a devolução não tem como ser vista daqui).

   Entra na lista: nota nova criada por esta rotina, que NÃO é de teste, e que o ML já aceitou. Antes disso a antiga ainda
   é a nota da venda — cancelá-la deixaria a venda sem nota. Sem dado de gente: só números de nota e de venda.
   Trava: chave OU sessão de admin; sem as duas, 404.
   ───────────────────────────────────────────────────────────────────────────── */

const REVER_MS = 30 * 60000;   /* cada nota pendente é olhada no Bling no máximo de meia em meia hora */
const POR_CHAMADA = 3;         /* e poucas por chamada — a cota do Bling é da operação */

function caminhoDe(prefixo) { return prefixo + '/nf-conserto-antigas'; }
function atende(prefixo, method, p) { return method === 'GET' && p === caminhoDe(prefixo); }

function criar(o) {
  if (!o || !o.empresa) throw new Error('lib/checkout/rota-nf-conserto-antigas: falta empresa');
  for (const k of ['json', 'lerChaveAdmin', 'validarSessao', 'ehAdmin', 'blingGet']) {
    if (typeof o[k] !== 'function') throw new Error('lib/checkout/rota-nf-conserto-antigas (' + o.empresa + '): falta ' + k);
  }
  const prefixo = o.prefixo != null ? o.prefixo : require('./config-empresa').prefixoDe(o.empresa);
  const { empresa, json, lerChaveAdmin, validarSessao, ehAdmin, blingGet } = o;
  const C = require('../fiscal/nf-conserto-endereco');
  const Reg = require('../fiscal/nf-conserto-registro');
  const agora = o.agora || (() => Date.now());

  const _tentada = {};   /* id → quando foi a última tentativa de leitura no Bling (deste processo) */
  const pendente = (r) => !!(r && r.estado === 'criada' && r.nova_id && !r.teste && r.no_ml_em && !r.antiga_resolvida_em);
  const sitDe = (n) => { const v = Number(n && n.situacao && typeof n.situacao === 'object' ? n.situacao.valor : n && n.situacao); return isFinite(v) ? v : null; };

  return async function rotaNfConsertoAntigas(req, res, urlObj, method, p) {
    if (!atende(prefixo, method, p)) return false;
    const k = lerChaveAdmin(req, urlObj);
    const sess = validarSessao(req.headers['cookie']);
    if (!((process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (sess && ehAdmin(sess)))) { json(res, 404, { error: 'not found' }); return true; }
    const base = { empresa };
    if (!o.cacheDir) { json(res, 200, Object.assign({ ok: false, etapa: 'sem_peca', erro: 'esta empresa ainda não passa a pasta do cache pra esta rota' }, base)); return true; }
    const dir = o.cacheDir;
    const q = (n) => String((urlObj.searchParams && urlObj.searchParams.get(n)) || '').trim();
    let todas = null;
    try { todas = Reg.ler(dir); } catch (e) { json(res, 200, Object.assign({ ok: false, etapa: 'registro', erro: 'não consegui ler o registro do conserto: ' + String((e && e.message) || e).slice(0, 120) }, base)); return true; }

    /* ── quem tratou a nota antiga avisa ── */
    const resolver = q('resolver');
    if (resolver) {
      const como = q('como').toLowerCase();
      if (!/^\d{1,20}$/.test(resolver) || (como !== 'devolvida' && como !== 'cancelada')) { json(res, 400, Object.assign({ ok: false, erro: 'use ?resolver=<id da nota antiga>&como=devolvida|cancelada&confirma=sim' }, base)); return true; }
      if (q('confirma').toLowerCase() !== 'sim') { json(res, 200, Object.assign({ ok: false, etapa: 'confirmacao', erro: 'isto tira a nota da lista de pendentes — acrescente &confirma=sim' }, base)); return true; }
      const r = Object.prototype.hasOwnProperty.call(todas, resolver) ? todas[resolver] : null;
      if (!pendente(r)) { json(res, 200, Object.assign({ ok: false, etapa: 'nao_pendente', erro: 'essa nota não está na lista de antigas pendentes' }, base)); return true; }
      let gravou = false; try { gravou = Reg.anotar(dir, resolver, { antiga_resolvida_em: new Date(agora()).toISOString(), antiga_resolvida_como: como, antiga_resolvida_por: 'admin' }); } catch (e) { gravou = false; }
      if (!gravou) { json(res, 200, Object.assign({ ok: false, etapa: 'registro', erro: 'não consegui gravar — a nota continua na lista' }, base)); return true; }
      json(res, 200, Object.assign({ ok: true, resolvida: { nfe_id: resolver, numero: r.numero || null, como } }, base));
      return true;
    }

    /* ── de passagem: olhar no Bling as pendentes que faz tempo que ninguém olha ── */
    const t0 = agora();
    /* a vez é de quem foi tentada há mais tempo: nota que o Bling não devolve (fora do ar, excluída) não pode ocupar as
       poucas leituras de cada chamada pra sempre e deixar as outras sem ninguém olhar */
    const aOlhar = Object.keys(todas).filter((id) => pendente(todas[id]) && !(t0 - (Date.parse(todas[id].antiga_vista_em) || 0) < REVER_MS))
      .sort((x, y) => (_tentada[x] || 0) - (_tentada[y] || 0)).slice(0, POR_CHAMADA);
    for (const id of aOlhar) {
      _tentada[id] = agora();
      let nf = null;
      try { const rB = await blingGet('/nfe/' + id); nf = rB && rB.ok && rB.data && rB.data.data && typeof rB.data.data === 'object' ? rB.data.data : null; } catch (e) { nf = null; }
      if (!nf) continue;   /* não consegui ler: não sei — fica pendente e tenta na próxima */
      const campos = { antiga_vista_em: new Date(agora()).toISOString() };
      if (!todas[id].emitida_em && (nf.dataEmissao || nf.dataOperacao)) campos.emitida_em = String(nf.dataEmissao || nf.dataOperacao);
      /* só a situação "cancelada" encerra sozinha; qualquer outra (autorizada, DANFE emitido...) segue pendente */
      if (sitDe(nf) === 2) { campos.antiga_resolvida_em = campos.antiga_vista_em; campos.antiga_resolvida_como = 'cancelada'; campos.antiga_resolvida_por = 'bling'; }
      try { if (Reg.anotar(dir, id, campos)) Object.assign(todas[id], campos); } catch (e) { /* não gravou: segue como estava, tenta na próxima */ }
    }

    const antigas = Object.keys(todas).filter((id) => pendente(todas[id])).map((id) => {
      const r = todas[id];
      const horas = C.horasDesde(r.emitida_em, agora());
      return { nfe_id: id, numero: r.numero || null, nova_numero: r.nova_numero || null, pedido_ml: r.pedido_ml || null,
        horas_desde_a_emissao: horas == null ? null : Math.round(horas * 10) / 10,
        acao: horas == null ? null : (horas < C.HORAS_PRA_CANCELAR ? 'cancelar' : 'devolucao'), consertada_em: r.no_ml_em };
    }).sort((a, b) => String(a.consertada_em).localeCompare(String(b.consertada_em)));
    json(res, 200, Object.assign({ ok: true, total: antigas.length, antigas }, base));
    return true;
  };
}

module.exports = { criar, atende, caminhoDe, REVER_MS, POR_CHAMADA };
