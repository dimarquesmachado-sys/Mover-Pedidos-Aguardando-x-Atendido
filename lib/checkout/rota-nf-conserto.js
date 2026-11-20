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

   19/11 — 3ª etapa: EMITIR a nota nova e mandar o XML ao ML.
   GET <prefixo>/nf-conserto-enviar?nf=<id da nota RECUSADA no Bling>&confirma=sim

   O resto do que o dono faz à mão: "clico pra enviar NF, a Sefaz então autoriza, daí eu clico pra baixar o XML... vou no
   Mlivre, dentro do pedido em INFORMAR NF JÁ EMITIDA, e lá eu anexo o XML, confirmo". Cada chamada olha em que pé a nota
   nova está no Bling e dá o passo que falta — pode ser chamada de novo até terminar:
     · pendente      → confere de novo contra a venda (a venda não encerrou; o endereço da nota ainda é o da venda) e pede
                       a emissão (POST /nfe/{id}/enviar); se a SEFAZ autorizar na hora, segue pro ML na mesma chamada;
     · autorizada    → manda o XML ao ML (o mesmo envio da rotina F3) e, aceito, tira a nota recusada do aviso do checkout;
     · rejeitada, cancelada, denegada, em processamento → diz, e não faz nada.
   Só mexe em nota nova que ESTA rotina criou (o registro), nunca em nota de teste, e não toca na nota recusada.
   ───────────────────────────────────────────────────────────────────────────── */
const path = require('path');
const _RAIZ = path.join(__dirname, '..', '..');


const LEIA_ENSAIO = 'ENSAIO: nada foi criado, alterado, cancelado nem devolvido. `campos` diz, por campo do endereço, se a nota e a venda no ML dizem o mesmo; `nota_errada` é o que seria feito com a nota recusada (cancelar até 24 h da emissão; depois, devolução); `pronta` = o conserto teria tudo o que precisa. `etiqueta` é a mesma comparação com o endereço de ENTREGA da nota; `forma` mostra quais campos a nota traz preenchidos (sem o valor); `tam_*` e `um_contem_o_outro` dizem se a diferença é de formato; `fica_de_fora_na_criacao` é o que a API do Bling só devolve na leitura. `envio_encerrado` = a venda já saiu ou foi cancelada no ML (não pede mais nota — entra nas pendências).';

function caminhoDe(prefixo) { return prefixo + '/nf-conserto-ensaio'; }
function caminhoDeCriar(prefixo) { return prefixo + '/nf-conserto-criar'; }
function caminhoDeEnviar(prefixo) { return prefixo + '/nf-conserto-enviar'; }
function atende(prefixo, method, p) { return method === 'GET' && (p === caminhoDe(prefixo) || p === caminhoDeCriar(prefixo) || p === caminhoDeEnviar(prefixo)); }

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
  const Trav = require('../nf-travadas');
  /* o envio do XML ao ML é o MESMO da rotina F3 (lib/fiscal/ml-api): acha o envio da venda (ou do carrinho), só manda se
     o ML está pedindo a nota, baixa o XML do Bling e entrega */
  const enviarAoML = o.enviarNFeParaML || require('../fiscal/ml-api').criarMlApi({ rotulo: String(empresa).toUpperCase() }).enviarNFeParaML;
  const ESPERA_SEFAZ_MS = Number.isFinite(Number(o.esperaSefazMs)) ? Number(o.esperaSefazMs) : 2 * 60000;   /* não repete o pedido de emissão antes disso */
  const _enviando = new Set();
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

  /* o envio de uma venda do ML (pela venda ou pelo carrinho): { falha: [etapa, erro, mais] } ou { envio, via } */
  async function lerEnvioDaVenda(pedidoML) {
    /* o token do ML da empresa */
    let tok = null;
    try { tok = await tokenML(); } catch (e) { return { falha: ['token_do_ml', 'sem token do ML: ' + String((e && e.message) || e).slice(0, 120)] }; }
    if (!tok) return { falha: ['token_do_ml', 'sem token do ML'] };
    /* o envio da venda: pela venda; se o número for de carrinho, pelo carrinho */
    let envioId = null, via = null;
    const rO = await mlGet(tok, '/orders/' + pedidoML);
    if (rO.status === 200 && rO.data && rO.data.shipping && rO.data.shipping.id) { envioId = rO.data.shipping.id; via = 'venda'; }
    else {
      const rP = await mlGet(tok, '/packs/' + pedidoML);
      if (rP.status === 200 && rP.data && rP.data.shipment && rP.data.shipment.id) { envioId = rP.data.shipment.id; via = 'carrinho'; }
      else return { falha: ['envio_da_venda', 'não achei o envio da venda ' + pedidoML + ' no ML', { status_venda: rO.status, status_carrinho: rP.status }] };
    }
    /* o envio, com o endereço de entrega */
    const rE = await mlGet(tok, '/shipments/' + envioId);
    if (rE.status !== 200 || !rE.data || typeof rE.data !== 'object') return { falha: ['envio_no_ml', 'o ML não devolveu o envio da venda', { status: rE.status }] };
    return { envio: rE.data, via };
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
    /* 2) o envio da venda, no ML */
    const E = await lerEnvioDaVenda(pedidoML);
    if (E.falha) return E;
    return { nf, envio: E.envio, pedidoML, via: E.via };
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
      const plano = C.planejar(L.nf, L.envio, Date.now(), { aceitaEnvioEncerrado: teste, pedidoML: L.pedidoML });
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
              corpo: campos.length || er.message || er.description ? undefined : limpo((r && (r.raw || r.erro)) || '').slice(0, 300), registro_solto: soltou,
              /* o que foi mandado, só os NOMES dos campos do topo — pra saber o que falta sem ver valor nenhum */
              campos_enviados: Object.keys(plano.nota_nova).sort() });
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

  /* ── a 3ª etapa: emitir a nota nova e mandar o XML ao ML ── */
  const SIT = { 1: 'pendente', 2: 'cancelada', 3: 'aguardando recibo', 4: 'rejeitada', 5: 'autorizada', 6: 'autorizada (DANFE emitido)', 7: 'registrada', 8: 'aguardando protocolo', 9: 'denegada', 10: 'consulta de situação', 11: 'bloqueada' };
  const sitDe = (n) => { const v = Number(n && n.situacao && typeof n.situacao === 'object' ? n.situacao.valor : n && n.situacao); return isFinite(v) ? v : null; };
  async function enviarNotaNova(res, urlObj, nfId) {
    const base = { empresa, ensaio: false };
    const q = (n) => String((urlObj.searchParams && urlObj.searchParams.get(n)) || '').trim().toLowerCase();
    const feito = [];   /* o que ESTA chamada fez de verdade: 'pediu_emissao', 'mandou_xml_ao_ml' */
    const sai = (ok, corpo) => { json(res, 200, Object.assign({ ok }, corpo, base, { fez: feito.slice(), escreveu_algo: feito.length > 0 })); return true; };
    const falha = (etapa, erro, mais) => sai(false, Object.assign({ etapa, erro }, mais || {}));
    if (typeof o.blingWrite !== 'function' || !o.cacheDir) return falha('sem_peca', 'esta empresa ainda não passa a escrita no Bling (blingWrite) e a pasta do cache pra esta rota');
    const dir = o.cacheDir;
    if (q('confirma') !== 'sim') return falha('confirmacao', 'esta rota EMITE a nota nova (envia à SEFAZ) e manda o XML ao Mercado Livre. Pra fazer de verdade, acrescente &confirma=sim ao endereço.');
    let reg = null;
    try { reg = Reg.de(dir, nfId); } catch (e) { return falha('registro', 'não consegui ler o registro do conserto: ' + String((e && e.message) || e).slice(0, 120)); }
    if (!reg) return falha('sem_nota_nova', 'não há nota nova criada pra essa nota — crie primeiro em /nf-conserto-criar');
    if (reg.estado !== 'criada' || !reg.nova_id) return falha('incerta', 'a criação da nota nova dessa nota ficou em dúvida — resolva em /nf-conserto-criar antes de emitir');
    const nova = { id: String(reg.nova_id), numero: reg.nova_numero || null };
    if (reg.teste) return falha('nota_de_teste', 'a nota nova dessa nota foi criada como TESTE (a venda já tinha saído) — nota de teste não é emitida. Exclua a nota ' + (nova.numero || nova.id) + ' no Bling.', { nova });
    if (reg.no_ml_em) return sai(true, { etapa: 'no_ml', ja_estava: true, nova, leia: 'O XML dessa nota nova já foi aceito pelo ML antes — nada a fazer.' });
    const pedidoML = String(reg.pedido_ml || '').trim();
    if (!/^\d{1,25}$/.test(pedidoML)) return falha('pedido_do_ml', 'o registro não diz de qual venda do ML é essa nota');
    if (_enviando.has(nfId)) return falha('em_andamento', 'o envio dessa nota está em andamento — espere a resposta da primeira chamada');
    _enviando.add(nfId);
    const anotar = (campos) => { try { return Reg.anotar(dir, nfId, campos); } catch (e) { return false; } };
    try {
      const lerNova = async () => { const r = await blingGet('/nfe/' + nova.id); return { st: Number(r && r.status) || 0, nf: r && r.ok && r.data && r.data.data && typeof r.data.data === 'object' ? r.data.data : null }; };
      let N = await lerNova();
      if (!N.nf) return falha('nota_nova_no_bling', N.st === 404 ? 'a nota nova (id ' + nova.id + ') não existe mais no Bling — foi excluída?' : 'não consegui ler a nota nova no Bling', { status: N.st || null, nova });
      let sit = sitDe(N.nf);
      if (sit === 1) {
        /* PENDENTE: antes de emitir, confere DE NOVO contra a venda — entre criar e emitir a venda pode ter saído, e a
           nota pode ter sido editada no Bling */
        if (reg.sefaz_pedida_em && Date.now() - (Date.parse(reg.sefaz_pedida_em) || 0) < ESPERA_SEFAZ_MS) return sai(true, { etapa: 'aguardando_sefaz', nova, situacao: sit, leia: 'A emissão foi pedida há pouco e a nota ainda aparece como pendente no Bling. Chame de novo em 1 ou 2 minutos.' });
        const E = await lerEnvioDaVenda(pedidoML);
        if (E.falha) return falha(E.falha[0], E.falha[1], Object.assign({ nova }, E.falha[2] || {}));
        const stEnvio = String(E.envio.status || '').trim().toLowerCase();
        if (C.ENVIO_ENCERRADO.includes(stEnvio)) return falha('envio_encerrado', 'o envio da venda no ML já está "' + stEnvio + '" — o ML não pede mais nota; NÃO emiti. Exclua a nota pendente ' + (nova.numero || nova.id) + ' no Bling.', { nova });
        const cf = C.conferirNotaCriada(N.nf, null, C.enderecoDoML(E.envio));
        if (!cf || cf.endereco_igual_ao_da_venda !== true || cf.entrega_igual_ao_da_venda === false) return falha('nota_diferente_da_venda', 'o endereço da nota nova no Bling não é (mais) o da venda no ML — NÃO emiti. Confira a nota ' + (nova.numero || nova.id) + ' no Bling.', { nova, endereco_igual_ao_da_venda: cf ? cf.endereco_igual_ao_da_venda : null, entrega_igual_ao_da_venda: cf ? cf.entrega_igual_ao_da_venda : null });
        if (!anotar({ sefaz_pedida_em: new Date().toISOString() })) return falha('registro', 'não consegui anotar o pedido de emissão no registro — não emiti');
        const r = await o.blingWrite('POST', '/nfe/' + nova.id + '/enviar', {}, { semRetryDeRede: true });
        feito.push('pediu_emissao');
        const st = Number(r && r.status) || 0;
        if (!(r && r.ok)) {
          if (st >= 400 && st < 500 && st !== 408) {
            /* o Bling disse não (validação, limite): a nota segue pendente — pode pedir de novo já */
            feito.pop(); anotar({ sefaz_pedida_em: null });
            const er = (r && r.data && r.data.error) || {};
            const limpo = (t) => C.semValoresDe(t, N.nf);
            return falha(st === 429 ? 'bling_ocupado' : 'bling_recusou_a_emissao', st === 429 ? 'o Bling está limitando as chamadas agora — a emissão não foi pedida; tente de novo em alguns minutos' : 'o Bling não aceitou emitir a nota', { status: st, nova, tipo: limpo(er.type).slice(0, 80) || null, mensagem: limpo(er.message).slice(0, 200) || null, descricao: limpo(er.description).slice(0, 300) || null,
              campos: (Array.isArray(er.fields) ? er.fields : []).slice(0, 20).map((f) => ({ campo: limpo(f && (f.element || f.field || f.namespace)).slice(0, 80), motivo: limpo(f && (f.msg || f.message)).slice(0, 200) })) });
          }
          /* não sei se o pedido chegou: a mesma nota não é autorizada duas vezes pela SEFAZ, então basta olhar de novo depois */
          return sai(false, { etapa: 'aguardando_sefaz', erro: (r && r.ambiguo ? 'a conexão caiu antes da resposta do Bling' : 'o Bling respondeu ' + st) + ' — não sei se o pedido de emissão chegou. Chame de novo em 1 ou 2 minutos: a rota olha a situação da nota e continua de onde parou.', nova, status: st });
        }
        N = await lerNova();
        if (!N.nf) return sai(true, { etapa: 'aguardando_sefaz', nova, leia: 'A emissão foi pedida; não consegui reler a nota agora. Chame de novo em 1 ou 2 minutos.' });
        sit = sitDe(N.nf);
        if (sit === 1) return sai(true, { etapa: 'aguardando_sefaz', nova, situacao: sit, leia: 'A emissão foi pedida e a nota ainda aparece como pendente no Bling. Chame de novo em 1 ou 2 minutos.' });
      }
      if (sit === 5 || sit === 6 || sit === 7) {
        if (!N.nf.xml) return sai(true, { etapa: 'aguardando_xml', nova, situacao: sit, leia: 'A nota está autorizada, mas o Bling ainda não devolveu o endereço do XML. Chame de novo em 1 ou 2 minutos.' });
        let tok = null;
        try { tok = await tokenML(); } catch (e) { return falha('token_do_ml', 'sem token do ML: ' + String((e && e.message) || e).slice(0, 120), { nova, situacao: sit }); }
        if (!tok) return falha('token_do_ml', 'sem token do ML', { nova, situacao: sit });
        try { await enviarAoML(tok, pedidoML, N.nf); }
        catch (e) {
          const msg = C.semValoresDe(String((e && e.message) || e), N.nf).slice(0, 300);
          if (e && (e.mlStatus || e.mlSubstatus)) {
            /* o ML não está pedindo a nota AGORA */
            const enc = C.ENVIO_ENCERRADO.includes(String(e.mlStatus || '').toLowerCase());
            return falha(enc ? 'envio_encerrado' : 'ml_nao_pede_nota', enc ? 'a nota nova está AUTORIZADA, mas o envio da venda no ML já está "' + e.mlStatus + '" — o ML não recebe mais nota pra essa venda' : 'a nota nova está autorizada, mas o ML não está pedindo nota pra essa venda agora — chame de novo mais tarde', { nova, situacao: sit, ml_status: e.mlStatus || null, ml_substatus: e.mlSubstatus || null });
          }
          const perm = Trav.classificar(msg);
          return falha(perm ? 'ml_recusou' : 'ml_erro', perm ? 'o ML RECUSOU a nota nova: ' + perm.motivo : 'o ML não aceitou o XML agora — pode ser passageiro; chame de novo em alguns minutos', { nova, situacao: sit, do_ml: msg });
        }
        feito.push('mandou_xml_ao_ml');
        const anotou = anotar({ no_ml_em: new Date().toISOString() });
        /* aceita pelo ML: a nota recusada dessa venda sai do aviso do checkout (o mesmo que a rotina F3 faz) */
        let saiuDoAviso = null; try { saiuDoAviso = Trav.resolverPorPedido(dir, pedidoML, nova.id); } catch (e) { saiuDoAviso = null; }
        return sai(true, { etapa: 'no_ml', nova, situacao: sit, pedido_ml: pedidoML, registro_gravado: anotou, saiu_do_aviso_do_checkout: saiuDoAviso,
          leia: 'A nota nova está autorizada e o ML ACEITOU o XML. A etiqueta do ML deve aparecer no checkout no próximo ciclo. A nota recusada (a antiga) NÃO foi tocada: cancelar ou devolver é a próxima etapa.' });
      }
      /* qualquer outra situação: diz, e não faz nada */
      const nome = SIT[sit] || ('situação ' + (sit == null ? '?' : sit));
      if (sit === 4) return falha('sefaz_rejeitou', 'a SEFAZ REJEITOU a nota nova — abra a nota ' + (nova.numero || nova.id) + ' no Bling pra ver o motivo', { nova, situacao: sit });
      if (sit === 2 || sit === 9 || sit === 11) return falha('nota_nova_sem_efeito', 'a nota nova está ' + nome + ' no Bling — não há o que emitir nem mandar ao ML', { nova, situacao: sit });
      if (sit === 3 || sit === 8 || sit === 10) return sai(true, { etapa: 'aguardando_sefaz', nova, situacao: sit, leia: 'A nota nova está em "' + nome + '" no Bling. Chame de novo em 1 ou 2 minutos.' });
      return falha('situacao_desconhecida', 'a nota nova está numa situação que esta rota não conhece (' + nome + ') — não fiz nada', { nova, situacao: sit });
    } catch (e) {
      return falha('erro', String((e && e.message) || e).slice(0, 160), { nova });
    } finally { _enviando.delete(nfId); }
  }

  return async function rotaNfConserto(req, res, urlObj, method, p) {
    if (!atende(prefixo, method, p)) return false;
    const k = lerChaveAdmin(req, urlObj);
    const sess = validarSessao(req.headers['cookie']);
    if (!((process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (sess && ehAdmin(sess)))) { json(res, 404, { error: 'not found' }); return true; }
    const ehCriar = p === caminhoDeCriar(prefixo), ehEnviar = p === caminhoDeEnviar(prefixo);
    const base = { empresa, ensaio: !ehCriar && !ehEnviar, escreveu_algo: false };
    const nfId = String((urlObj.searchParams && urlObj.searchParams.get('nf')) || '').trim();
    if (!/^\d{1,20}$/.test(nfId)) { json(res, 400, Object.assign({ ok: false, erro: 'use ?nf=<id da nota no Bling> (só dígitos) — é o número que aparece no endereço da página quando você abre a nota no Bling; opcional: &pedido=<nº da venda no ML>' }, base)); return true; }
    const pedParam = String((urlObj.searchParams && urlObj.searchParams.get('pedido')) || '').trim();
    if (pedParam && !/^\d{1,25}$/.test(pedParam)) { json(res, 400, Object.assign({ ok: false, erro: 'pedido: só dígitos (o nº da venda no ML)' }, base)); return true; }
    if (ehCriar) return criarNotaNova(res, urlObj, nfId, pedParam);
    if (ehEnviar) return enviarNotaNova(res, urlObj, nfId);
    const falha = (etapa, erro, mais) => { json(res, 200, Object.assign({ ok: false, etapa, erro }, mais || {}, base)); return true; };
    try {
      const L = await lerNotaEEnvio(nfId, pedParam);
      if (L.falha) return falha(L.falha[0], L.falha[1], L.falha[2]);
      const plano = C.semDadoDeGente(C.planejar(L.nf, L.envio, Date.now(), { pedidoML: L.pedidoML }));
      json(res, 200, Object.assign({}, plano, { nf: { id: nfId, numero: L.nf.numero || null }, pedido_ml: L.pedidoML, envio_achado_por: L.via,
        envio: { status: L.envio.status || null, substatus: L.envio.substatus || null, campos: Object.keys(L.envio).sort() },
        leia: LEIA_ENSAIO }, base));
      return true;
    } catch (e) { return falha('erro', String((e && e.message) || e).slice(0, 160)); }
  };
}

module.exports = { criar, atende, caminhoDe, caminhoDeCriar, caminhoDeEnviar };
