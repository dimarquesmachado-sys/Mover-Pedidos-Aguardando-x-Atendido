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
    if (!tm || typeof tm.renovarToken !== 'function') return { ok: false, erro: 'modulo sem renovarToken' };
    const tk = await tm.renovarToken();
    return { ok: !!(tk && tk.length > 10), erro: null };
  } catch (e) {
    return { ok: false, erro: (e && e.message) ? e.message.slice(0, 200) : String(e) };
  }
}

async function verificarTodos() {
  const estado = lerEstado();
  estado.modulos = estado.modulos || {};
  for (const m of MODULOS) {
    const r = await verificarUm(m);
    estado.modulos[m.id] = { nome: m.nome, ok: r.ok, erro: r.erro, em: new Date().toISOString() };
    if (r.ok) console.log('[canario-tokens] ' + m.id + ': token OK');
    else console.error('[canario-tokens] ⚠️ ' + m.id + ' FALHOU: ' + r.erro + ' — reautorize em /' + m.id + '/auth/bling');
  }
  estado.verificadoEm = new Date().toISOString();
  salvarEstado(estado);
  return estado;
}

/** true se ALGUM módulo está com token quebrado (usado pelo aviso na barra) */
function temAlerta() {
  const e = lerEstado();
  return Object.values(e.modulos || {}).some(m => m && m.ok === false);
}

function iniciar() {
  // primeira verificação 5 min após o boot (deixa o serviço estabilizar), depois 1x/dia
  setTimeout(() => { verificarTodos().catch(e => console.error('[canario-tokens]', e.message)); }, 5 * 60 * 1000);
  setInterval(() => { verificarTodos().catch(e => console.error('[canario-tokens]', e.message)); }, INTERVALO_MS);
}

module.exports = { iniciar, verificarTodos, lerEstado, temAlerta, MODULOS };
