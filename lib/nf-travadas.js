'use strict';

/**
 * lib/nf-travadas.js — NFs que o marketplace recusa e SÓ MÃO HUMANA resolve (04/09).
 *
 * O caso que motivou: o Bling importa o CEP errado de uma venda do ML, a NF sai com esse
 * CEP, e o ML recusa o envio com "NFe receiver zipcode must be the same as the sale". O
 * conserto é manual e trabalhoso — o dono precisa cancelar a NF, emitir outra e subir o XML
 * à mão no ML.
 *
 * A rotina F3 não sabia disso e retransmitia a cada 10 minutos, para sempre: nos logs de
 * 04/09 a mesma NF 126595 aparece de 04:22 a 08:31, dezenas de tentativas idênticas. Nunca
 * ia passar, e ninguém ficava sabendo — o erro só existia no log.
 *
 * Esta lista guarda essas NFs pra: (1) a F3 parar de tentar, e (2) o checkout mostrar quais
 * precisam de intervenção. Multi-empresa: o arquivo fica no cache de cada uma.
 */

const fs = require('fs');
const path = require('path');

/* Erros que NUNCA passam sozinhos — dado o mesmo pedido e a mesma NF, tentar de novo dá o
   mesmo resultado. Só entram aqui os que exigem AÇÃO no Bling/marketplace. */
const PERMANENTES = [
  { re: /wrong_receiver_zipcode|zipcode must be the same/i, motivo: 'CEP da NF diferente do CEP da venda no ML',
    comoResolver: 'o Bling importou o CEP errado do pedido. Cancele a NF, corrija o endereço e emita outra no Bling -- a nota nova vai SOZINHA pro ML (em até ~10 min) e este aviso some quando o ML aceitar.' },
  { re: /invalid_cnpj|cnpj.*inv[áa]lid/i, motivo: 'CNPJ/CPF do destinatário inválido',
    comoResolver: 'corrija o documento do cliente no Bling, cancele e reemita a NF -- a nota nova vai sozinha pro ML e este aviso some quando ele aceitar.' },
  { re: /invalid_document|documento.*inv[áa]lid/i, motivo: 'documento do destinatário inválido',
    comoResolver: 'corrija o documento no Bling, cancele e reemita a NF -- a nota nova vai sozinha pro ML e este aviso some quando ele aceitar.' },
];

function classificar(msg) {
  const t = String(msg || '');
  for (const p of PERMANENTES) if (p.re.test(t)) return p;
  return null;
}

function arquivo(cacheDir) { return path.join(cacheDir, '_nf_travadas.json'); }

function ler(cacheDir) {
  try { return JSON.parse(fs.readFileSync(arquivo(cacheDir), 'utf8')); } catch (e) { return {}; }
}

/** Registra uma NF travada. Devolve true se é NOVA (pra avisar só uma vez). */
function registrar(cacheDir, dados) {
  const p = classificar(dados.erro);
  if (!p) return { permanente: false };
  const todas = ler(cacheDir);
  const chave = String(dados.nfeId || dados.numero);
  const nova = !todas[chave];
  todas[chave] = {
    nfe_id: dados.nfeId || null, numero: dados.numero || null,
    pedido_ml: dados.pedidoML || null, shipment: dados.shipment || null,
    motivo: p.motivo, como_resolver: p.comoResolver,
    erro_do_ml: String(dados.erro || '').slice(0, 300),
    desde: (todas[chave] && todas[chave].desde) || new Date().toISOString(),
    tentativas: ((todas[chave] && todas[chave].tentativas) || 0) + 1,
    ultima: new Date().toISOString(),
  };
  /* 17/10 (Codex #707): diz se GRAVOU — quem chama só pode largar a nota (marcar processada / tirar da lista de espera)
     se o registro que o operador vai ver no checkout existe de fato */
  let gravou = false;
  try { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(arquivo(cacheDir), JSON.stringify(todas, null, 2)); gravou = true; } catch (e) {}
  return { permanente: true, nova, registro: todas[chave], gravou };
}

/** Já está travada? A F3 usa isso pra nem tentar. */
function estaTravada(cacheDir, nfeId) {
  return !!ler(cacheDir)[String(nfeId)];
}

/** 04/11 -- SOME SOZINHA quando o problema foi resolvido. O dono cancela a NF travada, corrige o endereço e emite OUTRA no
    Bling; a rotina F3 manda essa nota nova ao ML (ela tem outro id, não está na lista) e, se o ML aceitar, as travadas
    do MESMO pedido do ML saem daqui -- antes o aviso ficava no checkout pra sempre, mesmo com tudo resolvido.
    Devolve quantas saíram. `exceto` = o id da nota que acabou de ser aceita (nunca é tirada por engano). */
function resolverPorPedido(cacheDir, pedidoML, exceto) {
  const ped = String(pedidoML || '').trim();
  if (!ped) return 0;
  const todas = ler(cacheDir);
  let n = 0;
  for (const k of Object.keys(todas)) {
    const t = todas[k] || {};
    if (String(t.pedido_ml || '') === ped && String(t.nfe_id || k) !== String(exceto || '')) { delete todas[k]; n++; }
  }
  if (!n) return 0;
  try { require('./escrita-atomica').gravarAtomico(arquivo(cacheDir), JSON.stringify(todas, null, 2)); } catch (e) { return 0; }
  return n;
}
/** Some da lista -- o dono resolveu (cancelou e reemitiu). */
function resolver(cacheDir, nfeId) {
  const todas = ler(cacheDir);
  if (!todas[String(nfeId)]) return false;
  delete todas[String(nfeId)];
  try { fs.writeFileSync(arquivo(cacheDir), JSON.stringify(todas, null, 2)); } catch (e) {}
  return true;
}

function lista(cacheDir) {
  return Object.values(ler(cacheDir)).sort((a, b) => String(b.ultima).localeCompare(String(a.ultima)));
}

/** 08/11 -- O PEDIDO JÁ FOI EMBORA? Caso real (NF 130031, Girassol): o pedido saiu do galpão e o aviso continuou no
    checkout, porque as saídas automáticas dependiam de o ciclo VER o pedido com a etiqueta do ML (e etiqueta anexada à
    mão não vale como prova — Codex #798). Aqui a pergunta vai direto ao ML: o envio do pedido está enviado, entregue,
    não entregue ou cancelado? Então a NF travada não tem mais o que resolver — sai do aviso.
    `perguntar(pedidoML, shipmentGuardado)` devolve { status } do envio, ou lança quando não tem certeza (sem token, 429,
    timeout...) — "não sei" NUNCA tira do aviso: só a resposta conclusiva do ML. Cada pedido é perguntado no máximo uma
    vez a cada `intervaloMs` (padrão 30 min) depois de uma resposta; erro tenta de novo na próxima rodada.
    Devolve { conferidos, resolvidas, detalhes: [{ pedido_ml, status, saiu }] }. */
const STATUS_JA_FOI = new Set(['shipped', 'delivered', 'not_delivered', 'cancelled']);
/* Codex #810: espera com PRAZO — se a promessa não volta a tempo, quem espera segue (lança "sem resposta"); a operação de
   baixo NÃO é cancelada (ex.: a renovação do token do ML, que não pode ser abortada no meio), só deixa de segurar o ciclo. */
function comPrazo(promessa, ms, motivo) {
  let tm = null;
  const limite = new Promise((_, rej) => { tm = setTimeout(() => rej(new Error(motivo || ('sem resposta em ' + Math.round(ms / 1000) + 's'))), ms); });
  return Promise.race([Promise.resolve(promessa), limite]).finally(() => clearTimeout(tm));
}
async function conferirEnvios(cacheDir, perguntar, opcoes) {
  const intervalo = (opcoes && opcoes.intervaloMs) || 30 * 60 * 1000;
  const agora = (opcoes && opcoes.agora) || Date.now();
  /* Codex #810: teto da rodada inteira (relógio de verdade) — passou, os pedidos que faltam ficam pra próxima rodada */
  const prazoTotal = (opcoes && opcoes.prazoTotalMs) || 60000;
  const inicio = Date.now();
  const porPedido = new Map();
  for (const t of Object.values(ler(cacheDir))) {
    const ped = String((t && t.pedido_ml) || '').trim();
    if (!ped) continue;
    if (!porPedido.has(ped)) porPedido.set(ped, []);
    porPedido.get(ped).push(t);
  }
  let conferidos = 0, resolvidas = 0;
  const detalhes = [];
  /* Codex #810 (r2): RODÍZIO — quem foi tentado há mais tempo (ou nunca) vai primeiro. Cada tentativa, com resposta ou
     não, anota `envio_tentado_em`; sem isso, os primeiros pedidos que estouram o prazo comiam o teto de toda rodada e
     os de trás (talvez já entregues) nunca eram perguntados. */
  const _tentado = (regs) => Math.min(...regs.map((r) => Date.parse(r.envio_tentado_em || '') || 0));
  const fila = [...porPedido].sort((a, b) => _tentado(a[1]) - _tentado(b[1]));
  const _anotar = (ped, campos) => {
    const todas = ler(cacheDir); let mexeu = false;
    for (const k of Object.keys(todas)) { if (String((todas[k] && todas[k].pedido_ml) || '') !== ped) continue; Object.assign(todas[k], campos); mexeu = true; }
    if (mexeu) { try { require('./escrita-atomica').gravarAtomico(arquivo(cacheDir), JSON.stringify(todas, null, 2)); } catch (e) {} }
  };
  for (const [ped, regs] of fila) {
    if (Date.now() - inicio > prazoTotal) break;
    const ult = Math.max(0, ...regs.map((r) => Date.parse(r.envio_conferido_em || '') || 0));
    if (agora - ult < intervalo) continue;
    let st = null;
    try {
      const r = await perguntar(ped, (regs.find((x) => x.shipment) || {}).shipment || null);
      st = r && r.status ? String(r.status) : null;
    } catch (e) { st = null; }
    if (!st) { _anotar(ped, { envio_tentado_em: new Date(Date.now()).toISOString() }); continue; }   /* não sei: fica, vai pro fim da fila e pergunta de novo na próxima rodada */
    conferidos++;
    if (STATUS_JA_FOI.has(st)) {
      const n = resolverPorPedido(cacheDir, ped);
      resolvidas += n;
      detalhes.push({ pedido_ml: ped, status: st, saiu: n });
      continue;
    }
    /* ainda não saiu: anota a conferência (relida agora — não apaga o que outra rotina gravou no meio) */
    _anotar(ped, { envio_conferido_em: new Date(agora).toISOString(), envio_status: st, envio_tentado_em: new Date(Date.now()).toISOString() });
    detalhes.push({ pedido_ml: ped, status: st, saiu: 0 });
  }
  return { conferidos, resolvidas, detalhes };
}

module.exports = { classificar, registrar, estaTravada, resolver, resolverPorPedido, conferirEnvios, comPrazo, lista, PERMANENTES };
