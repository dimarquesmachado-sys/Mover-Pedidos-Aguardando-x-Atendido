'use strict';
/* Toolbox — CÓDIGO DA COLETA DO ML → E-MAIL DO ESTOQUE (09/11, pedido do dono).
   O ML não tem API pro código de autorização da coleta (vale só o dia). A Toolbox, logada no ML da empresa desta
   instalação, abre a página de vendas numa aba de FUNDO às 7h de Brasília, o ct-coleta.js lê o código e este fundo o
   manda pro servidor (rota /<checkout da empresa>/ml-codigo-coleta, chave TOOLBOX_KEY), que manda o e-mail.
   · sem sucesso (não logado, página sem o código, servidor fora): tenta de novo a cada ~30 min até as 18h;
   · abrir a página de vendas na mão também manda (se ainda não foi hoje);
   · só fecha a aba que ELE abriu. O "hoje" é o de Brasília (o dono roda a extensão de outro fuso).
   2.1.11 (pedido do dono): junto vão os DETALHES da coleta (horário, motorista, placa…). Se o código foi sem motorista/
   placa (o ML ainda não tinha definido), ela continua olhando a cada ~30 min até o FIM da janela da coleta (ou 18h) e
   manda os dois assim que aparecerem — o servidor manda UM segundo e-mail. */

const COLETA_URL = 'https://vendedores.mercadolivre.com.br/vendas/omni/lista?filters=TAB_TODAY&search=&limit=50&offset=0&selectedTab=TAB_TODAY';
const COLETA_PREFIXO = { girassol: '/girassol-backup-offline', good: '/good-checkout-offline', amb: '/amb-checkout-offline' };
const COLETA_BASE_PADRAO = 'https://mover-pedidos-aguardando-x-atendido.onrender.com';
const COLETA_HORA_INICIO = 7, COLETA_HORA_FIM = 18, COLETA_ESPACO_MS = 25 * 60000;

function coletaAgoraBR() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const v = (t) => (p.find((x) => x.type === t) || {}).value;
  const hora = Number(v('hour')) % 24;
  return { dia: v('year') + '-' + v('month') + '-' + v('day'), hora: hora, minDia: hora * 60 + Number(v('minute') || 0) };
}

async function coletaStatus(s) {
  await chrome.storage.local.set({ coleta_status: Object.assign({ quando: Date.now() }, s) });
}

async function coletaFecharAba(tabId) {
  const c = await chrome.storage.local.get(['coleta_aba']);
  if (c.coleta_aba && (tabId == null || c.coleta_aba === tabId)) {
    try { await chrome.tabs.remove(c.coleta_aba); } catch (e) { /* já fechada */ }
    await chrome.storage.local.remove('coleta_aba');
  }
}

async function coletaEnviar(codigo, origem, detalhes) {
  const c = await chrome.storage.local.get(['tb_empresa', 'tb_servidor', 'renderBase', 'coleta_key']);
  const pref = COLETA_PREFIXO[c.tb_empresa];
  if (!pref) return { ok: false, via: 'sem_empresa', erro: 'escolha a empresa desta instalação no menu da Toolbox' };
  if (!c.coleta_key) return { ok: false, via: 'sem_chave', erro: 'cole a TOOLBOX_KEY na tela "Código da coleta ML" da Toolbox' };
  const base = String(c.tb_servidor || c.renderBase || COLETA_BASE_PADRAO).replace(/\/+$/, '');
  const ac = new AbortController();
  const tm = setTimeout(() => ac.abort(), 60000);
  try {
    const r = await fetch(base + pref + '/ml-codigo-coleta', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Toolbox-Key': c.coleta_key },
      body: JSON.stringify({ codigo, origem, detalhes: detalhes || {} }), signal: ac.signal,
    });
    const txt = await r.text();
    clearTimeout(tm);
    let js = null; try { js = JSON.parse(txt); } catch (e) { /* HTML do Render acordando */ }
    if (!js) return { ok: false, via: 'resposta_ilegivel', erro: 'o servidor respondeu HTTP ' + r.status + ' sem JSON (acordando?) — tento de novo' };
    return js;
  } catch (e) {
    clearTimeout(tm);
    return { ok: false, via: 'rede', erro: ac.signal.aborted ? 'o servidor não respondeu em 60 s (acordando?) — tento de novo' : ('rede: ' + String((e && e.message) || e)) };
  }
}

/* Codex #824: a confirmação "já foi hoje" é DA EMPRESA (trocar a empresa da instalação no menu não pode calar a nova) */
function coletaJaFoi(ok, empresa, dia, codigo) {
  return !!(ok && ok.empresa === empresa && ok.dia === dia && (codigo == null || ok.codigo === codigo));
}
/* quando a janela da coleta termina, em MINUTOS do dia ("15 h - 17 h" → 1020; "15:00 h - 17:30 h" → 1050); sem horário,
   null. Codex #825: com só a hora, "17:30" parava de olhar às 17h — meia hora antes do fim. */
function coletaFimMin(horario) {
  const m = /-\s*(\d{1,2})(?::(\d{2}))?\s*h/i.exec(String(horario || ''));
  return m ? Number(m[1]) * 60 + Number(m[2] || 0) : null;
}

async function coletaRecebeuCodigo(codigo, detalhes, tabId, url) {
  const agora = coletaAgoraBR();
  const c = await chrome.storage.local.get(['coleta_ok', 'tb_empresa']);
  const det = (detalhes && typeof detalhes === 'object') ? detalhes : {};
  const temMotorista = !!(det.motorista && det.placa);
  /* já foi hoje, pra esta empresa: só manda de novo se antes faltava motorista/placa e agora eles vieram */
  if (coletaJaFoi(c.coleta_ok, c.tb_empresa, agora.dia, codigo) && (c.coleta_ok.completo || !temMotorista)) {
    /* Codex #825 (3ª rodada): nada novo pro e-mail, mas o HORÁRIO da coleta pode ter aparecido só agora — guarda o fim
       da janela, senão a espera pelo motorista pararia nas 18h mesmo com a coleta indo até mais tarde */
    const fimNovo = coletaFimMin(det.horario);
    if (fimNovo && fimNovo !== c.coleta_ok.fim_min) await chrome.storage.local.set({ coleta_ok: Object.assign({}, c.coleta_ok, { fim_min: fimNovo }) });
    await coletaFecharAba(tabId); return;
  }
  const empresaDoEnvio = c.tb_empresa;
  const r = await coletaEnviar(codigo, /vendas/.test(url || '') ? 'pagina_vendas' : 'toolbox', det);
  if (r && r.ok && (r.via === 'enviado' || r.via === 'ja_enviado' || r.via === 'atualizado')) {
    const fim = coletaFimMin(det.horario) || ((c.coleta_ok && c.coleta_ok.dia === agora.dia && c.coleta_ok.fim_min) || null);
    await chrome.storage.local.set({ coleta_ok: { empresa: empresaDoEnvio, dia: agora.dia, codigo: codigo, completo: !!r.completo, fim_min: fim } });
    const msg = r.via === 'atualizado' ? 'motorista e placa enviados pro estoque'
      : r.via === 'enviado' ? ('código enviado pro estoque' + (r.completo ? ', com motorista e placa' : ' — motorista e placa ainda não definidos pelo ML, olho de novo em ~30 min'))
        : 'o estoque já tinha recebido este código hoje';
    await coletaStatus({ ok: true, via: r.via, codigo, para: r.para || null, msg });
  } else {
    await coletaStatus({ ok: false, via: (r && r.via) || 'erro', codigo, msg: (r && r.erro) || 'falha ao enviar' });
  }
  await coletaFecharAba(tabId);
}

/* Codex #824 (2ª rodada): a acordada do fundo (coletaAbrir no topo) e o alarme podiam rodar JUNTOS, ler a mesma
   tentativa antiga e abrir DUAS abas — e só a última ficava anotada pra fechar. Agora as aberturas vão EM FILA: a
   segunda espera a primeira e já enxerga a tentativa que ela gravou (o espaço de 25 min a segura). */
let _coletaFila = Promise.resolve();
function coletaAbrir(forcar) {
  const vez = _coletaFila.then(() => _coletaAbrir(forcar), () => _coletaAbrir(forcar));
  _coletaFila = vez.catch(() => {});
  return vez;
}

async function _coletaAbrir(forcar) {
  const c = await chrome.storage.local.get(['tb_empresa', 'coleta_key', 'coleta_ok', 'coleta_tentativa']);
  if (!COLETA_PREFIXO[c.tb_empresa] || !c.coleta_key) return;
  const agora = coletaAgoraBR();
  if (!forcar) {
    /* Codex #825 (2ª rodada): dois prazos diferentes, cada um no seu caso —
       · o CÓDIGO: das 7h às 18h;
       · esperando o MOTORISTA (o código já foi): até o fim da janela da coleta, mesmo que passe das 18h (sem a janela, 18h). */
    if (coletaJaFoi(c.coleta_ok, c.tb_empresa, agora.dia, null)) {
      if (c.coleta_ok.completo) return;   /* código + motorista + placa já foram */
      if (agora.hora < COLETA_HORA_INICIO || agora.minDia >= (c.coleta_ok.fim_min || COLETA_HORA_FIM * 60)) return;   /* a janela da coleta acabou: para de olhar */
    } else if (agora.hora < COLETA_HORA_INICIO || agora.hora >= COLETA_HORA_FIM) return;
    if (c.coleta_tentativa && Date.now() - c.coleta_tentativa < COLETA_ESPACO_MS) return;
  }
  await coletaFecharAba(null);   /* sobra de uma tentativa anterior */
  const aba = await chrome.tabs.create({ url: COLETA_URL, active: false });
  await chrome.storage.local.set({ coleta_aba: aba && aba.id, coleta_tentativa: Date.now() });
  chrome.alarms.create('tb-coleta-fechar', { delayInMinutes: 3 });   /* a aba nunca fica esquecida aberta (60 s do código + 20 s do painel cabem) */
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.tipo !== 'string' || msg.tipo.indexOf('COLETA_') !== 0) return;
  const tabId = sender && sender.tab ? sender.tab.id : null;
  (async function () {
    if (msg.tipo === 'COLETA_QUEM_ABRIU') {   /* 2.1.11: só na aba que a Toolbox abriu o leitor clica em "Detalhes das coletas" */
      const ab = await chrome.storage.local.get(['coleta_aba']);
      sendResponse({ minha: !!(ab.coleta_aba && ab.coleta_aba === tabId) });
      return;
    }
    if (msg.tipo === 'COLETA_CODIGO') await coletaRecebeuCodigo(String(msg.codigo || ''), msg.detalhes, tabId, msg.url);
    else if (msg.tipo === 'COLETA_SEM_CODIGO') {
      const ab = await chrome.storage.local.get(['coleta_aba']);
      if (ab.coleta_aba && ab.coleta_aba === tabId) {   /* só conta como falha a aba que a Toolbox abriu */
        await coletaStatus({ ok: false, via: msg.motivo, msg: msg.motivo === 'nao_logado' ? 'o ML não está logado neste navegador — entre na conta da empresa' : 'a página de vendas abriu sem o código de autorização' });
        await coletaFecharAba(tabId);
      }
    } else if (msg.tipo === 'COLETA_AGORA') await coletaAbrir(true);
    sendResponse({ ok: true });
  })();
  return true;
});

/* Codex #824 (P1): no Chrome/Edge o fundo acorda a cada ~5 min (o alarme do Frágil) e é desligado ocioso; criar o
   alarme de novo a cada acordada SUBSTITUÍA o anterior e empurrava o primeiro disparo 15 min pra frente — ele nunca
   tocava. Agora só cria se não existe; e cada acordada também confere (as travas de horário/espaço/já-foi seguram). */
chrome.alarms.get('tb-coleta', function (al) { if (!al) chrome.alarms.create('tb-coleta', { periodInMinutes: 15 }); });
coletaAbrir(false);
chrome.alarms.onAlarm.addListener(function (a) {
  if (a.name === 'tb-coleta') coletaAbrir(false);
  else if (a.name === 'tb-coleta-fechar') {
    (async function () {
      const ab = await chrome.storage.local.get(['coleta_aba']);
      if (ab.coleta_aba) { await coletaStatus({ ok: false, via: 'sem_resposta_da_pagina', msg: 'a página de vendas não respondeu em 2 min — tento de novo em ~30 min' }); await coletaFecharAba(null); }
    })();
  }
});
