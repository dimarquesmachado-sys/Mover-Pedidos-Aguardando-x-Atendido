'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   PEDIDO QUE O BLING JÁ CANCELOU COM A NOTA AINDA VALENDO — A ROTA (27/11/2026, peça única, as três empresas).

   A regra e a varredura moram em lib/checkout/cancelados-bling-vigia. Esta rota é como o painel (e o dono) chegam nela.
   SÓ LEITURA no Bling; nada é gerado, cancelado ou movido por aqui (esta é a parte 1: ver o buraco).

   GET <prefixo>/cancelados-bling
       → { ok, rodou_em, em_andamento, ultimo, total, pendentes: [{ pedido_id, numero, numero_loja, marketplace, data,
            nf_numero, nfe_id, horas_desde_a_emissao, acao, prova_local }], nota_em_outra_situacao: [{ pedido_id, numero, nf_numero, nf_situacao }] }
         `acao`: 'cancelar' (nota emitida há menos de 24 h — ainda cancela no Bling) ou 'devolucao' (24 h ou mais).
         `prova_local: false` = pedido mais velho que o registro de bipagem (28 dias): não dá pra dizer "não postado".
         A VIGIA SE RENOVA SOZINHA: quando a lista é pedida e a última rodada tem mais de 30 min, uma rodada LEVE (3 dias,
         poucas leituras) é disparada em segundo plano, como trabalho de FUNDO (cede a vez à operação no porteiro do Bling).
         A resposta não espera por ela — mostra o que já se sabe.
   GET <prefixo>/cancelados-bling?varrer=1[&dias=N][&forcar=sim]
       → dispara uma rodada agora. Até 7 dias é leve e roda a qualquer hora. Mais que isso é a VARREDURA DAS ANTIGAS:
         gasta cota do Bling (duas leituras por pedido cancelado não bipado) e, no horário do galpão (seg–sex, 7h–18h de
         São Paulo), é RECUSADA — a não ser com &forcar=sim. Uma rodada por vez.

   27/11, PARTE 2 — TRATAR (a pedido do dono: "se nao der cancelar 24h da emissao, gera a nf devolução"):
   GET  <prefixo>/cancelados-bling?preparar=<id do pedido>[&conferi=sim]
       → o que a Toolbox precisa pra gerar a NF de devolução: { ok, pedido_id, nfe_id, numero, id_loja, ids_fiscais?, confirmacao }.
         Tudo é conferido DE NOVO, na hora: o pedido está na lista e segue CANCELADO no Bling; o galpão não bipou; a nota é a
         do pedido e segue valendo; já passou das 24 h (antes disso a regra é CANCELAR a nota, não devolver).
         E o "NÃO FOI ENVIADO", que é do marketplace: onde este serviço lê o marketplace (hoje o TikTok), é ele quem diz —
         cancelado sem sinal de envio; onde não lê (Mercado Livre até calibrar, Shopee, Magalu…), quem diz é o ADMIN, que
         conferiu lá: sem `&conferi=sim` a resposta é `etapa: confirme_no_marketplace`.
   POST <prefixo>/cancelados-bling?resolver=<id>&como=cancelada|devolvida&confirma=sim[&conferi=sim][&devolucao_id=&devolucao_numero=]
       → tira o pedido do aviso. `cancelada` só passa com a nota CANCELADA no Bling; `devolvida` repete as conferências do
         preparar. Anota no MESMO registro do rota-cancelados-tratar (cancelados-tratados.json). NADA é escrito no Bling:
         o pedido já está cancelado lá. Com a sessão exige POST + checagem de origem (lib/http/acao-segura).

   GET  <prefixo>/cancelados-bling?sonda_devolucao=<id da NF de devolução>&da=<id da NF de venda>
       → sonda (lib/checkout/sonda-devolucao-nf): a devolução, lida pela API, aponta pra nota original? Nomes de campos e sim/não.

   Sem dado de gente. Trava: chave OU sessão de admin; sem as duas, 404.

   criar({ empresa, prefixo, json, lerChaveAdmin, validarSessao, ehAdmin, vigia, emFundo?, noGalpao?, agora?,
           — pra tratar: blingGet, garantirSitCancel(bg), lerConferidos(), cacheDir, tiktokConta?, tiktokOAuth? })
   ───────────────────────────────────────────────────────────────────────────── */
const RENOVA_MS = 30 * 60 * 1000;
const LEVE = { dias: 3, leituras: 40 };
const DIAS_LEVE_MAX = 7;

function caminhoDe(prefixo) { return prefixo + '/cancelados-bling'; }
function atende(prefixo, method, p) { return (method === 'GET' || method === 'POST') && p === caminhoDe(prefixo); }

/* onde ESTE serviço lê o marketplace e pode dizer "cancelado sem sinal de envio". O Mercado Livre entra quando a leitura
   dele for calibrada com caso real (sonda ?mkt=ml&venda=); até lá, e nos demais, quem confirma é o admin. */
const COM_LEITOR = { tiktok: 'TikTok' };
const NOME_MKT = { ml: 'Mercado Livre', tiktok: 'TikTok', shopee: 'Shopee', magalu: 'Magalu', amazon: 'Amazon', madeira: 'Madeira Madeira' };
const nomeMkt = (m) => NOME_MKT[m] || 'marketplace';

/* horário do galpão em São Paulo: segunda a sexta, das 7h às 18h */
function noGalpaoAgora(t) {
  const partes = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', weekday: 'short', hour: '2-digit', hour12: false }).formatToParts(new Date(t));
  const h = Number((partes.find((x) => x.type === 'hour') || {}).value || 0) % 24;
  const d = String((partes.find((x) => x.type === 'weekday') || {}).value || '');
  return !/^(Sat|Sun)$/.test(d) && h >= 7 && h < 18;
}

function criar(o) {
  if (!o || !o.empresa) throw new Error('lib/checkout/rota-cancelados-bling: falta empresa');
  for (const k of ['json', 'lerChaveAdmin', 'validarSessao', 'ehAdmin']) if (typeof o[k] !== 'function') throw new Error('lib/checkout/rota-cancelados-bling (' + o.empresa + '): falta ' + k);
  if (!o.prefixo || !o.vigia || typeof o.vigia.varrer !== 'function' || typeof o.vigia.pendentes !== 'function') throw new Error('lib/checkout/rota-cancelados-bling (' + o.empresa + '): falta prefixo/vigia');
  const { empresa, prefixo, json, lerChaveAdmin, validarSessao, ehAdmin, vigia } = o;
  const agora = o.agora || (() => Date.now());
  const noGalpao = o.noGalpao || noGalpaoAgora;
  const emFundo = o.emFundo || ((fn) => require('./contexto-fundo').emFundo(String(empresa) + '.cancelados-bling', fn));
  let ultimoDisparo = 0, ultimoErro = null;
  const C = require('../fiscal/nf-conserto-endereco');
  const V = require('./cancelados-bling-vigia');
  const T = require('./rota-cancelados-tratar');
  const Mkt = require('./rotas-cancelados-mkt');
  const sitDe = (n) => { const b = n && n.situacao && typeof n.situacao === 'object' ? n.situacao.valor : n && n.situacao; const v = Number(b); return b != null && b !== '' && Number.isInteger(v) && v > 0 ? v : null; };
  const txt = (v) => String(v == null ? '' : v).trim();
  const nao = (etapa, erro) => ({ ok: false, etapa, erro });
  async function leBling(caminho) {
    try { const r = await o.blingGet(caminho); if (r && r.ok && r.data && r.data.data && typeof r.data.data === 'object') return { d: r.data.data }; return { falhou: 'o Bling respondeu ' + ((r && r.status) || 'sem resposta') }; }
    catch (e) { return { falhou: 'não consegui falar com o Bling' }; }
  }

  /* o pedido está no aviso? (nota valendo no registro da vigia, ninguém tratou, o galpão não bipou) → { ok, reg } */
  function noAviso(id) {
    let reg = null, tratados = null;
    try { reg = vigia.ler().pedidos[id]; tratados = T.lerRegistro(o.cacheDir); }
    catch (e) { return nao('registro', 'não consegui ler o registro dos cancelados'); }
    if (Object.prototype.hasOwnProperty.call(tratados, id) || (reg && reg.tratado)) return nao('ja_tratado', 'esse pedido já foi tratado');
    if (!reg || reg.estado !== 'nf_valendo' || !reg.nf_id) return nao('fora_da_lista', 'esse pedido não está na lista dos cancelados com a nota valendo');
    if ((o.lerConferidos() || {})[id]) return nao('bipado', 'o galpão CONFERIU esse pedido (saiu) — é caso do Devoluções, não trato por aqui');
    return { ok: true, reg };
  }
  /* a NOTA, agora, no Bling: é a do registro. → { nf } ou { ok:false, etapa, erro } */
  async function notaAgora(reg) {
    const n = await leBling('/nfe/' + reg.nf_id);
    if (!n.d) return nao('bling', n.falhou + ' — tente de novo em instantes');
    if (String(n.d.id) !== String(reg.nf_id)) return nao('nota_diferente', 'o Bling devolveu outra nota pra esse pedido — não faço nada');
    return { nf: n.d };
  }
  /* TUDO, AGORA, pra gerar/registrar a devolução. → { ok:true, reg, nf, confirmacao } ou { ok:false, etapa, erro } */
  async function conferirAgora(id, conferi) {
    const av = noAviso(id);
    if (!av.ok) return av;
    const reg = av.reg;
    /* o pedido segue CANCELADO no Bling, e a nota dele é a do registro */
    let sit = null;
    try { sit = await o.garantirSitCancel(o.blingGet); } catch (e) { sit = null; }
    const sids = (sit && Array.isArray(sit.ids) ? sit.ids : []).map(Number).filter((x) => Number.isInteger(x) && x > 0);
    if (!sids.length) return nao('sem_situacao', 'não achei a situação "Cancelado" dos pedidos no Bling desta empresa — tente de novo em instantes');
    const pe = await leBling('/pedidos/vendas/' + id);
    if (!pe.d) return nao('bling', pe.falhou + ' — tente de novo em instantes');
    const sAtual = pe.d.situacao && pe.d.situacao.id != null ? Number(pe.d.situacao.id) : null;
    if (!sids.includes(sAtual)) return nao('nao_cancelado', 'esse pedido NÃO está mais cancelado no Bling — não trato por aqui');
    const nfPed = pe.d.notaFiscal && pe.d.notaFiscal.id != null ? String(pe.d.notaFiscal.id) : '';
    if (nfPed !== String(reg.nf_id)) return nao('nota_diferente', 'a nota ligada a esse pedido no Bling mudou — não faço nada; confira no Bling');
    const na = await notaAgora(reg);
    if (!na.nf) return na;
    const nf = na.nf, s = sitDe(nf);
    if (s === 2) return nao('cancelada', 'essa nota já está CANCELADA no Bling — não há o que devolver; toque em "já cancelei"');
    if (!V.SIT_VALENDO.has(s)) return nao('nota_sem_efeito', 'a nota não está autorizada no Bling (situação ' + (s == null ? 'desconhecida' : s) + ') — não há o que devolver por aqui');
    /* a nota diz de qual venda da loja é: se diz, tem que ser a deste pedido */
    const nlNota = txt(nf.numeroPedidoLoja != null ? nf.numeroPedidoLoja : nf.numeroLoja), nlPed = txt(pe.d.numeroLoja);
    if (nlNota && nlPed && nlNota !== nlPed) return nao('nota_de_outro_pedido', 'a nota ' + txt(nf.numero) + ' no Bling é de OUTRA venda — não faço nada; trate direto no Bling');
    /* "NÃO FOI ENVIADO" — do marketplace */
    const mkt = reg.marketplace || null;
    let confirmacao = null;
    if (mkt === 'tiktok' && COM_LEITOR.tiktok && o.tiktokConta) {
      if (!nlPed) return nao('sem_numero', 'o pedido está sem o número do TikTok — não consigo conferir o cancelamento');
      const L = Mkt.leitura({ manifest: () => ({}), lerConferidos: () => ({}), tiktokConta: o.tiktokConta, tiktokOAuth: o.tiktokOAuth });
      const tk = await L.consultarTikTok([nlPed]);
      const ped = tk && tk.porId ? tk.porId[nlPed] : null;
      if (!ped) return nao('nao_sei', (tk && tk.erro ? tk.erro : 'o TikTok não devolveu o pedido') + ' — não sei se foi enviado; tente de novo em instantes');
      const v = Mkt.classificarTikTok(ped).veredito;
      if (v === 'cancelado_depois_de_postado') return nao('postado', 'o TikTok mostra sinal de ENVIO nesse pedido — é caso do Devoluções, não trato por aqui');
      if (v === 'ativo') return nao('ativo', 'o TikTok não mostra esse pedido como cancelado — confira antes de mexer na nota');
      if (v !== 'cancelado_antes_postagem') return nao('nao_sei', 'não consegui ler o estado do pedido no TikTok — tente de novo em instantes');
      confirmacao = 'tiktok';
    } else {
      if (conferi !== 'sim') return nao('confirme_no_marketplace', 'não consigo ler o ' + nomeMkt(mkt) + ' daqui — confira lá que a venda foi cancelada SEM envio e confirme');
      confirmacao = 'admin';
    }
    /* enquanto eu lia, alguém pode ter tratado ou bipado */
    const de_novo = noAviso(id);
    if (!de_novo.ok) return de_novo;
    return { ok: true, reg, nf, confirmacao };
  }

  /* dispara sem esperar: a resposta HTTP não fica presa na varredura, e erro dela não derruba ninguém */
  function disparar(op) {
    ultimoDisparo = agora();
    Promise.resolve().then(() => emFundo(() => vigia.varrer(op)))
      .then((r) => { ultimoErro = r && r.ok === false && r.etapa !== 'rodando' ? String(r.erro || r.etapa || r.motivo || 'não rodou') : null; })
      .catch((e) => { ultimoErro = 'a varredura falhou: ' + String((e && e.message) || e).slice(0, 160); });
  }

  return async function rotaCanceladosBling(req, res, urlObj, method, p) {
    if (!atende(prefixo, method, p)) return false;
    const k = lerChaveAdmin(req, urlObj);
    const sess = validarSessao(req.headers['cookie']);
    if (!((process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (sess && ehAdmin(sess)))) { json(res, 404, { error: 'not found' }); return true; }
    const base = { empresa, so_leitura: true };
    const q = (n) => String((urlObj.searchParams && urlObj.searchParams.get(n)) || '').trim();
    /* ?resolver GRAVA (o registro dos tratados). O cookie de sessão viaja num link de outro site: com a sessão, a ação que
       grava exige POST + checagem de origem. A ADMIN_KEY (segredo, não ambiente) passa. */
    const viaChave = !!(process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || req._admKey === true;
    if (!viaChave && (method === 'POST' || q('resolver'))) {
      const csrf = require('../http/acao-segura').recusaCsrf(req, method);
      if (csrf) { json(res, 403, Object.assign({ ok: false, etapa: 'origem', erro: csrf }, base)); return true; }
    }
    /* ── sonda (27/11): a API do Bling diz de qual nota uma NF de devolução é? Só leitura; nomes de campos e sim/não ── */
    const sondaDev = q('sonda_devolucao');
    if (sondaDev) {
      const da = q('da');
      if (!/^\d{1,20}$/.test(sondaDev) || !/^\d{1,20}$/.test(da)) { json(res, 400, Object.assign({ ok: false, erro: 'use ?sonda_devolucao=<id da NF de devolução no Bling>&da=<id da NF de venda no Bling>' }, base)); return true; }
      if (typeof o.blingGet !== 'function') { json(res, 200, Object.assign({ ok: false, etapa: 'sem_peca', erro: 'esta empresa ainda não passa blingGet pra esta rota' }, base)); return true; }
      json(res, 200, Object.assign({ ok: true, sonda: await require('./sonda-devolucao-nf').sondar({ blingGet: o.blingGet, devId: sondaDev, origId: da, fetch: o.fetch }) }, base));
      return true;
    }
    const preparar = q('preparar'), resolver = q('resolver');
    if (preparar || resolver) {
      for (const pc of ['blingGet', 'garantirSitCancel', 'lerConferidos']) if (typeof o[pc] !== 'function') { json(res, 200, Object.assign({ ok: false, etapa: 'sem_peca', erro: 'esta empresa ainda não passa ' + pc + ' pra esta rota' }, base)); return true; }
      if (!o.cacheDir) { json(res, 200, Object.assign({ ok: false, etapa: 'sem_peca', erro: 'esta empresa ainda não passa a pasta do cache pra esta rota' }, base)); return true; }
    }
    const conferi = q('conferi').toLowerCase();

    /* ── o que a Toolbox precisa pra gerar a devolução ── */
    if (preparar) {
      if (!/^\d{1,20}$/.test(preparar)) { json(res, 400, Object.assign({ ok: false, erro: 'use ?preparar=<id do pedido>' }, base)); return true; }
      const cf = await conferirAgora(preparar, conferi);
      if (!cf.ok) { json(res, 200, Object.assign({}, cf, base)); return true; }
      /* sem data não sei se ainda cancela — e devolver uma nota que ainda cancelava é o caminho que o dono NÃO quer */
      const horas = C.horasDesde(cf.nf.dataEmissao || cf.nf.dataOperacao, agora());
      if (horas == null) { json(res, 200, Object.assign(nao('sem_data', 'não sei quando a nota foi emitida — confira no Bling: até 24 h, cancele; depois, gere a devolução por lá'), base)); return true; }
      if (horas < C.HORAS_PRA_CANCELAR) { json(res, 200, Object.assign(nao('ainda_cancela', 'emitida há menos de 24 h — a regra é CANCELAR a nota no Bling, não devolver'), base)); return true; }
      const loja = cf.nf.loja && cf.nf.loja.id != null && /^\d{1,20}$/.test(String(cf.nf.loja.id)) ? String(cf.nf.loja.id) : null;
      const fixos = require('./ids-fiscais-devolucao').idsFiscaisDevolucao(empresa);
      json(res, 200, Object.assign({ ok: true, pedido_id: preparar, nfe_id: String(cf.reg.nf_id), numero: txt(cf.nf.numero), id_loja: loja, confirmacao: cf.confirmacao }, fixos ? { ids_fiscais: fixos } : {}, base));
      return true;
    }

    /* ── a nota foi tratada: sai do aviso ── */
    if (resolver) {
      const como = q('como').toLowerCase();
      if (!/^\d{1,20}$/.test(resolver) || (como !== 'devolvida' && como !== 'cancelada')) { json(res, 400, Object.assign({ ok: false, erro: 'use ?resolver=<id do pedido>&como=devolvida|cancelada&confirma=sim' }, base)); return true; }
      if (q('confirma').toLowerCase() !== 'sim') { json(res, 200, Object.assign(nao('confirmacao', 'isto tira o pedido do aviso — acrescente &confirma=sim'), base)); return true; }
      let reg = null, nfNumero = null, confirmacao = null;
      if (como === 'cancelada') {
        /* "já cancelei" se confere: só sai do aviso com a nota CANCELADA no Bling */
        const av = noAviso(resolver);
        if (!av.ok) { json(res, 200, Object.assign({}, av, base)); return true; }
        const na = await notaAgora(av.reg);
        if (!na.nf) { json(res, 200, Object.assign({}, na, base)); return true; }
        if (sitDe(na.nf) !== 2) { json(res, 200, Object.assign(nao('nao_cancelada', 'a nota ' + txt(na.nf.numero) + ' ainda NÃO aparece cancelada no Bling — cancele por lá e toque de novo'), base)); return true; }
        reg = av.reg; nfNumero = txt(na.nf.numero);
      } else {
        const cf = await conferirAgora(resolver, conferi);
        if (!cf.ok) { json(res, 200, Object.assign({}, cf, base)); return true; }
        reg = cf.reg; nfNumero = txt(cf.nf.numero); confirmacao = cf.confirmacao;
      }
      const campos = { em: new Date(agora()).toISOString(), como, por: 'admin', origem: 'cancelado_no_bling', numero: reg.numero != null ? reg.numero : null, numero_loja: reg.numero_loja || null, nf_numero: nfNumero || null };
      if (confirmacao) campos.confirmacao = confirmacao;
      const dId = q('devolucao_id'), dNum = q('devolucao_numero');
      if (como === 'devolvida' && /^\d{1,20}$/.test(dId)) campos.devolucao_id = dId;
      if (como === 'devolvida' && /^\d{1,12}$/.test(dNum)) campos.devolucao_numero = dNum;
      try { T.anotarNoRegistro(o.cacheDir, resolver, campos, agora()); }
      catch (e) { json(res, 200, Object.assign(nao('registro', 'não consegui anotar que esse pedido foi tratado — toque de novo'), base)); return true; }
      json(res, 200, Object.assign({ ok: true, resolvido: { pedido_id: resolver, numero: campos.numero, nf_numero: campos.nf_numero, como, devolucao_numero: campos.devolucao_numero || null } }, base, { so_leitura: false }));
      return true;
    }

    if (q('varrer')) {
      const bruto = q('dias');
      if (bruto && !/^\d{1,3}$/.test(bruto)) { json(res, 400, Object.assign({ ok: false, erro: 'use ?varrer=1&dias=<1 a 180>' }, base)); return true; }
      const dias = bruto ? Math.max(1, Math.min(180, Number(bruto))) : LEVE.dias;
      if (vigia.emAndamento && vigia.emAndamento()) { json(res, 200, Object.assign({ ok: false, etapa: 'rodando', erro: 'já tem uma varredura em andamento — veja o resultado em ' + caminhoDe(prefixo) }, base)); return true; }
      const pesada = dias > DIAS_LEVE_MAX;
      if (pesada && noGalpao(agora()) && q('forcar').toLowerCase() !== 'sim') {
        json(res, 200, Object.assign({ ok: false, etapa: 'horario_do_galpao', erro: 'varredura de ' + dias + ' dias gasta cota do Bling e agora é horário do galpão (seg–sex, 7h–18h) — rode depois das 18h ou no fim de semana; pra rodar assim mesmo, acrescente &forcar=sim' }, base));
        return true;
      }
      disparar({ dias, leituras: pesada ? 600 : LEVE.leituras });
      json(res, 200, Object.assign({ ok: true, disparada: { dias, pesada }, acompanhe: caminhoDe(prefixo) }, base));
      return true;
    }

    let lido = null;
    try { lido = vigia.pendentes(); }
    catch (e) { json(res, 200, Object.assign({ ok: false, etapa: 'registro', erro: 'não consegui ler o registro da vigia dos cancelados' }, base)); return true; }
    /* a vigia se renova: lista pedida + última rodada velha (ou nenhuma) → uma rodada leve em segundo plano */
    const rodou = lido.rodou_em ? Date.parse(lido.rodou_em) : 0;
    const emAndamento = !!(vigia.emAndamento && vigia.emAndamento());
    if (!emAndamento && !(agora() - rodou < RENOVA_MS) && !(agora() - ultimoDisparo < RENOVA_MS)) disparar(LEVE);
    let ultimo = null;
    try { const reg = vigia.ler(); ultimo = reg && reg.ultimo ? reg.ultimo : null; } catch (e) { ultimo = null; }
    json(res, 200, Object.assign({ ok: true, rodou_em: lido.rodou_em, em_andamento: emAndamento, ultimo, ultimo_erro: ultimoErro, total: lido.pendentes.length,
      /* quem diz "não foi enviado": o marketplace, onde este serviço o lê; senão o admin (a tela pergunta) */
      pendentes: lido.pendentes.map((x) => Object.assign({}, x, { confirmacao: x.marketplace === 'tiktok' && COM_LEITOR.tiktok && o.tiktokConta ? 'tiktok' : 'admin', marketplace_nome: nomeMkt(x.marketplace) })), nota_em_outra_situacao: lido.outras || [], devolucao_achada_no_bling: lido.devolvidas || [],
      leia: 'pedidos que o Bling já cancelou, que o galpão não bipou, e cuja NF de VENDA ainda está autorizada. Quando a vigia acha no Bling a NF de devolução autorizada dessa nota, o pedido sai daqui sozinho e aparece em `devolucao_achada_no_bling`; se a devolução foi feita e ele continua aqui, toque em "já gerei a devolução". `nota_em_outra_situacao` = nota nem autorizada nem cancelada (pendente, rejeitada…): sem ação, só pra você ver.' }, base));
    return true;
  };
}

module.exports = { criar, atende, caminhoDe, noGalpaoAgora, RENOVA_MS, COM_LEITOR };
