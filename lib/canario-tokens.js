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

/* tokenFile espelha a env/default de cada tokenManager (eles nao exportam o caminho) —
   serve pra distinguir 'nunca autorizado' de 'arquivo apagado/corrompido'. */
const MODULOS = [
  { id: 'estoque',          nome: 'Estoque (celular)',     mod: '../estoque/tokenManager',
    tokenFile: () => process.env.ESTOQUE_TOKEN_FILE || '/data/estoque/bling-tokens.json' },
  { id: 'estoque-girassol', nome: 'Estoque Girassol',      mod: '../estoque-girassol/tokenManager',
    tokenFile: () => process.env.ESTOQUE_GIRASSOL_TOKEN_FILE || '/data/estoque-girassol/bling-tokens.json' },
  { id: 'fragil',           nome: 'Frágil (autocomplete)', mod: '../fragil/tokenManager',
    tokenFile: () => process.env.FRAGIL_TOKEN_FILE || '/data/fragil/bling-tokens.json' },
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

/* Codex #256 r3: falha de REDE ao renovar (DNS, timeout, 5xx, rate limit) não prova que a
   credencial morreu — só recusa explícita do OAuth (invalid_grant e afins) é quebra. */
function refreshFoiRecusa(msg) {
  const m = String(msg || '').toLowerCase();
  /* Codex #256 r4: erro de CONFIGURAÇÃO (client_id/secret ausente, refresh_token ausente) é
     determinístico — não melhora sozinho e precisa acender a tarja, senão fica calado pra
     sempre como se fosse instabilidade de rede. */
  if (/não definidos|nao definidos|ausente|não configurado|nao configurado/.test(m)) return true;
  return /invalid_grant|invalid_request|unauthorized|expired|revoked|400|401/.test(m);
}

async function tentarRefresh(tm, m, motivo) {
  try {
    const tk = await tm.renovarToken();
    if (tk && tk.length > 10) return { estado: 'renovavel', erro: motivo + '; o refresh funcionou e o token foi renovado' };
    return { estado: 'quebrado', erro: motivo + '; o refresh não devolveu token válido — reautorize em /' + m.id + '/auth/bling' };
  } catch (eR) {
    const msg = (eR && eR.message) ? eR.message.slice(0, 140) : 'erro';
    if (refreshFoiRecusa(msg)) return { estado: 'quebrado', erro: motivo + '; refresh RECUSADO (' + msg + ') — reautorize em /' + m.id + '/auth/bling' };
    return { estado: 'indeterminado', erro: motivo + '; não deu pra testar o refresh agora (' + msg + ')' };
  }
}

async function verificarUm(m, anterior) {
  try {
    const tm = require(m.mod);
    if (!tm || typeof tm.lerTokens !== 'function') return { estado: 'erro', erro: 'modulo sem lerTokens' };
    const { access_token, refresh_token } = tm.lerTokens() || {};
    /* NUNCA AUTORIZADO e diferente de TOKEN MORTO: o primeiro e um modulo que ninguem
       ligou ainda (nao ha o que consertar no Bling), o segundo e uma quebra real.
       Codex #256: os tokenManagers devolvem {} tanto pra 'nunca existiu' quanto pra arquivo
       APAGADO OU CORROMPIDO — o segundo e perda de autorizacao e tem que ACENDER a tarja.
       O arquivo existir no disco e o que separa os dois. */
    if (!refresh_token) {
      let arqExiste = false;
      try { arqExiste = fs.existsSync(m.tokenFile()); } catch (e) { arqExiste = false; }
      if (arqExiste) return { estado: 'quebrado', erro: 'arquivo de token existe mas está sem refresh_token (apagado/corrompido) — reautorize em /' + m.id + '/auth/bling' };
      /* Codex #256 r2: se este módulo JÁ esteve autorizado (histórico), o arquivo ter sumido
         é PERDA de autorização — voltar pra 'nao_autorizado' silenciaria a tarja justamente
         quando algo apagou o token de um módulo em uso. */
      if (anterior && anterior.jaAutorizado) return { estado: 'quebrado', erro: 'o arquivo de token SUMIU (o módulo já esteve autorizado) — reautorize em /' + m.id + '/auth/bling' };
      return { estado: 'nao_autorizado', erro: 'nunca autorizado neste serviço — rode /' + m.id + '/auth/bling se for usar' };
    }
    /* Codex #256 r3: access ausente com refresh PRESENTE não é quebra — é exatamente o que
       garantirToken() resolve sozinho no uso. Tenta renovar antes de acusar. */
    if (!access_token || access_token.length < 10) return tentarRefresh(tm, m, 'access_token ausente');
    /* VERIFICACAO PASSIVA: uma chamada leve com o token ATUAL. Forcar refresh_token todo dia
       era perigoso — o Bling ROTACIONA o refresh a cada renovacao, entao o canario podia
       correr com a renovacao do proprio modulo e QUEBRAR um token saudavel (o vigia virando
       a causa do problema). Se o access estiver vencido, o proprio modulo renova no uso. */
    /* Codex #256: prova com PRAZO — Bling que aceita a conexao e para de responder travava
       o loop inteiro (os modulos seguintes nem eram checados e o estado nao era salvo). */
    const ctrl = new AbortController();
    const prazo = setTimeout(() => ctrl.abort(), 15000);
    let r;
    try {
      r = await fetch('https://api.bling.com.br/Api/v3/produtos?limite=1', {
        headers: { Authorization: 'Bearer ' + access_token },
        signal: ctrl.signal,
      });
    } finally { clearTimeout(prazo); }
    /* Codex #256 r2: headers podem chegar e o CORPO travar — não lemos o corpo, então
       cancelamos explicitamente pra não deixar a conexão pendurada. */
    try { if (r && r.body && typeof r.body.cancel === 'function') r.body.cancel(); } catch (e) { /* nada a fazer */ }
    /* Codex #256: cada desfecho no seu estado. 401/403 = access vencido, o modulo renova
       sozinho no proximo uso → 'renovavel', que NAO acende a tarja. 5xx/timeout/rede =
       'indeterminado', tambem sem tarja (o problema seria do Bling, nao do token). Qualquer
       outro 4xx (400 de mudanca de API, 404 de endpoint, 429) e INCONCLUSIVO — nao pode
       virar 'ok' em silencio. */
    if (r.status === 401 || r.status === 403) {
      /* Codex #256 r2: 401 NÃO prova que o módulo consegue renovar — se o refresh também
         morreu, ficaríamos calados com o módulo quebrado. Só aqui vale renovar de verdade:
         é o único caminho que responde a pergunta, e não roda no caso saudável (onde a
         rotação concorrente seria o risco). */
      return tentarRefresh(tm, m, 'access_token recusado (HTTP ' + r.status + ')');
    }
    if (r.status >= 500) return { estado: 'indeterminado', erro: 'Bling indisponível no teste (HTTP ' + r.status + ')' };
    if (!r.ok) return { estado: 'indeterminado', erro: 'resposta inconclusiva do Bling (HTTP ' + r.status + ') — verifique se a API mudou' };
    return { estado: 'ok', erro: null };
  } catch (e) {
    const msg = (e && e.name === 'AbortError') ? 'Bling não respondeu em 15s' : ((e && e.message) ? e.message.slice(0, 200) : String(e));
    return { estado: 'indeterminado', erro: msg };
  }
}

async function verificarTodos() {
  const estado = lerEstado();
  estado.modulos = estado.modulos || {};
  for (const m of MODULOS) {
    const r = await verificarUm(m, (estado.modulos || {})[m.id]);
    const antes = (estado.modulos || {})[m.id] || {};
    /* Codex #256 r3: antes.ok === true cobre o estado gravado pela VERSÃO ANTERIOR (que não
       tinha jaAutorizado) — sem isso, um deploy novo seguido de perda do arquivo classificaria
       como 'nunca autorizado' e calaria a tarja. */
    const jaAutorizado = !!antes.jaAutorizado || antes.ok === true || r.estado === 'ok' || r.estado === 'renovavel' || r.estado === 'quebrado';
    /* Codex #256 r3: prova INCONCLUSIVA não apaga falha JÁ CONFIRMADA — senão um 5xx do Bling
       transformava 'quebrado' em 'indeterminado' e a tarja se apagava sozinha. */
    let estadoFinal = r.estado, erroFinal = r.erro;
    if (r.estado === 'indeterminado' && antes.estado === 'quebrado') {
      estadoFinal = 'quebrado';
      erroFinal = antes.erro + ' (última verificação foi inconclusiva: ' + r.erro + ')';
    }
    estado.modulos[m.id] = { nome: m.nome, estado: estadoFinal, ok: estadoFinal === 'ok', erro: erroFinal, jaAutorizado, em: new Date().toISOString() };
    if (estadoFinal === 'ok') console.log('[canario-tokens] ' + m.id + ': token OK');
    else if (estadoFinal === 'quebrado') console.error('[canario-tokens] ⚠️ ' + m.id + ': ' + erroFinal);
    else console.log('[canario-tokens] ' + m.id + ' (' + estadoFinal + '): ' + erroFinal);
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
  return Object.values(e.modulos || {}).some(m => m && m.estado === 'quebrado');
}

function iniciar() {
  // primeira verificação 5 min após o boot (deixa o serviço estabilizar), depois 1x/dia
  setTimeout(() => { verificarTodos().catch(e => console.error('[canario-tokens]', e.message)); }, 5 * 60 * 1000);
  setInterval(() => { verificarTodos().catch(e => console.error('[canario-tokens]', e.message)); }, INTERVALO_MS);
}

module.exports = { iniciar, verificarTodos, lerEstado, temAlerta, MODULOS };
