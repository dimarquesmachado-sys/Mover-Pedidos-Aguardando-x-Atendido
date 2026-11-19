'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   O ENSAIO DO CONSERTO DA NF RECUSADA PELO ML POR ENDEREÇO — rota (18/11/2026), nas três empresas.

   GET <prefixo>/nf-conserto-ensaio?nf=<id da nota no Bling>[&pedido=<nº da venda no ML>]

   SÓ LÊ: a nota no Bling e o envio da venda no ML. Não cria, não altera, não cancela, não devolve nada — é a prova, com um
   caso real, de que os dados dos dois lados são os que o conserto automático supõe (lib/fiscal/nf-conserto-endereco, onde
   está o porquê). A resposta não leva dado de gente: por campo do endereço, só se a nota e a venda dizem o mesmo.

   · trava: chave OU sessão de admin; sem as duas, 404 (rota de admin não confirma que existe);
   · cada leitura que falha diz QUAL (`etapa`) e o que voltou — "não consegui ler" nunca vira "não precisa consertar".

   19/11 — 2ª etapa, A PRIMEIRA QUE ESCREVE: criar a nota nova no Bling.
   GET <prefixo>/nf-conserto-criar?nf=<id da nota no Bling>&confirma=sim[&pedido=…][&mesmo_ja_enviado=sim][&esquecer=sim]

   Faz o que o dono faz à mão no começo do conserto ("clono a NF, edito... colo campo por campo na nova NF no Bling,
   salvo"): cria no Bling a MESMA nota com o endereço da venda no ML. A nota nasce PENDENTE — esta etapa não envia à SEFAZ,
   não manda nada ao ML e não toca na nota errada (cancelar/devolver vêm depois, cada um na sua etapa).
   · sem `confirma=sim` não cria (abrir o link por engano não emite nada);
   · UMA nota nova por nota recusada: o registro em disco (lib/fiscal/nf-conserto-registro) barra a segunda — e "o Bling
     não respondeu" fica como DÚVIDA (não repete sozinho: pode ter criado). `esquecer=sim` solta a dúvida depois que
     alguém olhou no Bling; nota criada não se esquece;
   · venda que já saiu não ganha nota nova — `mesmo_ja_enviado=sim` é só pro teste de criação combinado com o dono;
   · o Bling recusou: a resposta diz QUAL campo e por quê, sem os valores da pessoa.
   ───────────────────────────────────────────────────────────────────────────── */
const path = require('path');
const _RAIZ = path.join(__dirname, '..', '..');


const LEIA_ENSAIO = 'ENSAIO: nada foi criado, alterado, cancelado nem devolvido. `campos` diz, por campo do endereço, se a nota e a venda no ML dizem o mesmo; `nota_errada` é o que seria feito com a nota recusada (cancelar até 24 h da emissão; depois, devolução); `pronta` = o conserto teria tudo o que precisa. `etiqueta` é a mesma comparação com o endereço de ENTREGA da nota; `forma` mostra quais campos a nota traz preenchidos (sem o valor); `tam_*` e `um_contem_o_outro` dizem se a diferença é de formato; `fica_de_fora_na_criacao` é o que a API do Bling só devolve na leitura. `envio_encerrado` = a venda já saiu ou foi cancelada no ML (não pede mais nota — entra nas pendências).';

function caminhoDe(prefixo) { return prefixo + '/nf-conserto-ensaio'; }
function caminhoDeCriar(prefixo) { return prefixo + '/nf-conserto-criar'; }
function atende(prefixo, method, p) { return method === 'GET' && (p === caminhoDe(prefixo) || p === caminhoDeCriar(prefixo)); }

function criar(o) {
  if (!o || !o.empresa) throw new Error('lib/checkout/rota-nf-conserto: falta empresa');
  for (const k of ['json', 'lerChaveAdmin', 'validarSessao', 'ehAdmin', 'blingGet']) {
    if (typeof o[k] !== 'function') throw new Error('lib/checkout/rota-nf-conserto (' + o.empresa + '): falta ' + k);
  }
  const cfg = require('./config-empresa').configCheckout(o.empresa);   /* empresa fora do contrato derruba no boot */
  const prefixo = o.prefixo != null ? o.prefixo : require('./config-empresa').prefixoDe(o.empresa);
  const { empresa, json, lerChaveAdmin, validarSessao, ehAdmin, blingGet } = o;
  const tokenML = o.tokenML || (async () => require(path.join(_RAIZ, cfg.mlTokenManager)).garantirTokenML());   /* o token do ML DA EMPRESA, do contrato */
  const buscar = o.fetch || require('node-fetch');
  const C = require('../fiscal/nf-conserto-endereco');
  const Reg = require('../fiscal/nf-conserto-registro');
  const prazoMs = Number.isFinite(Number(o.prazoMs)) ? Number(o.prazoMs) : 15000;
  const _criando = new Set();   /* notas com criação em andamento NESTE processo (dois cliques seguidos) */

  /* leitura do ML com prazo: { status, data } — status 0 = não respondeu (rede, prazo) */
  async function mlGet(token, caminho) {
    const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), prazoMs);
    try {
      const r = await buscar('https://api.mercadolibre.com' + caminho, { headers: { Authorization: 'Bearer ' + token, 'x-format-new': 'true' }, signal: ac.signal });
      let data = null; try { data = await r.json(); } catch (e) { data = null; }
      return { status: r.status, data };
    } catch (e) { return { status: 0, data: null, erro: String((e && e.message) || e).slice(0, 120) }; }
    finally { clearTimeout(tm); }
  }

  /* as leituras que as duas rotas fazem: a nota no Bling e o envio da venda no ML. Devolve { falha: [etapa, erro, mais] }
     ou { nf, envio, pedidoML, via } */
  async function lerNotaEEnvio(nfId, pedParam) {
    /* 1) a nota, no Bling */
    const rN = await blingGet('/nfe/' + nfId);
    const nf = rN && rN.ok && rN.data && rN.data.data;
    if (!nf || typeof nf !== 'object') return { falha: ['nota_no_bling', 'não consegui ler a nota ' + nfId + ' no Bling', { status: (rN && rN.status) || null }] };
    const pedidoML = pedParam || String(nf.numeroPedidoLoja || '').trim();
    if (!/^\d{1,25}$/.test(pedidoML)) return { falha: ['pedido_do_ml', 'a nota não diz de qual venda do ML é (numeroPedidoLoja) — passe &pedido=<nº da venda no ML>'] };
    /* 2) o token do ML da empresa */
    let tok = null;
    try { tok = await tokenML(); } catch (e) { return { falha: ['token_do_ml', 'sem token do ML: ' + String((e && e.message) || e).slice(0, 120)] }; }
    if (!tok) return { falha: ['token_do_ml', 'sem token do ML'] };
    /* 3) o envio da venda: pela venda; se o número for de carrinho, pelo carrinho */
    let envioId = null, via = null;
    const rO = await mlGet(tok, '/orders/' + pedidoML);
    if (rO.status === 200 && rO.data && rO.data.shipping && rO.data.shipping.id) { envioId = rO.data.shipping.id; via = 'venda'; }
    else {
      const rP = await mlGet(tok, '/packs/' + pedidoML);
      if (rP.status === 200 && rP.data && rP.data.shipment && rP.data.shipment.id) { envioId = rP.data.shipment.id; via = 'carrinho'; }
      else return { falha: ['envio_da_venda', 'não achei o envio da venda ' + pedidoML + ' no ML', { status_venda: rO.status, status_carrinho: rP.status }] };
    }
    /* 4) o envio, com o endereço de entrega */
    const rE = await mlGet(tok, '/shipments/' + envioId);
    if (rE.status !== 200 || !rE.data || typeof rE.data !== 'object') return { falha: ['envio_no_ml', 'o ML não devolveu o envio da venda', { status: rE.status }] };
    return { nf, envio: rE.data, pedidoML, via };
  }

  /* ── a 2ª etapa: criar a nota nova (PENDENTE) no Bling ── */
  async function criarNotaNova(res, urlObj, nfId, pedParam) {
    const base = { empresa, ensaio: false };
    const q = (n) => String((urlObj.searchParams && urlObj.searchParams.get(n)) || '').trim().toLowerCase();
    const sai = (ok, escreveu, corpo) => { json(res, 200, Object.assign({ ok }, corpo, base, { escreveu_algo: escreveu })); return true; };
    const falha = (etapa, erro, mais) => sai(false, false, Object.assign({ etapa, erro }, mais || {}));
    if (typeof o.blingWrite !== 'function' || !o.cacheDir) return falha('sem_peca', 'esta empresa ainda não passa a escrita no Bling (blingWrite) e a pasta do cache pra esta rota');
    const dir = o.cacheDir;
    /* soltar uma dúvida (quem olhou o Bling decide) — não lê nem escreve nada fora do registro */
    if (q('esquecer') === 'sim') {
      if (_criando.has(nfId)) return falha('em_andamento', 'a criação da nota nova dessa nota está em andamento — não dá pra esquecer no meio');
      try {
        const antes = Reg.de(dir, nfId);
        if (!antes) return falha('esquecer', 'não há registro de conserto dessa nota');
        if (!Reg.soltar(dir, nfId)) return falha('esquecer', 'a nota nova dessa nota JÁ FOI CRIADA (id ' + antes.nova_id + ', nº ' + antes.nova_numero + ') — registro de nota criada não se apaga', { nova: { id: antes.nova_id, numero: antes.nova_numero } });
        return sai(true, false, { esqueceu: true, estado_que_estava: antes.estado, leia: 'O registro da tentativa anterior foi apagado. Se a nota nova NÃO existe no Bling, pode pedir a criação de novo.' });
      } catch (e) { return falha('registro', 'não consegui ler/gravar o registro do conserto: ' + String((e && e.message) || e).slice(0, 120)); }
    }
    if (q('confirma') !== 'sim') return falha('confirmacao', 'esta rota CRIA uma nota fiscal (pendente) no Bling. Pra criar de verdade, acrescente &confirma=sim ao endereço. Pra só conferir, use /nf-conserto-ensaio.');
    /* o registro: já houve conserto dessa nota? (arquivo ilegível PARA — sem ele não há como garantir que não duplica) */
    let reg = null;
    try { reg = Reg.de(dir, nfId); } catch (e) { return falha('registro', 'não consegui ler o registro do conserto: ' + String((e && e.message) || e).slice(0, 120)); }
    if (reg && reg.estado === 'criada') return sai(true, false, { criou: false, ja_existia: true, nova: { id: reg.nova_id, numero: reg.nova_numero }, leia: 'A nota nova dessa nota já tinha sido criada antes — não criei outra.' });
    if (_criando.has(nfId)) return falha('em_andamento', 'a criação da nota nova dessa nota está em andamento — espere a resposta da primeira chamada');
    if (reg) return falha('incerta', 'uma tentativa anterior de criar a nota nova não teve resposta conclusiva do Bling (' + (reg.estado === 'incerta' ? (reg.motivo || 'sem resposta') : 'o servidor parou no meio') + '). NÃO SEI se a nota foi criada. Confira no Bling (notas pendentes, mesmo cliente e valor): se ela existe, siga por lá; se não existe, abra este endereço com &esquecer=sim e depois peça de novo.', { desde: reg.desde || null });
    _criando.add(nfId);
    let abriu = false;
    try {
      const L = await lerNotaEEnvio(nfId, pedParam);
      if (L.falha) return falha(L.falha[0], L.falha[1], L.falha[2]);
      const teste = q('mesmo_ja_enviado') === 'sim';
      const plano = C.planejar(L.nf, L.envio, Date.now(), { aceitaEnvioEncerrado: teste });
      if (!plano.ok || !plano.pronta || !plano.nota_nova) return falha('plano', 'o conserto não está pronto pra essa nota', { pendencias: plano.pendencias || [], envio_encerrado: !!plano.envio_encerrado });
      /* abre o registro ANTES de pedir: se o servidor cair no meio, a próxima chamada encontra "criando" e não repete */
      try { if (!Reg.abrir(dir, nfId, { numero: L.nf.numero != null ? String(L.nf.numero) : null, pedido_ml: L.pedidoML, teste: teste && !!plano.envio_encerrado })) return falha('em_andamento', 'outra chamada abriu o conserto dessa nota agora há pouco'); }
      catch (e) { return falha('registro', 'não consegui gravar o registro do conserto — sem ele não crio a nota: ' + String((e && e.message) || e).slice(0, 120)); }
      abriu = true;
      const r = await o.blingWrite('POST', '/nfe', plano.nota_nova, { semRetryDeRede: true });
      const st = Number(r && r.status) || 0;
      const nova = r && r.ok && r.data && r.data.data && r.data.data.id ? r.data.data : null;
      if (!nova) {
        /* RECUSA CONCLUSIVA (o Bling disse não, ou o pedido nem saiu): nada foi criado — o registro sai e dá pra tentar de novo */
        const conclusiva = st >= 400 && st < 500 && st !== 408;   /* 408 (o Bling desistiu de esperar) não diz se criou */
        if (conclusiva) {
          let soltou = true; try { Reg.soltar(dir, nfId); } catch (e) { soltou = false; }
          const er = (r && r.data && r.data.error) || {};
          const limpo = (t) => C.semValoresDe(t, L.nf, plano.nota_nova);   /* o Bling ecoa o que recebeu: saem os valores da nota antiga E os da nova */
          const campos = (Array.isArray(er.fields) ? er.fields : []).slice(0, 20).map((f) => ({ campo: limpo(f && (f.element || f.field || f.namespace)).slice(0, 80), motivo: limpo(f && (f.msg || f.message)).slice(0, 200) }));
          return falha(st === 429 ? 'bling_ocupado' : (st === 401 ? 'token_do_bling' : 'bling_recusou'),
            st === 429 ? 'o Bling está limitando as chamadas agora — nada foi criado; tente de novo em alguns minutos' : (st === 401 ? 'o Bling não aceitou o token — nada foi criado' : 'o Bling recusou a nota — nada foi criado'),
            { status: st, tipo: limpo(er.type).slice(0, 80) || null, mensagem: limpo(er.message).slice(0, 200) || null, descricao: limpo(er.description).slice(0, 300) || null, campos,
              corpo: campos.length || er.message || er.description ? undefined : limpo((r && (r.raw || r.erro)) || '').slice(0, 300), registro_solto: soltou });
        }
        /* NÃO SEI: rede caiu no meio, 5xx, ou "ok" sem o id — a nota PODE existir. Fica a dúvida; não repete sozinho. */
        const motivo = r && r.ambiguo ? 'a conexão caiu antes da resposta do Bling' : (r && r.ok ? 'o Bling respondeu sem o id da nota' : 'o Bling respondeu ' + st);
        let anotou = true; try { Reg.duvida(dir, nfId, motivo); } catch (e) { anotou = false; }   /* se não gravou, o registro segue "criando" — que também barra */
        return sai(false, 'talvez', { etapa: 'incerta', erro: motivo + ' — NÃO SEI se a nota nova foi criada. Confira no Bling (notas pendentes, mesmo cliente e valor) antes de qualquer coisa. Se não existe, abra este endereço com &esquecer=sim e peça de novo.', status: st, duvida_anotada: anotou });
      }
      /* criada: fecha o registro (se não gravar, ele fica "criando" e a próxima chamada cai na dúvida — nunca duplica) */
      let fechou = true; try { Reg.fechar(dir, nfId, nova); } catch (e) { fechou = false; }
      /* e relê a nota criada pra dizer se saiu como a venda pede (leitura — se falhar, a nota continua criada) */
      let confere = null;
      try { const rC = await blingGet('/nfe/' + nova.id); confere = C.conferirNotaCriada(rC && rC.ok && rC.data && rC.data.data, L.nf, C.enderecoDoML(L.envio)); } catch (e) { confere = null; }
      return sai(true, true, { criou: true, nova: { id: String(nova.id), numero: nova.numero != null ? String(nova.numero) : null }, da_nota: { id: nfId, numero: L.nf.numero || null }, pedido_ml: L.pedidoML,
        teste_com_venda_ja_enviada: teste && !!plano.envio_encerrado, registro_gravado: fechou, confere,
        leia: 'A nota nova foi CRIADA no Bling como PENDENTE (rascunho): não foi enviada à SEFAZ, nada foi mandado ao ML e a nota antiga não foi tocada. Abra a nota nova no Bling e confira o endereço. `confere` é a nota relida do Bling: se o endereço e a entrega ficaram iguais aos da venda, se itens/valor/natureza/loja batem com a antiga e se a nota guarda o pedido da loja. `confere: null` = não consegui reler (a nota existe mesmo assim).' });
    } catch (e) {
      /* estourou depois de abrir o registro? o pedido pode ter saído: fica a dúvida (o registro "criando" barra a
         repetição). Antes de abrir, nada saiu. */
      if (abriu) return sai(false, 'talvez', { etapa: 'incerta', erro: 'erro no meio da criação (' + String((e && e.message) || e).slice(0, 120) + ') — NÃO SEI se a nota nova foi criada. Confira no Bling antes de qualquer coisa. Se não existe, abra este endereço com &esquecer=sim e peça de novo.' });
      return falha('erro', String((e && e.message) || e).slice(0, 160));
    } finally { _criando.delete(nfId); }
  }

  return async function rotaNfConserto(req, res, urlObj, method, p) {
    if (!atende(prefixo, method, p)) return false;
    const k = lerChaveAdmin(req, urlObj);
    const sess = validarSessao(req.headers['cookie']);
    if (!((process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (sess && ehAdmin(sess)))) { json(res, 404, { error: 'not found' }); return true; }
    const ehCriar = p === caminhoDeCriar(prefixo);
    const base = { empresa, ensaio: !ehCriar, escreveu_algo: false };
    const nfId = String((urlObj.searchParams && urlObj.searchParams.get('nf')) || '').trim();
    if (!/^\d{1,20}$/.test(nfId)) { json(res, 400, Object.assign({ ok: false, erro: 'use ?nf=<id da nota no Bling> (só dígitos) — é o número que aparece no endereço da página quando você abre a nota no Bling; opcional: &pedido=<nº da venda no ML>' }, base)); return true; }
    const pedParam = String((urlObj.searchParams && urlObj.searchParams.get('pedido')) || '').trim();
    if (pedParam && !/^\d{1,25}$/.test(pedParam)) { json(res, 400, Object.assign({ ok: false, erro: 'pedido: só dígitos (o nº da venda no ML)' }, base)); return true; }
    if (ehCriar) return criarNotaNova(res, urlObj, nfId, pedParam);
    const falha = (etapa, erro, mais) => { json(res, 200, Object.assign({ ok: false, etapa, erro }, mais || {}, base)); return true; };
    try {
      const L = await lerNotaEEnvio(nfId, pedParam);
      if (L.falha) return falha(L.falha[0], L.falha[1], L.falha[2]);
      const plano = C.semDadoDeGente(C.planejar(L.nf, L.envio, Date.now()));
      json(res, 200, Object.assign({}, plano, { nf: { id: nfId, numero: L.nf.numero || null }, pedido_ml: L.pedidoML, envio_achado_por: L.via,
        envio: { status: L.envio.status || null, substatus: L.envio.substatus || null, campos: Object.keys(L.envio).sort() },
        leia: LEIA_ENSAIO }, base));
      return true;
    } catch (e) { return falha('erro', String((e && e.message) || e).slice(0, 160)); }
  };
}

module.exports = { criar, atende, caminhoDe, caminhoDeCriar };
