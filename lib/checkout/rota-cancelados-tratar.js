'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   CANCELADO NO MARKETPLACE ANTES DA POSTAGEM — TRATAR (26/11/2026, peça única, as três empresas).

   A sonda (lib/checkout/rotas-cancelados-mkt) mostra o que o marketplace responde. Esta peça é o que o checkout usa pra
   NÃO DEIXAR ESQUECER e pra resolver: a venda cancelada que nem saiu do galpão deixa uma NF válida (imposto), estoque
   preso e um card parado na fila. Pedido do dono (26/11): "me mostra a notificaçãozinha lá igual qdo no problema do
   endereço, e me deixa gerar cancelamento se menos 24h da emissão da NF ou devolução se for mais q isso", e "depois mover
   ele pra status cancelado dentro do bling, q assim tb já tira ali do checkout offline da tela".

   ⚠️ A REGRA QUE MANDA (dele): "só pode ser de pedidos AINDA NÃO POSTADOS. senão vai cagar todo o meu projeto lá das
   devoluções". Por isso as DUAS pontas são conferidas DE NOVO, na hora, em cada passo que age (preparar e resolver):
     · NOSSA: o pedido está na fila do galpão e NÃO foi conferido pelo checkout;
     · DO MARKETPLACE: cancelado e sem nenhum sinal de envio (classificarTikTok → "cancelado_antes_postagem").
   Qualquer outra resposta — ativo, cancelado depois de postado, marketplace fora do ar, pedido que sumiu da fila — é
   "não trato": nada é gerado, nada é movido. "Não sei" nunca vira ação.

   GET <prefixo>/cancelados-tratar
       → { ok, total, pendentes: [{ pedido_id, numero, numero_loja, marketplace, nf_numero, nfe_id,
                                    horas_desde_a_emissao, acao }] }
         `acao`: 'cancelar' (NF emitida há menos de 24 h), 'devolucao' (24 h ou mais), 'sem_nf' (o pedido não tem nota:
         é só cancelar o pedido no Bling) ou null (tem nota, não sei a data).
   GET <prefixo>/cancelados-tratar?preparar=<id do pedido>
       → o que a Toolbox precisa pra gerar a NF de devolução pela tela do Bling: { ok, pedido_id, nfe_id, numero, id_loja }.
         Só pra nota que JÁ PASSOU das 24 h (antes disso a regra é cancelar). Uma leitura no Bling por clique.
   GET <prefixo>/cancelados-tratar?resolver=<id do pedido>&como=cancelada|devolvida&confirma=sim
         [&devolucao_id=<id da NF de devolução>&devolucao_numero=<nº>]
       → a NF foi tratada: MOVE O PEDIDO pra "Cancelado" no Bling e tira da lista.
         `cancelada`: o servidor CONFERE no Bling que a nota está cancelada — se não está, não move (pedido cancelado com
         nota valendo é o que esta peça existe pra evitar). `devolvida`: a devolução não tem como ser vista daqui; vale a
         palavra de quem gerou (o botão da Toolbox manda o id e o número dela, que ficam anotados).

   Cancelar a NF só se faz na tela do Bling (a API não cancela nota); a devolução é gerada pela Toolbox, na tela do Bling.
   Sem dado de gente: só números de pedido, de nota e de venda. Trava: chave OU sessão de admin; sem as duas, 404.
   Começa pelo TikTok (o caso real); os outros marketplaces entram quando a sonda deles estiver calibrada.

   criar({ empresa, prefixo, json, lerChaveAdmin, validarSessao, ehAdmin, blingGet, blingWrite, cacheDir, manifest(),
           lerConferidos(), tiktokConta, tiktokOAuth?, garantirSitCancel?, agora? })
   ───────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');

const ARQ = 'cancelados-tratados.json';
const GUARDA_DIAS = 120;   /* o registro de quem já foi tratado; mais velho que isso sai */

function caminhoDe(prefixo) { return prefixo + '/cancelados-tratar'; }
function atende(prefixo, method, p) { return method === 'GET' && p === caminhoDe(prefixo); }

function criar(o) {
  if (!o || !o.empresa) throw new Error('lib/checkout/rota-cancelados-tratar: falta empresa');
  for (const k of ['json', 'lerChaveAdmin', 'validarSessao', 'ehAdmin', 'blingGet', 'manifest', 'lerConferidos']) {
    if (typeof o[k] !== 'function') throw new Error('lib/checkout/rota-cancelados-tratar (' + o.empresa + '): falta ' + k);
  }
  if (!o.prefixo || !o.tiktokConta) throw new Error('lib/checkout/rota-cancelados-tratar (' + o.empresa + '): falta prefixo/tiktokConta');
  const { empresa, prefixo, json, lerChaveAdmin, validarSessao, ehAdmin, blingGet } = o;
  const C = require('../fiscal/nf-conserto-endereco');
  const Mkt = require('./rotas-cancelados-mkt');
  const L = Mkt.leitura({ manifest: o.manifest, lerConferidos: o.lerConferidos, tiktokConta: o.tiktokConta, tiktokOAuth: o.tiktokOAuth });
  const agora = o.agora || (() => Date.now());
  const garantirSitCancel = o.garantirSitCancel || ((bg) => require('./situacoes-cancelamento').garantirSitCancel(bg, empresa));

  const sitDe = (n) => { const v = Number(n && n.situacao && typeof n.situacao === 'object' ? n.situacao.valor : n && n.situacao); return isFinite(v) ? v : null; };
  const semZeros = (v) => String(v == null ? '' : v).replace(/^0+/, '');

  /* ── o registro de quem já foi tratado (o card só sai da fila no próximo ciclo; a lista não pode mostrar de novo) ── */
  function lerTratados() {
    try { const d = JSON.parse(fs.readFileSync(path.join(o.cacheDir, ARQ), 'utf8')); return d && typeof d === 'object' && !Array.isArray(d) ? d : {}; }
    catch (e) { if (e && e.code === 'ENOENT') return {}; throw e; }
  }
  function anotarTratado(id, campos) {
    const todos = lerTratados();
    const corte = agora() - GUARDA_DIAS * 864e5;
    for (const k of Object.keys(todos)) { const t = Date.parse(todos[k] && todos[k].em); if (!(t >= corte)) delete todos[k]; }
    todos[id] = campos;
    const arq = path.join(o.cacheDir, ARQ), tmp = arq + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(todos));
    fs.renameSync(tmp, arq);
  }

  /* a nota do pedido, pelo que o checkout guardou dele (o manifesto só tem o número; o id está na pasta do pedido) */
  function nfeIdDe(id) {
    try {
      const snap = JSON.parse(fs.readFileSync(path.join(o.cacheDir, String(id), 'pedido.json'), 'utf8'));
      const v = snap && !snap.nf_anexada && snap.nf && snap.nf.id;
      return v != null && /^\d{1,20}$/.test(String(v)) && Number(v) > 0 ? String(v) : null;
    } catch (e) { return null; }
  }

  function linha(p) {
    const temNF = !!p.nf_numero;
    const horas = temNF ? C.horasDesde(p.nf_emissao, agora()) : null;
    return { pedido_id: String(p.id), numero: p.numero || null, numero_loja: p.numero_loja, marketplace: 'tiktok',
      nf_numero: temNF ? String(p.nf_numero) : null, nfe_id: temNF ? nfeIdDe(p.id) : null,
      horas_desde_a_emissao: horas == null ? null : Math.round(horas * 10) / 10,
      acao: !temNF ? 'sem_nf' : (horas == null ? null : (horas < C.HORAS_PRA_CANCELAR ? 'cancelar' : 'devolucao')) };
  }

  /* Codex #992: enquanto se espera o TikTok ou o Bling, o galpão pode FINALIZAR o pedido (a rota /conferido grava na hora).
     A fila é relida — do disco, sem espera — depois de CADA leitura de fora e imediatamente antes de escrever no Bling:
     pedido que foi conferido (ou saiu da fila) no meio do caminho não é preparado nem movido. */
  const SAIU_DA_FILA = { ok: false, etapa: 'fora_da_fila', erro: 'o pedido foi conferido ou saiu da fila do galpão enquanto eu conferia — não trato por aqui' };
  function aindaNaFila(id) { return L.filaTikTok().fila.some((x) => String(x.id) === String(id)); }

  /* AS DUAS PONTAS, AGORA, pra um pedido: devolve { ok:true, p } só quando está na fila sem conferência E o TikTok diz
     cancelado sem sinal de envio. Todo o resto volta com `etapa` e `erro` — e quem chama NÃO age. */
  async function conferirAgora(id) {
    const { fila } = L.filaTikTok();
    const p = fila.find((x) => String(x.id) === id);
    if (!p) return { ok: false, etapa: 'fora_da_fila', erro: 'esse pedido não está na fila do galpão sem conferência (já foi despachado, saiu da fila ou não é do TikTok) — não trato por aqui' };
    if (!p.numero_loja) return { ok: false, etapa: 'sem_numero', erro: 'o pedido está sem o número do TikTok — não consigo conferir o cancelamento' };
    const tk = await L.consultarTikTok([p.numero_loja]);
    const ped = tk && tk.porId ? tk.porId[p.numero_loja] : null;
    if (!ped) return { ok: false, etapa: 'nao_sei', erro: (tk && tk.erro ? tk.erro : 'o TikTok não devolveu o pedido') + ' — não sei se segue cancelado; tente de novo em instantes' };
    const v = Mkt.classificarTikTok(ped);
    if (v.veredito === 'cancelado_antes_postagem') return aindaNaFila(id) ? { ok: true, p } : SAIU_DA_FILA;
    if (v.veredito === 'cancelado_depois_de_postado') return { ok: false, etapa: 'postado', erro: 'o TikTok mostra sinal de ENVIO nesse pedido — é caso do Devoluções, não trato por aqui' };
    if (v.veredito === 'ativo') return { ok: false, etapa: 'ativo', erro: 'o TikTok não mostra esse pedido como cancelado' };
    return { ok: false, etapa: 'nao_sei', erro: 'não consegui ler o estado do pedido no TikTok — tente de novo em instantes' };
  }

  /* a nota no Bling, conferida: é a MESMA do pedido (id e número). Devolve { nf } ou { etapa, erro } */
  async function lerNota(p) {
    const nfeId = nfeIdDe(p.id);
    if (!p.nf_numero || !nfeId) return { etapa: 'sem_nf', erro: 'não achei a nota desse pedido no que o checkout guardou — trate a nota direto no Bling' };
    let nf = null, falhou = '';
    try { const rB = await blingGet('/nfe/' + nfeId); if (rB && rB.ok && rB.data && rB.data.data && typeof rB.data.data === 'object') nf = rB.data.data; else falhou = 'o Bling respondeu ' + ((rB && rB.status) || 'sem resposta'); }
    catch (e) { falhou = 'não consegui falar com o Bling'; }
    if (!nf) return { etapa: 'bling', erro: falhou + ' — tente de novo em instantes' };
    if (String(nf.id) !== nfeId || semZeros(nf.numero) !== semZeros(p.nf_numero)) return { etapa: 'nota_diferente', erro: 'o Bling devolveu outra nota pra esse pedido — não faço nada' };
    return { nf, nfeId };
  }

  /* o pedido vai pra "Cancelado" no Bling. Devolve { ok:true } ou { ok:false, erro } — falha aqui nunca apaga o que já foi feito na nota */
  async function moverPraCancelado(id) {
    if (typeof o.blingWrite !== 'function') return { ok: false, erro: 'esta empresa ainda não passa a escrita no Bling pra esta rota' };
    let sit = null;
    try { sit = await garantirSitCancel(blingGet); } catch (e) { sit = null; }
    const ids = (sit && Array.isArray(sit.ids) ? sit.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) return { ok: false, erro: 'não achei a situação "Cancelado" dos pedidos no Bling desta empresa' };
    /* havendo mais de uma situação de cancelamento, vai pra que se chama só "Cancelado"; não havendo, a primeira */
    const nomes = sit && Array.isArray(sit.nomes) ? sit.nomes : [];
    let alvo = ids[0];
    if (nomes.length === ids.length) { const i = nomes.findIndex((n) => /^\s*cancelado\s*$/i.test(String(n || ''))); if (i >= 0) alvo = ids[i]; }
    /* a última conferência, sem nenhuma espera entre ela e a escrita */
    if (!aindaNaFila(id)) return { ok: false, saiu: true, erro: SAIU_DA_FILA.erro };
    let r = null;
    try { r = await o.blingWrite('PATCH', '/pedidos/vendas/' + id + '/situacoes/' + alvo, null, { semRetryDeRede: true }); } catch (e) { r = null; }
    if (r && r.ok) return { ok: true };
    /* o Bling recusa mover pra situação em que o pedido JÁ está; e uma resposta que se perdeu pode ter movido. Olha o pedido. */
    try {
      const rp = await blingGet('/pedidos/vendas/' + id);
      const sAtual = rp && rp.ok && rp.data && rp.data.data && rp.data.data.situacao ? Number(rp.data.data.situacao.id) : null;
      if (sAtual != null && ids.includes(sAtual)) return { ok: true };
    } catch (e) { /* não li: fica como falha, abaixo */ }
    return { ok: false, erro: 'o Bling não moveu o pedido pra Cancelado (' + (r && r.status ? 'resposta ' + r.status : 'sem resposta') + ')' };
  }

  return async function rotaCanceladosTratar(req, res, urlObj, method, p) {
    if (!atende(prefixo, method, p)) return false;
    const k = lerChaveAdmin(req, urlObj);
    const sess = validarSessao(req.headers['cookie']);
    if (!((process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (sess && ehAdmin(sess)))) { json(res, 404, { error: 'not found' }); return true; }
    const base = { empresa };
    if (!o.cacheDir) { json(res, 200, Object.assign({ ok: false, etapa: 'sem_peca', erro: 'esta empresa ainda não passa a pasta do cache pra esta rota' }, base)); return true; }
    const q = (n) => String((urlObj.searchParams && urlObj.searchParams.get(n)) || '').trim();
    let tratados = null;
    try { tratados = lerTratados(); } catch (e) { json(res, 200, Object.assign({ ok: false, etapa: 'registro', erro: 'não consegui ler o registro dos cancelados já tratados' }, base)); return true; }

    /* ── o que a Toolbox precisa pra gerar a devolução ── */
    const preparar = q('preparar');
    if (preparar) {
      if (!/^\d{1,20}$/.test(preparar)) { json(res, 400, Object.assign({ ok: false, erro: 'use ?preparar=<id do pedido>' }, base)); return true; }
      if (Object.prototype.hasOwnProperty.call(tratados, preparar)) { json(res, 200, Object.assign({ ok: false, etapa: 'ja_tratado', erro: 'esse pedido já foi tratado' }, base)); return true; }
      const cf = await conferirAgora(preparar);
      if (!cf.ok) { json(res, 200, Object.assign({ ok: false, etapa: cf.etapa, erro: cf.erro }, base)); return true; }
      const ln = await lerNota(cf.p);
      if (!aindaNaFila(preparar)) { json(res, 200, Object.assign({}, SAIU_DA_FILA, base)); return true; }
      if (!ln.nf) { json(res, 200, Object.assign({ ok: false, etapa: ln.etapa, erro: ln.erro }, base)); return true; }
      if (sitDe(ln.nf) === 2) { json(res, 200, Object.assign({ ok: false, etapa: 'cancelada', erro: 'essa nota já está CANCELADA no Bling — não há o que devolver; toque em "já cancelei"' }, base)); return true; }
      /* a data que vale é a do Bling (a do checkout pode faltar). Sem data não sei se ainda cancela — e devolver uma nota
         que ainda cancelava é o caminho que o dono NÃO quer */
      const horas = C.horasDesde(ln.nf.dataEmissao || ln.nf.dataOperacao, agora());
      if (horas == null) { json(res, 200, Object.assign({ ok: false, etapa: 'sem_data', erro: 'não sei quando a nota foi emitida — confira no Bling: até 24 h, cancele; depois, gere a devolução por lá' }, base)); return true; }
      if (horas < C.HORAS_PRA_CANCELAR) { json(res, 200, Object.assign({ ok: false, etapa: 'ainda_cancela', erro: 'emitida há menos de 24 h — a regra é CANCELAR a nota no Bling, não devolver' }, base)); return true; }
      const loja = ln.nf.loja && ln.nf.loja.id != null && /^\d{1,20}$/.test(String(ln.nf.loja.id)) ? String(ln.nf.loja.id) : null;
      json(res, 200, Object.assign({ ok: true, pedido_id: preparar, nfe_id: ln.nfeId, numero: String(cf.p.nf_numero), id_loja: loja }, base));
      return true;
    }

    /* ── a nota foi tratada: move o pedido pra Cancelado e tira da lista ── */
    const resolver = q('resolver');
    if (resolver) {
      const como = q('como').toLowerCase();
      if (!/^\d{1,20}$/.test(resolver) || (como !== 'devolvida' && como !== 'cancelada')) { json(res, 400, Object.assign({ ok: false, erro: 'use ?resolver=<id do pedido>&como=devolvida|cancelada&confirma=sim' }, base)); return true; }
      if (q('confirma').toLowerCase() !== 'sim') { json(res, 200, Object.assign({ ok: false, etapa: 'confirmacao', erro: 'isto move o pedido pra Cancelado no Bling — acrescente &confirma=sim' }, base)); return true; }
      if (Object.prototype.hasOwnProperty.call(tratados, resolver)) { json(res, 200, Object.assign({ ok: false, etapa: 'ja_tratado', erro: 'esse pedido já foi tratado' }, base)); return true; }
      const cf = await conferirAgora(resolver);
      if (!cf.ok) { json(res, 200, Object.assign({ ok: false, etapa: cf.etapa, erro: cf.erro }, base)); return true; }
      if (!cf.p.nf_numero) { json(res, 200, Object.assign({ ok: false, etapa: 'sem_nf', erro: 'esse pedido não tem nota — cancele o pedido direto no Bling' }, base)); return true; }
      if (como === 'cancelada') {
        /* "já cancelei" se confere: pedido cancelado com a nota valendo é exatamente o que não pode acontecer */
        const ln = await lerNota(cf.p);
        if (!ln.nf) { json(res, 200, Object.assign({ ok: false, etapa: ln.etapa, erro: ln.erro }, base)); return true; }
        if (sitDe(ln.nf) !== 2) { json(res, 200, Object.assign({ ok: false, etapa: 'nao_cancelada', erro: 'a nota ' + String(cf.p.nf_numero) + ' ainda NÃO aparece cancelada no Bling — cancele por lá e toque de novo' }, base)); return true; }
      }
      const mv = await moverPraCancelado(resolver);
      if (mv.saiu) { json(res, 200, Object.assign({}, SAIU_DA_FILA, base)); return true; }
      if (!mv.ok) { json(res, 200, Object.assign({ ok: false, etapa: 'mover', erro: mv.erro + ' — a nota já foi tratada; toque de novo pra mover o pedido' }, base)); return true; }
      const campos = { em: new Date(agora()).toISOString(), como, por: 'admin', numero: cf.p.numero || null, numero_loja: cf.p.numero_loja, nf_numero: String(cf.p.nf_numero) };
      const dId = q('devolucao_id'), dNum = q('devolucao_numero');
      if (como === 'devolvida' && /^\d{1,20}$/.test(dId)) campos.devolucao_id = dId;
      if (como === 'devolvida' && /^\d{1,12}$/.test(dNum)) campos.devolucao_numero = dNum;
      /* o pedido JÁ foi movido; se o registro não gravar, a lista pode mostrar o pedido até o próximo ciclo tirá-lo da fila */
      let gravou = true; try { anotarTratado(resolver, campos); } catch (e) { gravou = false; }
      json(res, 200, Object.assign({ ok: true, resolvido: { pedido_id: resolver, numero: campos.numero, nf_numero: campos.nf_numero, como, movido_pra_cancelado: true, devolucao_numero: campos.devolucao_numero || null, anotado: gravou } }, base));
      return true;
    }

    /* ── a lista ── */
    const { fila } = L.filaTikTok();
    const cand = fila.filter((x) => x.numero_loja && !Object.prototype.hasOwnProperty.call(tratados, String(x.id)));
    if (!cand.length) { json(res, 200, Object.assign({ ok: true, total: 0, pendentes: [] }, base)); return true; }
    const tk = await L.consultarTikTok(cand.map((x) => x.numero_loja));
    const pendentes = [];
    for (const x of cand) {
      const ped = tk && tk.porId ? tk.porId[x.numero_loja] : null;
      if (ped && Mkt.classificarTikTok(ped).veredito === 'cancelado_antes_postagem') pendentes.push(linha(x));
    }
    /* o TikTok falhou no meio: o que veio é verdade, mas a lista pode estar incompleta — quem mostra não pode esconder o que já tinha */
    json(res, 200, Object.assign({ ok: !(tk && tk.erro), total: pendentes.length, pendentes }, tk && tk.erro ? { erro: tk.erro } : {}, base));
    return true;
  };
}

module.exports = { criar, atende, caminhoDe, ARQ, GUARDA_DIAS };
