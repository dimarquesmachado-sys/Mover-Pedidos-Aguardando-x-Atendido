'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   CONSERTO DA NF QUE O MERCADO LIVRE RECUSA POR ENDEREÇO — 1ª etapa: O ENSAIO (18/11/2026).

   O caso (lib/nf-travadas): o Bling importa o CEP errado de uma venda do ML, a nota sai com esse CEP e o ML recusa
   ("NFe receiver zipcode must be the same as the sale"). O conserto, hoje, é o dono à mão — nas palavras dele:
   "apenas clono a NF, edito manualmente copiando os dados de endereço q pego dentro do pedido no MLivre, aí colo campo por
   campo na nova NF no Bling, salvo, e clico pra enviar NF, a Sefaz então autoriza, daí eu clico pra baixar o XML, extraio
   do Zip no meu computador, e daí, vou no Mlivre, dentro do pedido em INFORMAR NF JÁ EMITIDA, e lá eu anexo o XML".
   E a nota errada: cancela; "se passar de 24h da emissão da NF, aí sim, gera a NF devolução".

   O pedido dele: automatizar isso. Esta peça é o primeiro passo e NÃO ESCREVE NADA — nem no Bling, nem no ML:
     · lê a nota no Bling e o endereço de entrega da venda no ML;
     · compara campo a campo (endereço, número, complemento, bairro, cidade, UF, CEP);
     · diz o que seria feito com a nota errada (cancelar, se emitida há menos de 24 h; devolução, depois disso);
     · monta a nota nova que seria criada (a mesma nota, com o endereço da venda) e confere se tem o que precisa.
   Serve pra provar, com um caso real, que os dados dos dois lados são os que o conserto supõe — antes de qualquer rotina
   criar, cancelar ou devolver nota. Multiempresa: nada aqui é de uma empresa.

   A resposta do ensaio NÃO leva dado de gente (nome, documento, rua, número, CEP): por campo, só se é igual ou diferente.
   ───────────────────────────────────────────────────────────────────────────── */

const CAMPOS = ['endereco', 'numero', 'complemento', 'bairro', 'municipio', 'uf', 'cep'];
const HORAS_PRA_CANCELAR = 24;   /* regra do dono: até 24 h da emissão cancela; depois, nota de devolução */
/* o que identifica a nota que já existe — a nota nova nasce sem nada disso (o Bling numera, a SEFAZ autoriza) */
const SO_DA_NOTA_ANTIGA = ['id', 'numero', 'chaveAcesso', 'xml', 'linkDanfe', 'linkPDF', 'situacao', 'dataEmissao', 'dataOperacao'];

const txt = (v) => (v == null ? '' : String(v));

/* onde o envio do ML traz o endereço de entrega: `receiver_address` (o que lib/importar-pedido-ml lê) ou, no formato novo
   do envio (`x-format-new`), `destination.shipping_address` — os mesmos nomes de campo nos dois. O ensaio diz qual veio. */
function fonteDoEnderecoML(envio) {
  if (envio && envio.receiver_address && typeof envio.receiver_address === 'object') return 'receiver_address';
  if (envio && envio.destination && envio.destination.shipping_address && typeof envio.destination.shipping_address === 'object') return 'destination.shipping_address';
  return null;
}
function enderecoDoML(envio) {
  const fonte = fonteDoEnderecoML(envio);
  const r = fonte === 'receiver_address' ? envio.receiver_address : (fonte ? envio.destination.shipping_address : null);
  if (!r) return null;
  return {
    endereco: txt(r.street_name || r.address_line).trim(),
    numero: txt(r.street_number || r.number || 'SN').trim(),
    complemento: txt(r.comment).trim(),
    bairro: txt((r.neighborhood && r.neighborhood.name) || (typeof r.neighborhood === 'string' ? r.neighborhood : '')).trim(),
    municipio: txt((r.city && r.city.name) || (typeof r.city === 'string' ? r.city : '')).trim(),
    uf: txt((r.state && (r.state.id || r.state.name)) || '').replace(/^BR-/i, '').trim().toUpperCase(),
    cep: txt(r.zip_code).replace(/\D/g, ''),
  };
}

/* o endereço do destinatário na nota do Bling (`contato.endereco`, o mesmo que o Corrigir-NFs altera) */
function enderecoDaNota(nf) {
  const e = nf && nf.contato && nf.contato.endereco;
  if (!e || typeof e !== 'object') return null;
  return {
    endereco: txt(e.endereco).trim(), numero: txt(e.numero).trim(), complemento: txt(e.complemento).trim(),
    bairro: txt(e.bairro).trim(), municipio: txt(e.municipio).trim(), uf: txt(e.uf).trim().toUpperCase(), cep: txt(e.cep).replace(/\D/g, ''),
  };
}

/* comparação que não tropeça em acento, caixa e espaço — CEP só os dígitos */
function normal(campo, v) {
  if (campo === 'cep') return txt(v).replace(/\D/g, '');
  return txt(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function comparar(daNota, doML) {
  return CAMPOS.map((campo) => ({ campo, igual: normal(campo, daNota && daNota[campo]) === normal(campo, doML && doML[campo]),
    na_nota: !!normal(campo, daNota && daNota[campo]), no_ml: !!normal(campo, doML && doML[campo]) }));
}

/* há quantas horas a nota foi emitida — null quando a data não dá pra ler (não sei ≠ passou do prazo) */
function horasDesde(dataEmissao, agora) {
  /* o Bling manda a data no horário de Brasília SEM fuso ("2026-11-18 09:00:00"); o servidor roda em UTC — sem dizer o
     fuso, a nota pareceria 3 h mais nova e o prazo de cancelar esticaria pra 27 h */
  let d = txt(dataEmissao).trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) d += 'T00:00:00';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(d)) d += '-03:00';
  const t = Date.parse(d);
  if (!isFinite(t)) return null;
  return ((agora || Date.now()) - t) / 3600000;   /* SEM arredondar: 23h59 arredondado vira 24 h e a nota perderia o cancelamento */
}

/* a nota nova: a MESMA nota (itens, natureza, transporte, cliente), sem o que é da antiga e com o endereço da venda */
function montarNotaNova(nf, doML) {
  const nova = JSON.parse(JSON.stringify(nf || {}));
  for (const k of SO_DA_NOTA_ANTIGA) delete nova[k];
  nova.contato = nova.contato || {};
  nova.contato.endereco = Object.assign({}, nova.contato.endereco || {}, {
    endereco: doML.endereco, numero: doML.numero, complemento: doML.complemento, bairro: doML.bairro,
    municipio: doML.municipio, uf: doML.uf, cep: doML.cep,
  });
  return nova;
}

/* o plano do conserto de UMA nota — só decide e descreve; quem chama não escreve nada com isto ainda */
function planejar(nf, envio, agora) {
  const pend = [];
  if (!nf || typeof nf !== 'object') return { ok: false, pronta: false, pendencias: ['a nota não veio do Bling'] };
  const daNota = enderecoDaNota(nf), doML = enderecoDoML(envio);
  if (!daNota) pend.push('a nota não traz o endereço do destinatário (contato.endereco)');
  if (!doML) pend.push('o envio do ML não traz o endereço de entrega (nem receiver_address, nem destination.shipping_address)');
  const sit = Number(nf.situacao && typeof nf.situacao === 'object' ? nf.situacao.valor : nf.situacao);
  const horas = horasDesde(nf.dataEmissao || nf.dataOperacao, agora);
  if (horas == null) pend.push('não deu pra ler a data de emissão da nota — sem ela não se sabe se ainda cancela');
  if (doML) {
    if (doML.cep.length !== 8) pend.push('o CEP da venda no ML não tem 8 dígitos');
    for (const c of ['endereco', 'municipio', 'uf']) if (!doML[c]) pend.push('o endereço da venda no ML veio sem ' + c);
  }
  const campos = (daNota && doML) ? comparar(daNota, doML) : [];
  const diferentes = campos.filter((c) => !c.igual).map((c) => c.campo);
  if (daNota && doML && !diferentes.length) pend.push('o endereço da nota já é o da venda no ML — não há o que consertar por endereço');
  const itens = Array.isArray(nf.itens) ? nf.itens.length : 0;
  if (!itens) pend.push('a nota veio sem itens — não dá pra montar a nova');
  if (sit !== 5 && sit !== 6 && sit !== 7) pend.push('a nota não está autorizada (situação ' + (isFinite(sit) ? sit : '?') + ') — cancelar ou devolver só vale pra nota autorizada');
  const notaNova = (doML && itens) ? montarNotaNova(nf, doML) : null;
  return {
    ok: true, pronta: pend.length === 0, pendencias: pend,
    nota: { situacao: isFinite(sit) ? sit : null, horas_desde_a_emissao: horas == null ? null : Math.round(horas * 10) / 10, itens },
    /* a regra do dono: cancela até 24 h; depois, devolução. Sem a data, não decide. */
    nota_errada: horas == null ? null : (horas < HORAS_PRA_CANCELAR ? 'cancelar' : 'devolucao'),
    campos, diferentes, fonte_do_endereco_no_ml: fonteDoEnderecoML(envio),
    nota_nova: notaNova,
  };
}

/* o que do plano pode sair numa resposta de rota: nada de nome, documento, rua, número ou CEP — só a forma */
function semDadoDeGente(plano) {
  if (!plano || !plano.ok) return plano;
  const n = plano.nota_nova;
  return {
    ok: true, pronta: plano.pronta, pendencias: plano.pendencias, nota: plano.nota, nota_errada: plano.nota_errada,
    campos: plano.campos, diferentes: plano.diferentes, fonte_do_endereco_no_ml: plano.fonte_do_endereco_no_ml,
    nota_nova: n ? { montada: true, campos_do_topo: Object.keys(n).sort(), itens: Array.isArray(n.itens) ? n.itens.length : 0,
      tem_natureza: !!(n.naturezaOperacao && n.naturezaOperacao.id), tem_contato: !!(n.contato && (n.contato.id || n.contato.nome)),
      sem_o_que_e_da_antiga: SO_DA_NOTA_ANTIGA.every((k) => !(k in n)) } : { montada: false },
  };
}

module.exports = { CAMPOS, HORAS_PRA_CANCELAR, fonteDoEnderecoML, enderecoDoML, enderecoDaNota, comparar, horasDesde, montarNotaNova, planejar, semDadoDeGente };
