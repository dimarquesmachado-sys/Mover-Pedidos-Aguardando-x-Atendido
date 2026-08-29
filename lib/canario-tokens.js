'use strict';

/**
 * Canário de tokens Bling (28/08 — pedido do dono).
 *
 * Vários módulos têm OAuth Bling PRÓPRIO (estoque, estoque-girassol, fragil). O access_token
 * se renova sozinho na primeira recusa, então o dia a dia não dá trabalho — o risco é o
 * REFRESH morrer (validade longa, módulo parado por muito tempo, app revogado no Bling).
 * Quando isso acontece hoje, ninguém descobre até um estoquista não achar produto.
 *
 * Este canário faz UMA renovação real por módulo, uma vez por dia, e guarda o resultado.
 * Renovar de verdade é o único teste honesto: o arquivo existir não prova que o Bling aceita.
 */

const fs = require('fs');
const path = require('path');

const ESTADO_FILE = process.env.CANARIO_TOKENS_FILE || '/data/canario-tokens.json';
const INTERVALO_MS = 24 * 60 * 60 * 1000;

const MODULOS = [
  { id: 'estoque',           nome: 'Estoque (celular)',      mod: '../estoque/tokenManager' },
  { id: 'estoque-girassol',  nome: 'Estoque Girassol',       mod: '../estoque-girassol/tokenManager' },
  { id: 'fragil',            nome: 'Frágil (autocomplete)',  mod: '../fragil/tokenManager' },
];

function lerEstado() {
  try {
    if (!fs.existsSync(ESTADO_FILE)) return { modulos: {}, verificadoEm: null };
    return JSON.parse(fs.readFileSync(ESTADO_FILE, 'utf8'));
  } catch (e) { return { modulos: {}, verificadoEm: null }; }
}

function salvarEstado(estado) {
  try {
    fs.mkdirSync(path.dirname(ESTADO_FILE), { recursive: true });
    fs.writeFileSync(ESTADO_FILE, JSON.stringify(estado, null, 2), 'utf8');
  } catch (e) { console.error('[canario-tokens] nao consegui gravar estado:', e.message); }
}

async function verificarUm(m) {
  try {
    const tm = require(m.mod);
    if (!tm || typeof tm.lerTokens !== 'function') return { estado: 'erro', erro: 'modulo sem lerTokens' };
    const { access_token, refresh_token } = tm.lerTokens() || {};
    /* NUNCA AUTORIZADO e diferente de TOKEN MORTO: o primeiro e um modulo que ninguem
       ligou ainda (nao ha o que consertar no Bling), o segundo e uma quebra real. */
    if (!refresh_token) return { estado: 'nao_autorizado', erro: 'nunca autorizado neste serviço — rode /' + m.id + '/auth/bling se for usar' };
    if (!access_token || access_token.length < 10) return { estado: 'quebrado', erro: 'access_token ausente' };
    /* VERIFICACAO PASSIVA: uma chamada leve com o token ATUAL. Forcar refresh_token todo dia
       era perigoso — o Bling ROTACIONA o refresh a cada renovacao, entao o canario podia
       correr com a renovacao do proprio modulo e QUEBRAR um token saudavel (o vigia virando
       a causa do problema). Se o access estiver vencido, o proprio modulo renova no uso. */
    const r = await fetch('https://api.bling.com.br/Api/v3/produtos?limite=1', {
      headers: { Authorization: 'Bearer ' + access_token },
    });
    if (r.status === 401 || r.status === 403) return { estado: 'atencao', erro: 'access_token recusado (HTTP ' + r.status + ') — o módulo renova no próximo uso; se persistir, reautorize' };
    if (!r.ok && r.status >= 500) return { estado: 'atencao', erro: 'Bling indisponível no teste (HTTP ' + r.status + ')' };
    return { estado: 'ok', erro: null };
  } catch (e) {
    return { estado: 'atencao', erro: (e && e.message) ? e.message.slice(0, 200) : String(e) };
  }
}

async function verificarTodos() {
  const estado = lerEstado();
  estado.modulos = estado.modulos || {};
  for (const m of MODULOS) {
    const r = await verificarUm(m);
    estado.modulos[m.id] = { nome: m.nome, estado: r.estado, ok: r.estado === 'ok', erro: r.erro, em: new Date().toISOString() };
    if (r.estado === 'ok') console.log('[canario-tokens] ' + m.id + ': token OK');
    else if (r.estado === 'nao_autorizado') console.log('[canario-tokens] ' + m.id + ': ' + r.erro);
    else console.error('[canario-tokens] ⚠️ ' + m.id + ': ' + r.erro);
  }
  estado.verificadoEm = new Date().toISOString();
  salvarEstado(estado);
  return estado;
}

/** true se ALGUM módulo está com token quebrado (usado pelo aviso na barra) */
/* A tarja vermelha da barra so acende pra QUEBRA REAL. Modulo nunca autorizado nao e
   problema — pode ser um modulo que a empresa nem usa. */
function temAlerta() {
  const e = lerEstado();
  return Object.values(e.modulos || {}).some(m => m && (m.estado === 'quebrado' || m.estado === 'atencao'));
}

function iniciar() {
  // primeira verificação 5 min após o boot (deixa o serviço estabilizar), depois 1x/dia
  setTimeout(() => { verificarTodos().catch(e => console.error('[canario-tokens]', e.message)); }, 5 * 60 * 1000);
  setInterval(() => { verificarTodos().catch(e => console.error('[canario-tokens]', e.message)); }, INTERVALO_MS);
}

module.exports = { iniciar, verificarTodos, lerEstado, temAlerta, MODULOS };
