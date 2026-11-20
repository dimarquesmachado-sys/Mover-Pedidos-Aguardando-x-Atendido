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
const SO_DA_NOTA_ANTIGA = ['id', 'numero', 'chaveAcesso', 'xml', 'linkDanfe', 'linkPDF', 'situacao'];   /* as datas não saem: são TROCADAS pela hora da criação (montarNotaNova) */
/* o que a API do Bling devolve ao LER a nota e não aceita ao CRIAR (referência oficial da API v3) */
const SO_NA_LEITURA = ['serie', 'valorNota', 'valorFrete', 'optanteSimplesNacional', 'numeroPedidoLoja', 'vendedor'];

/* estados do envio no ML em que a venda não pede mais nota (os mesmos de lib/nf-travadas e da rotina F3) */
const ENVIO_ENCERRADO = ['shipped', 'delivered', 'not_delivered', 'cancelled'];

const txt = (v) => (v == null ? '' : String(v));
const ate60 = (v) => txt(v).trim().slice(0, 60).trim();

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
    /* 19/11: a NF-e aceita no máximo 60 caracteres em logradouro, número, complemento e bairro; a referência que o
       comprador escreve no ML ("comment") passa disso com facilidade. Corta aqui, na leitura — assim o que vai pra nota e
       o que se compara depois com a nota criada são o MESMO texto. */
    endereco: ate60(r.street_name || r.address_line),
    numero: ate60(r.street_number || r.number || 'SN'),
    complemento: ate60(r.comment),
    bairro: ate60((r.neighborhood && r.neighborhood.name) || (typeof r.neighborhood === 'string' ? r.neighborhood : '')),
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

/* 19/11 — o endereço de ENTREGA na nota (`transporte.etiqueta`): o 1º ensaio com caso real (NF 130772 da Girassol) mostrou
   o CEP VAZIO em `contato.endereco` — a nota pode levar o endereço em outro lugar. O ensaio compara os dois com a venda. */
function enderecoDaEtiqueta(nf) {
  const e = nf && nf.transporte && nf.transporte.etiqueta;
  if (!e || typeof e !== 'object') return null;
  return {
    endereco: txt(e.endereco).trim(), numero: txt(e.numero).trim(), complemento: txt(e.complemento).trim(),
    bairro: txt(e.bairro).trim(), municipio: txt(e.municipio).trim(), uf: txt(e.uf).trim().toUpperCase(), cep: txt(e.cep).replace(/\D/g, ''),
  };
}
/* as chaves que um pedaço da nota traz, e quais vieram preenchidas — a FORMA, sem o valor (não é dado de gente) */
function formaDe(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const o = {};
  for (const k of Object.keys(obj).sort()) { const v = obj[k]; o[k] = (v && typeof v === 'object') ? 'objeto' : (txt(v).trim() ? 'preenchido' : 'vazio'); }
  return o;
}

/* comparação que não tropeça em acento, caixa e espaço — CEP só os dígitos */
function normal(campo, v) {
  if (campo === 'cep') return txt(v).replace(/\D/g, '');
  return txt(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function comparar(daNota, doML) {
  return CAMPOS.map((campo) => {
    const a = normal(campo, daNota && daNota[campo]), b = normal(campo, doML && doML[campo]);
    /* 19/11: a forma da diferença, sem o valor — tamanho de cada lado e se um contém o outro ("Rua X" × "Rua X 10" é o
       número colado na rua, não outro endereço). Diz se a diferença é de FORMATO ou de endereço mesmo. */
    return { campo, igual: a === b, na_nota: !!a, no_ml: !!b, tam_nota: a.length, tam_ml: b.length, um_contem_o_outro: !!(a && b && a !== b && (a.includes(b) || b.includes(a))) };
  });
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

/* valor que o Bling guardou mascarado ("XXXXXXX", "Xxxxxxx") ou vazio — não é dado, é a falta dele */
function mascarado(v) { const t = txt(v).trim(); return !t || /^x+$/i.test(t); }

/* o nome de quem recebe, no envio do ML. Onde ele pode estar (Codex #954: os mesmos lugares que lib/importar-pedido-ml
   lê, mais o formato novo): no topo do envio, dentro de `receiver_address`, em `destination` ou no endereço de
   `destination`. O primeiro que for nome de verdade — máscara não conta. */
function nomeDoRecebedorNoML(envio) {
  if (!envio || typeof envio !== 'object') return '';
  const ra = envio.receiver_address && typeof envio.receiver_address === 'object' ? envio.receiver_address : {};
  const d = envio.destination && typeof envio.destination === 'object' ? envio.destination : {};
  const sa = d.shipping_address && typeof d.shipping_address === 'object' ? d.shipping_address : {};
  return [envio.receiver_name, ra.receiver_name, d.receiver_name, sa.receiver_name].map((v) => txt(v).trim()).find((v) => !mascarado(v)) || '';
}

/* a hora no formato do Bling: horário de Brasília, sem fuso ("2026-11-19 12:46:05") — o inverso do que `horasDesde` lê */
function agoraNoBling(agora) {
  return new Date((agora || Date.now()) - 3 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
}

/* a nota nova: a MESMA nota (itens, natureza, transporte, cliente), sem o que é da antiga e com o endereço da venda.
   19/11: e sem o que a API do Bling só DEVOLVE na leitura e não aceita na criação (referência oficial da API v3: série,
   valor da nota, valor do frete, optante do Simples, nº do pedido na loja e vendedor não existem no corpo de criar nota) —
   o frete vai em `transporte.frete`; o endereço da venda entra nos DOIS lugares da nota (destinatário e etiqueta). */
function montarNotaNova(nf, doML, agora, extra) {
  const nova = JSON.parse(JSON.stringify(nf || {}));
  for (const k of SO_DA_NOTA_ANTIGA) delete nova[k];
  /* 19/11 (1ª criação de verdade, NF 130772): sem a data o Bling recusa — "Data de operação inválida" (na referência da
     API, `dataOperacao` é obrigatória ao criar). A nota nova sai AGORA: emissão e operação com a hora da criação — nunca
     as datas da nota antiga. */
  nova.dataEmissao = nova.dataOperacao = agoraNoBling(agora);
  for (const k of SO_NA_LEITURA) delete nova[k];
  const end = { endereco: doML.endereco, numero: doML.numero, complemento: doML.complemento, bairro: doML.bairro, municipio: doML.municipio, uf: doML.uf, cep: doML.cep };
  nova.contato = nova.contato || {};
  nova.contato.endereco = Object.assign({}, nova.contato.endereco || {}, end);
  if (nova.transporte && typeof nova.transporte === 'object') {
    if (nova.transporte.etiqueta && typeof nova.transporte.etiqueta === 'object') nova.transporte.etiqueta = Object.assign({}, nova.transporte.etiqueta, end);
    if (nova.transporte.frete == null && isFinite(Number(nf && nf.valorFrete)) && nf.valorFrete != null) nova.transporte.frete = Number(nf.valorFrete);
    /* 20/11 (1º conserto de verdade, GOOD, NF 082108 → 082183, conferido pelo dono na tela do Bling): a nota nova saiu com
       "Dados do volume: Quantidade 0" — a antiga tinha 2. A leitura da API não devolve a quantidade de volumes (só os
       objetos de postagem), então a cópia não a leva; nas duas notas conferidas (1 un → 1 volume; 2 un → 2 volumes) ela é
       a soma das quantidades dos itens, que é o que o Bling preenche sozinho numa nota de venda. Só entra quando a nota
       não traz a quantidade e a soma é um inteiro positivo — "não sei" não vira número. */
    const jaTem = nova.transporte.volume && typeof nova.transporte.volume === 'object' && Number(nova.transporte.volume.quantidade) > 0;
    /* cada item precisa trazer quantidade presente e inteira positiva (null, "", booleano, 0,5 ou texto não valem) — checar
       só a soma deixaria 0,5 + 0,5 virar 1 volume e [1, null] virar 1 */
    const itens = Array.isArray(nova.itens) ? nova.itens : [];
    const qtdOk = (i) => { const v = i && i.quantidade; return (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isInteger(Number(v)) && Number(v) > 0; };
    const soma = itens.length && itens.every(qtdOk) ? itens.reduce((t, i) => t + Number(i.quantidade), 0) : 0;
    if (!jaTem && Number.isInteger(soma) && soma > 0) nova.transporte.volume = Object.assign({}, nova.transporte.volume && typeof nova.transporte.volume === 'object' ? nova.transporte.volume : {}, { quantidade: soma });
    /* 19/11 (a 1ª nota criada, conferida pelo dono na tela do Bling): o NOME do endereço de entrega saiu "XXXXXXX" — o
       Bling importou a venda com os dados mascarados e a nota antiga guardou a máscara. Nome mascarado (ou vazio) vira o
       do recebedor no ML; sem ele, o do destinatário da nota. Nome de verdade não é trocado. */
    const et = nova.transporte.etiqueta;
    if (et && typeof et === 'object' && mascarado(et.nome)) {
      const nome = [extra && extra.nomeNoML, nova.contato.nome].map((v) => txt(v).trim()).find((v) => !mascarado(v));
      if (nome) et.nome = nome;
    }
  }
  /* 19/11 (mesma conferência): a nota criada pela API nasceu SEM o "Número loja virtual" — o Bling devolve o nº da venda
     em `numeroPedidoLoja` (só leitura) e aceita em `loja.numero`. Sem ele a nota fica solta da venda no Bling, e a rotina
     F3 (que acha a venda por esse número) não a reconhece. */
  const pedido = txt((extra && extra.pedidoML) || (nf && nf.numeroPedidoLoja)).trim();
  if (/^\d{1,25}$/.test(pedido) && nova.loja && typeof nova.loja === 'object' && nova.loja.id) nova.loja = Object.assign({}, nova.loja, { numero: pedido });
  return nova;
}

/* o plano do conserto de UMA nota — só decide e descreve; quem chama não escreve nada com isto ainda */
function planejar(nf, envio, agora, opcoes) {
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
  const daEtiq = enderecoDaEtiqueta(nf);
  const camposEtiq = (daEtiq && doML) ? comparar(daEtiq, doML) : [];
  const diferentesEtiq = camposEtiq.filter((c) => !c.igual).map((c) => c.campo);
  if (daNota && doML && !diferentes.length && !diferentesEtiq.length) pend.push('o endereço da nota já é o da venda no ML — não há o que consertar por endereço');
  const itens = Array.isArray(nf.itens) ? nf.itens.length : 0;
  if (!itens) pend.push('a nota veio sem itens — não dá pra montar a nova');
  /* 19/11: a venda que já saiu (ou foi cancelada) não pede mais nota — uma nota nova não teria pra onde ir. Só quem
     chama de propósito (o teste de criação pedido pelo dono) passa por cima, e isso fica dito no plano. */
  const stEnvio = txt(envio && envio.status).trim().toLowerCase();
  const jaFoi = ENVIO_ENCERRADO.includes(stEnvio);
  if (jaFoi && !(opcoes && opcoes.aceitaEnvioEncerrado)) pend.push('o envio da venda no ML já está "' + stEnvio + '" — o ML não pede mais nota pra essa venda');
  if (sit !== 5 && sit !== 6 && sit !== 7) pend.push('a nota não está autorizada (situação ' + (isFinite(sit) ? sit : '?') + ') — cancelar ou devolver só vale pra nota autorizada');
  const notaNova = (doML && itens) ? montarNotaNova(nf, doML, agora, { pedidoML: opcoes && opcoes.pedidoML, nomeNoML: nomeDoRecebedorNoML(envio) }) : null;
  return {
    ok: true, pronta: pend.length === 0, pendencias: pend,
    nota: { situacao: isFinite(sit) ? sit : null, horas_desde_a_emissao: horas == null ? null : Math.round(horas * 10) / 10, itens },
    /* a regra do dono: cancela até 24 h; depois, devolução. Sem a data, não decide. */
    nota_errada: horas == null ? null : (horas < HORAS_PRA_CANCELAR ? 'cancelar' : 'devolucao'),
    campos, diferentes, fonte_do_endereco_no_ml: fonteDoEnderecoML(envio),
    envio_encerrado: jaFoi,
    etiqueta: daEtiq ? { campos: camposEtiq, diferentes: diferentesEtiq } : null,
    forma: { contato_endereco: formaDe(nf.contato && nf.contato.endereco), transporte: formaDe(nf.transporte), transporte_etiqueta: formaDe(nf.transporte && nf.transporte.etiqueta) },
    fica_de_fora_na_criacao: SO_NA_LEITURA.filter((k) => k in nf),
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
    envio_encerrado: plano.envio_encerrado,
    etiqueta: plano.etiqueta, forma: plano.forma, fica_de_fora_na_criacao: plano.fica_de_fora_na_criacao,
    nota_nova: n ? { montada: true, campos_do_topo: Object.keys(n).sort(), itens: Array.isArray(n.itens) ? n.itens.length : 0,
      tem_natureza: !!(n.naturezaOperacao && n.naturezaOperacao.id), tem_contato: !!(n.contato && (n.contato.id || n.contato.nome)),
      sem_o_que_e_da_antiga: SO_DA_NOTA_ANTIGA.every((k) => !(k in n)), tem_data_de_operacao: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(txt(n.dataOperacao)), sem_o_que_so_existe_na_leitura: SO_NA_LEITURA.every((k) => !(k in n)),
      /* 19/11: a nota leva o nº da venda (`loja.numero`)? e o nome da entrega, é nome ou é máscara? — só sim/não */
      loja_com_o_pedido_da_venda: !!(n.loja && txt(n.loja.numero).trim()), nome_da_entrega: !(n.transporte && n.transporte.etiqueta) ? 'sem_etiqueta' : (mascarado(n.transporte.etiqueta.nome) ? 'mascarado' : 'preenchido'),
      volumes: n.transporte && n.transporte.volume && Number(n.transporte.volume.quantidade) > 0 ? Number(n.transporte.volume.quantidade) : null,
      forma_do_transporte: formaDe(n.transporte), etiqueta_com_o_endereco_da_venda: !!(n.transporte && n.transporte.etiqueta && n.contato && n.contato.endereco && n.transporte.etiqueta.cep === n.contato.endereco.cep) } : { montada: false },
  };
}

/* 19/11 — texto que veio de fora (o erro do Bling ao recusar a nota) sem os valores da pessoa: tudo o que a nota traz de
   nome, documento, contato e endereço some do texto, e qualquer sequência de 5+ dígitos também (documento com outra
   pontuação, telefone, CEP). O que sobra é o que interessa pra consertar: QUAL campo o Bling recusou e por quê. */
function semValoresDe(texto, ...notas) {
  const valores = new Set();
  const pegar = (o) => { if (!o || typeof o !== 'object') return; for (const v of Object.values(o)) { if (v && typeof v === 'object') pegar(v); else { const t = txt(v).trim(); if (t.length >= 3) valores.add(t); } } };
  /* de TODAS as notas passadas: a antiga (o endereço errado) e a nova (o da venda) — o Bling ecoa o que recebeu */
  for (const nota of notas) { pegar(nota && nota.contato); pegar(nota && nota.transporte && nota.transporte.etiqueta); }
  let s = txt(texto);
  for (const v of [...valores].sort((a, b) => b.length - a.length)) s = s.split(new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')).join('•••');
  return s.replace(/\d[\d.\-/ ]{3,}\d/g, (m) => (m.replace(/\D/g, '').length >= 5 ? '#' : m));
}

/* Codex #951: "mesma quantidade de linhas" não é "mesmos itens" — produto, quantidade e valor unitário de cada linha,
   sem depender da ordem. true/false; null quando algum lado não traz código+quantidade+valor em toda linha (não sei). */
function itensIguais(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return null;
  const linha = (i) => {
    const cod = txt(i && i.codigo).trim().toLowerCase(), q = Number(i && i.quantidade), v = Number(i && i.valor);
    if (!cod || i.quantidade == null || i.valor == null || !isFinite(q) || !isFinite(v)) return null;
    return cod + '|' + q.toFixed(4) + '|' + v.toFixed(4);
  };
  const la = a.map(linha), lb = b.map(linha);
  if (la.includes(null) || lb.includes(null)) return null;
  if (la.length !== lb.length) return false;
  la.sort(); lb.sort();
  return la.every((x, n) => x === lb[n]);
}

/* 19/11 — a nota que o Bling acabou de criar, relida: está como a venda pede? Só sim/não e números que não são de gente. */
function conferirNotaCriada(criada, antiga, doML) {
  if (!criada || typeof criada !== 'object') return null;
  const sit = Number(criada.situacao && typeof criada.situacao === 'object' ? criada.situacao.valor : criada.situacao);
  const iguais = (e) => (e && doML ? comparar(e, doML).every((c) => c.igual) : null);
  const num = (v) => (v == null || v === '' || !isFinite(Number(v)) ? null : Number(v));
  return {
    situacao: isFinite(sit) ? sit : null,
    endereco_igual_ao_da_venda: iguais(enderecoDaNota(criada)),
    entrega_igual_ao_da_venda: iguais(enderecoDaEtiqueta(criada)),
    itens: Array.isArray(criada.itens) ? criada.itens.length : 0,
    itens_iguais_aos_da_antiga: itensIguais(criada.itens, antiga && antiga.itens),
    valor_igual_ao_da_antiga: num(criada.valorNota) == null || num(antiga && antiga.valorNota) == null ? null : Math.abs(num(criada.valorNota) - num(antiga.valorNota)) < 0.005,
    natureza_igual: !!(criada.naturezaOperacao && antiga && antiga.naturezaOperacao && String(criada.naturezaOperacao.id) === String(antiga.naturezaOperacao.id)),
    loja_igual: !!(criada.loja && antiga && antiga.loja && String(criada.loja.id) === String(antiga.loja.id)),
    /* a pergunta em aberto: a nota criada pela API guarda de qual venda da loja ela é? (a rotina F3 depende disso) */
    tem_o_pedido_da_loja: !!txt(criada.numeroPedidoLoja).trim(),
  };
}

module.exports = { mascarado, nomeDoRecebedorNoML, agoraNoBling, ENVIO_ENCERRADO, semValoresDe, conferirNotaCriada, itensIguais, CAMPOS, HORAS_PRA_CANCELAR, SO_NA_LEITURA, fonteDoEnderecoML, enderecoDoML, enderecoDaNota, enderecoDaEtiqueta, formaDe, comparar, horasDesde, montarNotaNova, planejar, semDadoDeGente };
