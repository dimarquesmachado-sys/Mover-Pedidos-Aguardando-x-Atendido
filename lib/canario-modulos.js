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
const EMPRESAS = require('./empresas').lista();   /* 30/08: vem da env EMPRESAS */

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
function registrar(modulo, empresa, versao, fase) {
  const mod = String(modulo || '').toLowerCase().slice(0, 30);
  const emp = String(empresa || '').toLowerCase().slice(0, 20);
  if (!MODULOS_CONHECIDOS.includes(mod)) return false;   // ignora id desconhecido (nao incha o arquivo)
  /* 29/08: empresa é OBRIGATÓRIA — sinal sem ela criava a chave "<modulo>:sem-empresa",
     um registro órfão que nunca mais recebe sinal e polui o diagnóstico. */
  if (!emp || !EMPRESAS.includes(emp)) return false;
  const chave = mod + ':' + emp;
  const estado = ler();
  for (const ch of Object.keys(estado)) {
    const emp = String((estado[ch] && estado[ch].empresa) || '').toLowerCase();
    if (emp && vivas.indexOf(emp) < 0) delete estado[ch];   /* empresa fora da lista atual */
  }
  if (!estado[chave] && Object.keys(estado).length >= MAX_REGISTROS) return false;
  const r = estado[chave] || { modulo: mod, empresa: emp, dias: [], visto: 0 };
  const d = hoje();
  const f = (fase === 'carregou' || fase === 'montou') ? fase : 'montou';   /* compat: sinal antigo = montou */
  /* CARREGOU = o script foi injetado na página-alvo (você abriu o site).
     MONTOU  = ele conseguiu de fato aparecer/funcionar ali.
     Guardar os dois separados é o que distingue QUEBRA de INATIVIDADE:
     carregou sem montar = a página mudou e o módulo não consegue mais agir. */
  if (f === 'montou') {
    if (r.dias[r.dias.length - 1] !== d) {
      r.dias.push(d);
      if (r.dias.length > 30) r.dias = r.dias.slice(-30);
    }
    r.ultimo = new Date().toISOString();
    r.visto = r.dias.length;
    r.ultimoMontou = r.ultimo;
  } else {
    r.ultimoCarregou = new Date().toISOString();
    r.diaCarregou = d;
  }
  if (versao) r.versao = String(versao).slice(0, 20);
  estado[chave] = r;
  salvar(estado);
  return true;
}

/* Heartbeat: a extensão avisa 1x/dia que está instalada e viva, mesmo que o dono não
   visite site nenhum. Sem ele, "nem carregou" pode ser extensão removida ou navegador
   parado — com ele, dá pra dizer qual dos dois. */
function registrarVivo(empresa, versao) {
  const emp = String(empresa || '').toLowerCase().slice(0, 20);
  if (!EMPRESAS.includes(emp)) return false;
  const estado = ler();
  const chave = '_extensao:' + emp;
  const r = estado[chave] || { extensao: true, empresa: emp };
  r.ultimo = new Date().toISOString();
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
  limparOrfaos();
  /* Codex #307: empresa REMOVIDA de EMPRESAS não manda mais sinal, mas os registros dela
     continuam no arquivo — em 7 dias virariam alerta de "módulo quebrado" de uma loja que
     nem existe mais. Ignora quem não está na lista atual. */
  const vivas = EMPRESAS;   /* Codex #265: órfão ':sem-empresa' com rotina antiga viraria alarme
     FANTASMA — as guardas novas não o alimentam mais, então em 7 dias ele acusaria uma
     quebra que não existe. A limpeza tem que valer também pro alerta público, não só
     pro diagnóstico com chave. */
  const estado = ler();
  const out = [];
  for (const chave of Object.keys(estado)) {
    const r = estado[chave];
    if (r.extensao) continue;                      // heartbeat não é módulo
    const d = diasSemSinal(r);
    if (r.visto < DIAS_PADRAO) continue;           // sem rotina, sem alarme
    /* QUEBRA CONFIRMADA: o script CARREGOU na página-alvo depois do último "montou".
       O site abriu, o módulo foi injetado e mesmo assim não conseguiu aparecer —
       isso não é inatividade, é quebra, e alerta no MESMO DIA. */
    if (r.ultimoCarregou && (!r.ultimoMontou || r.ultimoCarregou > r.ultimoMontou)) {
      const dc = Math.floor((Date.now() - new Date(r.ultimoCarregou).getTime()) / 86400000);
      if (dc <= 1) { out.push({ modulo: r.modulo, empresa: r.empresa, dias: d, tipo: 'quebra', detalhe: 'a página abriu e o módulo não conseguiu aparecer' }); continue; }
    }
    /* Silêncio longo: pode ser inatividade OU URL que mudou (aí nem carrega). Janela longa. */
    if (d !== null && d >= DIAS_MUDO) {
      out.push({ modulo: r.modulo, empresa: r.empresa, dias: d, tipo: 'silencio', detalhe: 'sem sinal há ' + d + ' dias' });
    }
  }
  return out;
}

/* remove registros "sem-empresa" gravados antes da guarda acima (não recebem mais sinal) */
function limparOrfaos() {
  const estado = ler();
  let mudou = false;
  for (const k of Object.keys(estado)) {
    if (k.endsWith(':sem-empresa')) { delete estado[k]; mudou = true; }
  }
  if (mudou) salvar(estado);
  return mudou;
}

function estadoCompleto() {
  limparOrfaos();
  const estado = ler();
  const lista = Object.keys(estado).map(k => {
    const r = estado[k];
    return { chave: k, modulo: r.modulo, empresa: r.empresa, versao: r.versao || null,
             diasComSinal: r.visto, ultimo: r.ultimo, diasSemSinal: diasSemSinal(r) };
  });
  return { modulos: lista, mudos: mudos(), regras: { DIAS_PADRAO, DIAS_MUDO } };
}

module.exports = { registrar, registrarVivo, mudos, estadoCompleto, limparOrfaos, MODULOS_CONHECIDOS };
