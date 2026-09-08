'use strict';
/* PORTEIRO DE RITMO DO BLING — a cota é POR CONTA (CNPJ), não por app: 3 req/s e
   120k/dia valem pra conta INTEIRA (módulos daqui + app de NF-e + Expedição, todos
   somados). Incidentes que motivaram: 03/09 (backfill daqui esgotou a cota e derrubou
   a bipagem da Expedição) e 08/09 (a Expedição sozinha passou de 16/s). O porteiro
   dá permissão ANTES da chamada, com balde de fichas POR CONTA e duas classes:
   'operacao' (bipagem/despacho — o estoquista está com o pacote na mão) tem reserva
   garantida; 'fundo' (backfill, varredura, cron) pega o resto.

   CONTRATO (combinado com o app de Expedição):
     POST /bling-ritmo/permissao?conta=girassol&prioridade=operacao|fundo&k=ADMIN_KEY
       → 200 {"ok":true}                          pode chamar AGORA
       → 200 {"ok":false,"esperar_ms":250}        aguarde e peça de novo
       → 200 {"ok":false,"pausa_s":120,"motivo"}  429 recente: pausa global da conta
     POST /bling-ritmo/aviso-429?conta=girassol&retry_after_s=60&k=ADMIN_KEY
       quem levou 429 avisa — TODOS recuam juntos (escada 15s→30s→1m→2m→5m,
       Retry-After do Bling tem precedência quando informado)
     POST /bling-ritmo/aviso-ok?conta=girassol&k=ADMIN_KEY
       um sucesso real no Bling libera a pausa e zera a escada
     GET  /bling-ritmo/estado?conta=girassol&k=ADMIN_KEY
       visibilidade: fichas do último segundo, pausa, degrau, usadas no dia

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
const ARQ = path.join(DIR_ESTADO, 'bling-ritmo-estado.json');

const _contas = new Map(); /* conta → { fichas: [ts...], pausaAte: 0, degrau: 0, dia: 'aaaammdd', usadasDia: 0 } */
const _agoraRef = { fn: () => Date.now() }; /* injetável no teste */

function _conta(nome) {
  if (!_contas.has(nome)) _contas.set(nome, { fichas: [], pausaAte: 0, degrau: 0, dia: '', usadasDia: 0 });
  return _contas.get(nome);
}

function _persistir() {
  try {
    const dump = {};
    for (const [k, v] of _contas) dump[k] = { pausaAte: v.pausaAte, degrau: v.degrau, dia: v.dia, usadasDia: v.usadasDia };
    fs.writeFileSync(ARQ, JSON.stringify(dump));
  } catch (e) { /* persistência é conveniência — nunca derruba o porteiro */ }
}
function _carregar() {
  try {
    if (!fs.existsSync(ARQ)) return;
    const dump = JSON.parse(fs.readFileSync(ARQ, 'utf8'));
    for (const [k, v] of Object.entries(dump)) _contas.set(k, { fichas: [], pausaAte: v.pausaAte || 0, degrau: v.degrau || 0, dia: v.dia || '', usadasDia: v.usadasDia || 0 });
  } catch (e) { /* arquivo corrompido: começa limpo */ }
}
_carregar();

function _diaDe(ts) { const d = new Date(ts); return d.toISOString().slice(0, 10); }

function permissao(conta, prioridade) {
  const c = _conta(conta);
  const agora = _agoraRef.fn();
  if (c.pausaAte > agora) {
    return { ok: false, pausa_s: Math.ceil((c.pausaAte - agora) / 1000), motivo: '429 recente na conta — pausa global (degrau ' + c.degrau + ')' };
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
    return { ok: true };
  }
  const maisAntiga = noSegundo.length >= TETO_SEGUNDO ? (noSegundo[0].ts + 1000) : (c.fichas.length ? c.fichas[0].ts + JANELA_MS : agora + 200);
  return { ok: false, esperar_ms: Math.max(50, maisAntiga - agora) };
}

function aviso429(conta, retryAfterS) {
  const c = _conta(conta);
  const agora = _agoraRef.fn();
  const escada = ESCADA_PAUSA_S[Math.min(c.degrau, ESCADA_PAUSA_S.length - 1)];
  const pausaS = Number(retryAfterS) > 0 ? Math.max(Number(retryAfterS), 5) : escada;
  c.degrau = Math.min(c.degrau + 1, ESCADA_PAUSA_S.length - 1);
  /* Codex #356: aviso posterior NUNCA encurta pausa ativa — um Retry-After de 300s
     seguido de um 429 sem header mantinha só o degrau curto e liberava cedo demais. */
  c.pausaAte = Math.max(c.pausaAte, agora + pausaS * 1000);
  _persistir();
  return { ok: true, pausa_s: Math.ceil((c.pausaAte - agora) / 1000), degrau: c.degrau };
}

function avisoOk(conta) {
  const c = _conta(conta);
  const agora = _agoraRef.fn();
  /* Codex #356: sucesso ATRASADO (permissão antiga terminando fora de ordem) não pode
     cancelar pausa recém-instalada — durante a pausa não saem permissões novas, então
     sucesso chegando com pausa ativa é necessariamente de antes dela: ignorado. */
  if (c.pausaAte > agora) return { ok: true, ignorado: true, motivo: 'pausa ativa — sucesso é de permissão anterior ao 429' };
  c.degrau = 0; c.pausaAte = 0;
  _persistir();
  return { ok: true };
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

const CONTAS_VALIDAS = new Set(['girassol', 'good', 'amb']);

async function tratar(req, res, urlObj, json) {
  const p = urlObj.pathname;
  if (!p.startsWith('/bling-ritmo/')) return false;
  /* Codex #356 r2 (P1, usando o PRÓPRIO contrato deste PR contra o desenho): ?k= na
     URL é o P0 conhecido — e o porteiro é chamado por OUTRO serviço pela internet a
     cada chamada ao Bling, então a exposição em log de proxy é máxima. Credencial SÓ
     pelo header x-admin-key; ?k= leva 400 pedagógico. O gate do index não se aplica
     a este prefixo (ver index.js). */
  if (urlObj.searchParams.get('k')) { json(res, 400, { ok: false, erro: 'credencial na URL não é aceita nesta rota — use o header x-admin-key' }); return true; }
  const ADMIN = process.env.ADMIN_KEY || '';
  if (!ADMIN || req.headers['x-admin-key'] !== ADMIN) { json(res, 404, { error: 'not found', path: p }); return true; }
  const conta = String(urlObj.searchParams.get('conta') || '').toLowerCase().trim();
  if (!CONTAS_VALIDAS.has(conta)) { json(res, 400, { ok: false, erro: 'conta inválida — use conta=girassol|good|amb (a cota do Bling é por CNPJ)' }); return true; }
  if (p === '/bling-ritmo/permissao' && req.method === 'POST') {
    const pri = urlObj.searchParams.get('prioridade') === 'operacao' ? 'operacao' : 'fundo';
    json(res, 200, permissao(conta, pri)); return true;
  }
  if (p === '/bling-ritmo/aviso-429' && req.method === 'POST') { json(res, 200, aviso429(conta, urlObj.searchParams.get('retry_after_s'))); return true; }
  if (p === '/bling-ritmo/aviso-ok' && req.method === 'POST') { json(res, 200, avisoOk(conta)); return true; }
  if (p === '/bling-ritmo/estado' && req.method === 'GET') { json(res, 200, estado(conta)); return true; }
  json(res, 404, { ok: false, erro: 'rotas: POST permissao | POST aviso-429 | POST aviso-ok | GET estado' });
  return true;
}

module.exports = {
  tratar,
  _interno: { permissao, aviso429, avisoOk, estado, _agoraRef, _contas, ARQ, _carregar },
};
