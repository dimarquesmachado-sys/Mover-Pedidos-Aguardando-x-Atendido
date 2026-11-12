'use strict';
/* Toolbox — CÓDIGO DA COLETA DO ML → E-MAIL DO ESTOQUE (09/11, pedido do dono).
   O ML não tem API pro código de autorização da coleta (vale só o dia). O ct-coleta.js lê o código na página de vendas
   do ML e este fundo o manda pro servidor (rota /<checkout da empresa>/ml-codigo-coleta, chave TOOLBOX_KEY), que manda
   o e-mail pro estoque.

   2.1.13 (10/11) — MODO PASSIVO, decisão do dono depois da cláusula 12 dos Termos do Mercado Livre (atualizada em
   15/10/2026: proíbe sistema automatizado, inclusive agente de IA, que acesse, interaja ou extraia conteúdo do site sem
   autorização). Até a 2.1.12 a Toolbox ABRIA a página sozinha (7h e a cada ~30 min) e CLICAVA em "Detalhes das coletas"
   — exatamente o que a cláusula proíbe. Agora:
   · NADA de abrir página, clicar ou alarme: o código só é lido quando uma PESSOA abre a página de vendas neste navegador
     (o estoquista logo cedo, por exemplo) — o leitor lê o que já está na tela dela;
   · motorista e placa vão quando a pessoa abre o painel "Detalhes das coletas" e o ML já os mostra (o leitor percebe,
     sem clicar) — o servidor manda UM segundo e-mail;
   · o "Mandar agora" (o dono clicou) pede à página de vendas JÁ ABERTA que releia e reenvie; sem página aberta, a tela
     diz pra abrir;
   · a Toolbox nunca fecha aba nenhuma (as abas são de quem as abriu);
   · na troca da 2.1.12 pra cá, apaga os alarmes que ela deixava (tb-coleta, tb-coleta-fechar).
   O "hoje" é o de Brasília (o dono roda a extensão de outro fuso). */

const COLETA_PREFIXO = { girassol: '/girassol-backup-offline', good: '/good-checkout-offline', amb: '/amb-checkout-offline' };
const COLETA_BASE_PADRAO = 'https://mover-pedidos-aguardando-x-atendido.onrender.com';
const COLETA_FORCAR_MS = 4 * 60000;

function coletaDiaBR() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const v = (t) => (p.find((x) => x.type === t) || {}).value;
  return v('year') + '-' + v('month') + '-' + v('day');
}

async function coletaStatus(s) {
  await chrome.storage.local.set({ coleta_status: Object.assign({ quando: Date.now() }, s) });
}

async function coletaEnviar(codigo, origem, detalhes, forcar) {
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
      body: JSON.stringify({ codigo, origem, detalhes: detalhes || {}, forcar: forcar === true }), signal: ac.signal,
    });
    const txt = await r.text();
    clearTimeout(tm);
    let js = null; try { js = JSON.parse(txt); } catch (e) { /* HTML do Render acordando */ }
    if (!js) return { ok: false, via: 'resposta_ilegivel', erro: 'o servidor respondeu HTTP ' + r.status + ' sem JSON (acordando?) — abra a página de vendas de novo em instantes' };
    return js;
  } catch (e) {
    clearTimeout(tm);
    return { ok: false, via: 'rede', erro: ac.signal.aborted ? 'o servidor não respondeu em 60 s (acordando?) — abra a página de vendas de novo em instantes' : ('rede: ' + String((e && e.message) || e)) };
  }
}

/* Codex #824: a confirmação "já foi hoje" é DA EMPRESA (trocar a empresa da instalação no menu não pode calar a nova) */
function coletaJaFoi(ok, empresa, dia, codigo) {
  return !!(ok && ok.empresa === empresa && ok.dia === dia && (codigo == null || ok.codigo === codigo));
}

async function coletaRecebeuCodigo(codigo, detalhes, tabId, url) {
  const dia = coletaDiaBR();
  const c = await chrome.storage.local.get(['coleta_ok', 'tb_empresa', 'coleta_forcar']);
  const det = (detalhes && typeof detalhes === 'object') ? detalhes : {};
  const temMotorista = !!(det.motorista && det.placa);
  /* o "Mandar agora" (o dono clicou, nos últimos 4 min) REENVIA mesmo o código já tendo ido hoje — Codex #837: só a
     leitura da ABA a que o botão pediu a releitura consome a marca (outra aba aberta, mandando o motorista ou o código
     no meio, não pode gastá-la) */
  const forcado = !!(c.coleta_forcar && tabId != null && c.coleta_forcar.aba === tabId && Date.now() - c.coleta_forcar.em < COLETA_FORCAR_MS);
  if (forcado) await chrome.storage.local.remove('coleta_forcar');
  /* já foi hoje, pra esta empresa: só manda de novo se antes faltava motorista/placa e agora eles vieram */
  if (!forcado && coletaJaFoi(c.coleta_ok, c.tb_empresa, dia, codigo) && (c.coleta_ok.completo || !temMotorista)) {
    await coletaStatus({ ok: true, via: 'ja_foi_hoje', codigo, msg: 'o estoque já recebeu o código de hoje — nada novo pra mandar' });
    return;
  }
  const empresaDoEnvio = c.tb_empresa;
  const r = await coletaEnviar(codigo, /vendas/.test(url || '') ? 'pagina_vendas' : 'toolbox', det, forcado);
  if (r && r.ok && (r.via === 'enviado' || r.via === 'ja_enviado' || r.via === 'atualizado' || r.via === 'reenviado')) {
    await chrome.storage.local.set({ coleta_ok: { empresa: empresaDoEnvio, dia, codigo, completo: !!r.completo } });
    const msg = r.via === 'reenviado' ? 'código reenviado pro estoque' : r.via === 'atualizado' ? 'motorista e placa enviados pro estoque'
      : r.via === 'enviado' ? ('código enviado pro estoque' + (r.completo ? ', com motorista e placa' : ' — motorista e placa vão quando alguém abrir "Detalhes das coletas" e o ML já mostrar'))
        : 'o estoque já tinha recebido este código hoje';
    await coletaStatus({ ok: true, via: r.via, codigo, para: r.para || null, msg });
  } else {
    await coletaStatus({ ok: false, via: (r && r.via) || 'erro', codigo, msg: (r && r.erro) || 'falha ao enviar' });
  }
}

/* o "Mandar agora": pede à página de vendas do ML JÁ ABERTA (por uma pessoa) que releia e reenvie — a Toolbox não abre
   página nenhuma. Sem página aberta, a tela diz pra abrir. */
async function coletaMandarAgora() {
  let abas = [];
  try { abas = await chrome.tabs.query({ url: 'https://vendedores.mercadolivre.com.br/vendas/*' }); } catch (e) { abas = []; }
  if (!abas || !abas.length) {
    await coletaStatus({ ok: false, via: 'sem_pagina_aberta', msg: 'abra a página de Vendas do Mercado Livre neste navegador (logado na conta da empresa) e clique de novo' });
    return;
  }
  /* Codex #837: a marca vai AMARRADA à aba a quem se pede a releitura (gravada antes do pedido); a aba que responde "sem
     código" não encerra a busca — tenta a próxima; nenhuma com o código → a marca sai e a tela explica */
  let achou = false, algumLeitor = false, paginaVelha = false;
  for (const a of abas) {
    await chrome.storage.local.set({ coleta_forcar: { em: Date.now(), aba: a.id } });
    let r = null;
    try { r = await chrome.tabs.sendMessage(a.id, { tipo: 'COLETA_RELER' }); algumLeitor = true; } catch (e) { r = null; /* aba sem o leitor (carregando) */ }
    if (r && r.ok) { achou = true; break; }
    if (r && r.motivo === 'pagina_de_outro_dia') paginaVelha = true;
  }
  if (!achou) {
    await chrome.storage.local.remove('coleta_forcar');
    await coletaStatus({ ok: false, via: paginaVelha ? 'pagina_de_outro_dia' : (algumLeitor ? 'pagina_sem_codigo' : 'pagina_sem_leitor'),
      msg: paginaVelha ? 'a página de Vendas do ML está aberta desde outro dia — o código na tela é o velho. Recarregue a página (F5) e clique de novo'
        : (algumLeitor ? 'a página de Vendas aberta não mostra o código de autorização — confira se está logado na conta da empresa' : 'a página de Vendas aberta ainda não carregou o leitor — recarregue a página (F5) e clique de novo') });
  }
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.tipo !== 'string' || msg.tipo.indexOf('COLETA_') !== 0) return;
  (async function () {
    if (msg.tipo === 'COLETA_CODIGO') await coletaRecebeuCodigo(String(msg.codigo || ''), msg.detalhes, sender && sender.tab ? sender.tab.id : null, msg.url);
    else if (msg.tipo === 'COLETA_SEM_CODIGO') {
      await coletaStatus({ ok: false, via: msg.motivo, msg: msg.motivo === 'nao_logado' ? 'o ML não está logado neste navegador — entre na conta da empresa'
        : msg.motivo === 'pagina_de_outro_dia' ? 'a página de Vendas do ML está aberta desde outro dia — o código na tela é o velho. Recarregue a página (F5) pra ler o código de hoje'
          : 'a página de vendas abriu sem o código de autorização' });
    } else if (msg.tipo === 'COLETA_AGORA') await coletaMandarAgora();
    sendResponse({ ok: true });
  })();
  return true;
});

/* a troca da 2.1.12 pra cá: os alarmes da versão automática não podem continuar tocando */
try { chrome.alarms.clear('tb-coleta'); chrome.alarms.clear('tb-coleta-fechar'); } catch (e) { /* sem alarmes */ }
try { chrome.storage.local.remove(['coleta_aba', 'coleta_tentativa']); } catch (e) { /* nada guardado */ }
