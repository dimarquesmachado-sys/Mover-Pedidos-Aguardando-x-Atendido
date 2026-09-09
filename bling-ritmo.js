'use strict';
/* PORTEIRO DE RITMO DO BLING — a cota é POR CONTA (CNPJ), não por app: 3 req/s e
   120k/dia valem pra conta INTEIRA (módulos daqui + app de NF-e + Expedição, todos
   somados). Incidentes que motivaram: 03/09 (backfill daqui esgotou a cota e derrubou
   a bipagem da Expedição) e 08/09 (a Expedição sozinha passou de 16/s). O porteiro
   dá permissão ANTES da chamada, com balde de fichas POR CONTA e duas classes:
   'operacao' (bipagem/despacho — o estoquista está com o pacote na mão) tem reserva
   garantida; 'fundo' (backfill, varredura, cron) pega o resto.

   CONTRATO (combinado com o app de Expedição) — auth pelo header
   x-ritmo-key: <BLING_RITMO_KEY> em TODAS as chamadas (credencial DEDICADA do
   porteiro, nunca a ADMIN_KEY geral; ?k= na URL leva 400 — Codex #356 r2/r3):
     POST /bling-ritmo/permissao?conta=girassol&prioridade=operacao|fundo
       → 200 {"ok":true}                          pode chamar AGORA
       → 200 {"ok":false,"esperar_ms":250}        aguarde e peça de novo
       → 200 {"ok":false,"pausa_s":120,"motivo"}  429 recente: pausa global da conta
     POST /bling-ritmo/aviso-429?conta=girassol&retry_after_s=60
       quem levou 429 avisa — TODOS recuam juntos (escada 15s→30s→1m→2m→5m,
       Retry-After do Bling tem precedência quando informado)
     POST /bling-ritmo/aviso-ok?conta=girassol
       sucesso real no Bling (de permissão POSTERIOR ao 429) libera e zera a escada
     GET  /bling-ritmo/estado?conta=girassol
       visibilidade: fichas do segundo/janela, pausa, degrau, usadas no dia

   FALHAR ABERTO é responsabilidade do CLIENTE: se esta rota não responder em ~1s,
   use o ritmo local e siga — o porteiro nunca pode ser ponto único de falha da
   operação. A pausa/escada persiste em arquivo (sobrevive a restart do processo;
   deploy zera — degradação aceitável: o próximo 429 re-ensina). */
const fs = require('fs');
const path = require('path');

/* Codex #356: taxa fracionária com contagem inteira arredondava pra CIMA (len<2.5
   admitia 3/s; len<0.5 admitia 1/s — o dobro do fundo e zero folga). A janela virou
   2s e os tetos, INTEIROS EXATOS: 5/2s = 2.5/s, reserva 4/2s = 2/s, fundo 1/2s. */
const JANELA_MS = 2000;
const TETO_JANELA = 5;             /* 2.5/s médios */
const TETO_FUNDO_JANELA = 1;       /* 0.5/s do FUNDO, contado à parte (uma operação por
                                      segundo não pode estrangular o fundo pra sempre) */
/* Codex #356 r2: média de 2.5/s em 2s ainda permitia 5 no MESMO segundo — o limite do
   Bling é instantâneo (3/s). Regra DUPLA: nunca mais que 3 em qualquer 1s deslizante,
   nunca mais que 5 em 2s. Burst máximo real: 3+2. */
const TETO_SEGUNDO = 3;
const ESCADA_PAUSA_S = [15, 30, 60, 120, 300];
/* Codex #356: 120k/dia também é da conta — sem checar, o porteiro deixava esgotar.
   Fundo barra antes (reserva diária pro fim do dia ser da operação). */
const TETO_DIA_OPERACAO = 110000;
const TETO_DIA_FUNDO = 100000;
/* Codex #356: o render.yaml monta disco persistente em /data — estado no diretório
   da aplicação morria no deploy, contrariando a promessa de sobreviver a restart. */
const DIR_ESTADO = process.env.BLING_RITMO_DIR || (fs.existsSync('/data') ? '/data' : __dirname);
/* Codex #356 r7: diretório configurado que não existe fazia todo _persistir morrer em
   ENOENT engolido — a configurabilidade prometida virava perda silenciosa no restart. */
try { fs.mkdirSync(DIR_ESTADO, { recursive: true }); } catch (e) { /* já existe ou sem permissão — o catch do _persistir cobre */ }
const ARQ = path.join(DIR_ESTADO, 'bling-ritmo-estado.json');

const _contas = new Map(); /* conta → { fichas: [ts...], pausaAte: 0, degrau: 0, dia: 'aaaammdd', usadasDia: 0 } */
const _agoraRef = { fn: () => Date.now() }; /* injetável no teste */

/* Codex #356 r5: ficha única ENTRE restarts — sem o prefixo de boot, o processo novo
   reemitiria 'f1' e um sucesso atrasado do processo anterior casaria com a permissão
   nova, derrotando a correlação exata. */
const _bootId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
let _serieFicha = 0;
function _conta(nome) {
  if (!_contas.has(nome)) _contas.set(nome, { fichas: [], pausaAte: 0, degrau: 0, dia: '', usadasDia: 0, fichasVivas: new Map() });
  const c = _contas.get(nome);
  if (!c.fichasVivas) c.fichasVivas = new Map();
  return c;
}

function _persistir() {
  try {
    const dump = {};
    for (const [k, v] of _contas) dump[k] = { pausaAte: v.pausaAte, degrau: v.degrau, dia: v.dia, usadasDia: v.usadasDia, ts429: v.ts429 || 0, tsUltimaPermissao: v.tsUltimaPermissao || 0 };
    /* Codex #356 r3: write atômico — morte no meio do writeFileSync truncava o arquivo
       e o restart 'sujo' recomeçava sem pausa nenhuma, exatamente quando mais importa. */
    fs.writeFileSync(ARQ + '.tmp', JSON.stringify(dump));
    fs.renameSync(ARQ + '.tmp', ARQ);
  } catch (e) { /* persistência é conveniência — nunca derruba o porteiro */ }
}
function _carregar() {
  try {
    if (!fs.existsSync(ARQ)) return;
    const dump = JSON.parse(fs.readFileSync(ARQ, 'utf8'));
    /* Codex #356 r5: as fichas da janela não sobrevivem ao restart, mas as chamadas
       pré-restart AINDA contam nas janelas do Bling — resfriamento de boot de uma
       janela (2s) por conta carregada elimina o burst combinado. */
    const boot = _agoraRef.fn();
    for (const [k, v] of Object.entries(dump)) _contas.set(k, { fichas: [], pausaAte: Math.max(v.pausaAte || 0, boot + JANELA_MS), degrau: v.degrau || 0, dia: v.dia || '', usadasDia: v.usadasDia || 0, ts429: v.ts429 || 0, tsUltimaPermissao: v.tsUltimaPermissao || 0, fichasVivas: new Map() });
  } catch (e) { /* arquivo corrompido: começa limpo */ }
}
_carregar();

function _diaDe(ts) { const d = new Date(ts); return d.toISOString().slice(0, 10); }

function permissao(conta, prioridade) {
  const c = _conta(conta);
  const agora = _agoraRef.fn();
  if (c.pausaAte > agora) {
    return { ok: false, pausa_s: Math.ceil((c.pausaAte - agora) / 1000), motivo: 'pausa global da conta (429 recente ou resfriamento de boot; degrau ' + c.degrau + ')' };
  }
  const dia = _diaDe(agora);
  if (c.dia !== dia) { c.dia = dia; c.usadasDia = 0; _persistir(); }
  const tetoDia = prioridade === 'operacao' ? TETO_DIA_OPERACAO : TETO_DIA_FUNDO;
  if (c.usadasDia >= tetoDia) {
    const meiaNoite = new Date(agora); meiaNoite.setUTCHours(24, 0, 0, 0);
    return { ok: false, pausa_s: Math.ceil((meiaNoite.getTime() - agora) / 1000), motivo: 'cota diária da conta (' + tetoDia + ') esgotada pra prioridade ' + prioridade };
  }
  c.fichas = c.fichas.filter(f => agora - f.ts < JANELA_MS);
  const noSegundo = c.fichas.filter(f => agora - f.ts < 1000);
  const doFundo = c.fichas.filter(f => f.pri === 'fundo');
  /* fundo tem cota PRÓPRIA (contada à parte — Codex #356 r2: comparar o fundo com as
     fichas totais deixava 1 operação a cada 2s estrangular o fundo indefinidamente),
     e AMBOS respeitam o teto instantâneo do segundo e o total da janela. */
  const cabeClasse = prioridade === 'operacao' ? c.fichas.length < TETO_JANELA : doFundo.length < TETO_FUNDO_JANELA;
  if (cabeClasse && noSegundo.length < TETO_SEGUNDO && c.fichas.length < TETO_JANELA) {
    c.fichas.push({ ts: agora, pri: prioridade });
    c.usadasDia++;
    c.tsUltimaPermissao = agora;
    /* Codex #356 r4: sucesso precisa CORRELACIONAR com a permissão que o gerou — o
       cheque só-por-timestamps da conta aceitava ok de pedido pré-429 lento chegando
       depois de uma permissão nova. A permissão emite FICHA; o aviso-ok a devolve. */
    const ficha = _bootId + '-' + (++_serieFicha);
    c.fichasVivas.set(ficha, agora);
    if (c.fichasVivas.size > 500) { const k1 = c.fichasVivas.keys().next().value; c.fichasVivas.delete(k1); }
    /* Codex #356 r4: usadasDia só persistia em 429/ok — restart no meio esquecia
       chamadas que o Bling contou; persistência com throttle (a cada 20). */
    if (c.usadasDia % 20 === 0) _persistir();
    return { ok: true, ficha };
  }
  const maisAntiga = noSegundo.length >= TETO_SEGUNDO ? (noSegundo[0].ts + 1000) : (c.fichas.length ? c.fichas[0].ts + JANELA_MS : agora + 200);
  return { ok: false, esperar_ms: Math.max(50, maisAntiga - agora) };
}

function aviso429(conta, retryAfterS) {
  const c = _conta(conta);
  const agora = _agoraRef.fn();
  const escada = ESCADA_PAUSA_S[Math.min(c.degrau, ESCADA_PAUSA_S.length - 1)];
  /* Codex #356 r4: Retry-After não-finito (Infinity/NaN de cliente bugado) travava a
     conta PRA SEMPRE (toda permissão negada, todo ok ignorado como durante-pausa).
     Só finito, com teto de 1h. */
  const ra = Number(retryAfterS);
  const pausaS = (Number.isFinite(ra) && ra > 0) ? Math.min(Math.max(ra, 5), 3600) : escada;
  c.degrau = Math.min(c.degrau + 1, ESCADA_PAUSA_S.length - 1);
  c.ts429 = agora;
  /* Codex #356: aviso posterior NUNCA encurta pausa ativa — um Retry-After de 300s
     seguido de um 429 sem header mantinha só o degrau curto e liberava cedo demais. */
  c.pausaAte = Math.max(c.pausaAte, agora + pausaS * 1000);
  _persistir();
  return { ok: true, pausa_s: Math.ceil((c.pausaAte - agora) / 1000), degrau: c.degrau };
}

function avisoOk(conta, ficha) {
  const c = _conta(conta);
  const agora = _agoraRef.fn();
  /* Codex #356 r4+r5: a correlação exata exige a FICHA — o caminho de compatibilidade
     sem ela mantinha vivo o furo do sucesso pré-429 atrasado, então morreu: aviso-ok
     sem ficha é ignorado com instrução. Só zera se a permissão DAQUELA ficha saiu
     depois do último 429. */
  if (!ficha) return { ok: true, ignorado: true, motivo: 'ficha obrigatória — mande a ficha devolvida pela permissão que teve o sucesso' };
  const tsFicha = c.fichasVivas.get(String(ficha));
  if (tsFicha === undefined) return { ok: true, ignorado: true, motivo: 'ficha desconhecida, expirada ou de processo anterior' };
  c.fichasVivas.delete(String(ficha));
  if (c.ts429 && tsFicha <= c.ts429) return { ok: true, ignorado: true, motivo: 'a permissão desta ficha é anterior ao último 429' };
  c.degrau = 0; c.pausaAte = 0;
  _persistir();
  return { ok: true };
  /* Codex #356 r2+r3: sucesso legítimo é o de permissão POSTERIOR ao último 429 —
     a checagem só-por-pausa deixava um pedido de 16s (permitido antes de uma pausa
     de 15s) chegar DEPOIS dela vencer e zerar a escada sem nenhum sucesso pós-429
     real. A âncora é o par de timestamps, não o relógio da pausa. */
  if (c.pausaAte > agora) return { ok: true, ignorado: true, motivo: 'pausa ativa — sucesso é de permissão anterior ao 429' };
}

function estado(conta) {
  const c = _conta(conta);
  const agora = _agoraRef.fn();
  return {
    ok: true, conta,
    fichas_na_janela: c.fichas.filter(f => agora - f.ts < JANELA_MS).length,
    fichas_no_segundo: c.fichas.filter(f => agora - f.ts < 1000).length,
    janela_ms: JANELA_MS, teto_janela: TETO_JANELA, teto_fundo_janela: TETO_FUNDO_JANELA,
    teto_dia_operacao: TETO_DIA_OPERACAO, teto_dia_fundo: TETO_DIA_FUNDO,
    pausa_s: c.pausaAte > agora ? Math.ceil((c.pausaAte - agora) / 1000) : 0,
    degrau: c.degrau, usadas_no_dia: c.usadasDia, dia: c.dia || null,
  };
}

/* Codex #356 r5+r6: a conta do balde é o ID CANÔNICO do contrato de empresas — 'amb'
   e 'ambtotal' são o MESMO CNPJ e precisam do MESMO balde (dois baldes = 6/s na
   mesma conta, o dobro do limite; rejeitar o canônico jogaria o cliente fail-open
   pra fora da coordenação). Qualquer alias do contrato entra; o balde é um só. */
const _CONTRATO = require('./contrato-empresas.json');
function contaCanonica(nome) {
  const n = String(nome || '').toLowerCase().trim();
  for (const [id, e] of Object.entries(_CONTRATO.empresas)) {
    if ((e.aliases || []).some(a => String(a).toLowerCase().trim() === n)) return id;
  }
  return null;
}

async function tratar(req, res, urlObj, json) {
  const p = urlObj.pathname;
  if (!p.startsWith('/bling-ritmo/')) return false;
  /* Codex #356 r2+r3: ?k= na URL é o P0 conhecido, e compartilhar a ADMIN_KEY geral
     com a Expedição expandiria um comprometimento de lá pra TODAS as rotas
     administrativas daqui. Credencial DEDICADA do porteiro (BLING_RITMO_KEY) pelo
     header x-ritmo-key; sem a env a rota nasce DESLIGADA (503); ?k= leva 400. */
  if (urlObj.searchParams.get('k')) { json(res, 400, { ok: false, erro: 'credencial na URL não é aceita nesta rota — use o header x-ritmo-key' }); return true; }
  const CHAVE = process.env.BLING_RITMO_KEY || '';
  if (!CHAVE) { json(res, 503, { ok: false, erro: 'porteiro desligado — configure BLING_RITMO_KEY no serviço (chave dedicada, não a ADMIN_KEY)' }); return true; }
  if (req.headers['x-ritmo-key'] !== CHAVE) { json(res, 404, { error: 'not found', path: p }); return true; }
  const conta = contaCanonica(urlObj.searchParams.get('conta'));
  if (!conta) { json(res, 400, { ok: false, erro: 'conta fora do contrato de empresas (a cota do Bling é por CNPJ) — use um id canônico ou alias do contrato: ' + Object.entries(_CONTRATO.empresas).map(([i, e]) => e.aliases.join('/')).join(', ') }); return true; }
  if (p === '/bling-ritmo/permissao' && req.method === 'POST') {
    const pri = urlObj.searchParams.get('prioridade') === 'operacao' ? 'operacao' : 'fundo';
    json(res, 200, permissao(conta, pri)); return true;
  }
  if (p === '/bling-ritmo/aviso-429' && req.method === 'POST') { json(res, 200, aviso429(conta, urlObj.searchParams.get('retry_after_s'))); return true; }
  if (p === '/bling-ritmo/aviso-ok' && req.method === 'POST') { json(res, 200, avisoOk(conta, urlObj.searchParams.get('ficha'))); return true; }
  if (p === '/bling-ritmo/estado' && req.method === 'GET') { json(res, 200, estado(conta)); return true; }
  json(res, 404, { ok: false, erro: 'rotas: POST permissao | POST aviso-429 | POST aviso-ok | GET estado' });
  return true;
}

module.exports = {
  tratar,
  _interno: { permissao, aviso429, avisoOk, estado, contaCanonica, _agoraRef, _contas, ARQ, _carregar },
};
