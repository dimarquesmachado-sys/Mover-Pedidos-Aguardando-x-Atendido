'use strict';

/**
 * Canário dos MÓDULOS de extensão (29/08 — pedido do dono).
 *
 * O padrão que dói: o marketplace muda uma URL, o content script deixa de ser injetado e
 * NADA dá erro — o painel simplesmente não aparece mais e ninguém percebe por semanas.
 * Aconteceu duas vezes no mesmo dia (Respostas e o domínio novo do ML).
 *
 * Cada módulo manda um "sinal de vida" quando MONTA na página (a extensão limita a 1x/dia).
 * Aqui guardamos o último sinal e há quantos dias distintos ele apareceu. O alerta é por
 * QUEDA DE PADRÃO: módulo que tinha rotina (>= DIAS_PADRAO dias com sinal) e sumiu por
 * DIAS_MUDO. Módulo que nunca sinalizou não alerta — pode ser algo que a empresa não usa.
 */

const fs = require('fs');
const path = require('path');

const ESTADO_FILE = process.env.CANARIO_MODULOS_FILE || '/data/canario-modulos.json';
const DIAS_PADRAO = 3;    // precisa ter aparecido em 3 dias distintos pra virar "rotina"
const DIAS_MUDO   = 7;    /* 29/08 (decisão do dono): 3 dias acusava um fim de semana
   prolongado sem usar o módulo — falso positivo repetido ensina a IGNORAR o aviso, que é o
   pior desfecho pra um canário. 7 dias cobre feriado emendado e ainda descobre a quebra em
   uma semana, no lugar dos meses de antes. */
const MAX_REGISTROS = 60; // trava de tamanho: ids desconhecidos não podem inchar o arquivo

const MODULOS_CONHECIDOS = ['respostas', 'fragil', 'nf', 'mm', 'devolucoes', 'esteira'];
const EMPRESAS = ['girassol', 'good', 'amb'];

function hoje() { return new Date().toISOString().slice(0, 10); }

function ler() {
  try {
    if (!fs.existsSync(ESTADO_FILE)) return {};
    return JSON.parse(fs.readFileSync(ESTADO_FILE, 'utf8')) || {};
  } catch (e) { return {}; }
}

function salvar(estado) {
  try {
    fs.mkdirSync(path.dirname(ESTADO_FILE), { recursive: true });
    fs.writeFileSync(ESTADO_FILE, JSON.stringify(estado, null, 2), 'utf8');
  } catch (e) { console.error('[canario-modulos] nao gravou:', e.message); }
}

/** Sinal de vida vindo da extensão. Devolve false se o registro for recusado. */
function registrar(modulo, empresa, versao) {
  const mod = String(modulo || '').toLowerCase().slice(0, 30);
  const emp = String(empresa || '').toLowerCase().slice(0, 20);
  if (!MODULOS_CONHECIDOS.includes(mod)) return false;   // ignora id desconhecido (nao incha o arquivo)
  if (emp && !EMPRESAS.includes(emp)) return false;
  const chave = mod + ':' + (emp || 'sem-empresa');
  const estado = ler();
  if (!estado[chave] && Object.keys(estado).length >= MAX_REGISTROS) return false;
  const r = estado[chave] || { modulo: mod, empresa: emp, dias: [], visto: 0 };
  const d = hoje();
  if (r.dias[r.dias.length - 1] !== d) {
    r.dias.push(d);
    if (r.dias.length > 30) r.dias = r.dias.slice(-30);   // guarda só o mês corrente
  }
  r.ultimo = new Date().toISOString();
  r.visto = r.dias.length;
  if (versao) r.versao = String(versao).slice(0, 20);
  estado[chave] = r;
  salvar(estado);
  return true;
}

function diasSemSinal(r) {
  if (!r.ultimo) return null;
  return Math.floor((Date.now() - new Date(r.ultimo).getTime()) / 86400000);
}

/** Módulos que TINHAM rotina e ficaram mudos. */
function mudos() {
  const estado = ler();
  const out = [];
  for (const chave of Object.keys(estado)) {
    const r = estado[chave];
    const d = diasSemSinal(r);
    if (r.visto >= DIAS_PADRAO && d !== null && d >= DIAS_MUDO) {
      out.push({ modulo: r.modulo, empresa: r.empresa, dias: d, ultimo: r.ultimo });
    }
  }
  return out;
}

function estadoCompleto() {
  const estado = ler();
  const lista = Object.keys(estado).map(k => {
    const r = estado[k];
    return { chave: k, modulo: r.modulo, empresa: r.empresa, versao: r.versao || null,
             diasComSinal: r.visto, ultimo: r.ultimo, diasSemSinal: diasSemSinal(r) };
  });
  return { modulos: lista, mudos: mudos(), regras: { DIAS_PADRAO, DIAS_MUDO } };
}

module.exports = { registrar, mudos, estadoCompleto, MODULOS_CONHECIDOS };
