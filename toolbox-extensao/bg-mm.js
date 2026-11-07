'use strict';
// background.js — service worker. Recebe os lotes do content script e faz POST
// no Render (/good-mm-etiquetas/sync) com a chave GOOD_MM_SYNC_KEY guardada.

const DEFAULT_BASE = 'https://mover-pedidos-aguardando-x-atendido.onrender.com';

async function getCfg() {
  const c = await chrome.storage.local.get(['renderBase', 'syncKey']);
  return { renderBase: (c.renderBase || DEFAULT_BASE).replace(/\/+$/, ''), syncKey: c.syncKey || '' };
}

async function enviarParaRender(lotes) {
  const cfg = await getCfg();
  if (!cfg.syncKey) return { ok: false, erro: 'Sem chave. Abra a extensão e cole a GOOD_MM_SYNC_KEY.' };
  try {
    /* Toolbox 2.0: a rota segue a EMPRESA da instância — /girassol-mm-etiquetas ou
     /good-mm-etiquetas (o padrão das rotas do Mover-Pedidos). AMB não tem MM. */
  const _emp = (await chrome.storage.local.get(['tb_empresa'])).tb_empresa || 'good';
  const destino = cfg.renderBase + '|' + _emp;   /* Codex #804 (r2): o destino é fotografado ANTES de mandar — a confirmação vale pra ele */
  /* 2.1.8: o envio tem PRAZO (60 s — cobre o servidor acordando); sem resposta, a telinha mostra o motivo em vez de esperar pra sempre */
  const ac = new AbortController();
  const tm = setTimeout(function () { ac.abort(); }, 60000);
  let r;
  try {
  r = await fetch(cfg.renderBase + '/' + _emp + '-mm-etiquetas/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MM-Key': cfg.syncKey },
      body: JSON.stringify({ lotes: lotes }),
      signal: ac.signal
    });
  } catch (e) {
    clearTimeout(tm);
    return { ok: false, status: null, erro: ac.signal.aborted ? 'o servidor do checkout não respondeu em 60s (acordando?) — tente de novo em 1 minuto' : ('rede: ' + String(e && e.message || e)), destino: destino };
  }
    let txt = '';
    try { txt = await r.text(); }   /* o corpo também dentro do prazo */
    catch (e) { clearTimeout(tm); return { ok: false, status: r.status, erro: ac.signal.aborted ? 'o servidor do checkout não terminou de responder em 60s — tente de novo em 1 minuto' : ('rede: ' + String(e && e.message || e)), destino: destino }; }
    clearTimeout(tm);
    let js = null; try { js = JSON.parse(txt); } catch (e) {}
    return { ok: r.ok, status: r.status, resposta: js || txt, destino: destino };
  } catch (e) {
    return { ok: false, erro: String(e && e.message || e) };
  }
}

async function registrarStatus(s) {
  await chrome.storage.local.set({ ultimoStatus: Object.assign({ quando: Date.now() }, s) });
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.tipo === 'MM_LOTES') {
    (async function () {
      if (!msg.ok) {
        await registrarStatus({ etapa: 'ler_mm', ok: false, motivo: msg.motivo, pedidos: msg.pedidos || [], status: msg.status || null, erro: msg.erro || 'falha ao ler lotes do MM' });   // Codex #236 r4: sem o motivo, o popup ignorava a FALHA do sync manual e ficava em 'Sincronizando...'
        sendResponse({ ok: false });
        return;
      }
      const lotes = msg.lotes || [];
      const prontos = lotes.filter(function (l) { return Number(l && l.status) === 2; });
      const env = await enviarParaRender(lotes);
      /* 07/11 (2.1.7): o servidor diz quais etiquetas (ZPL) guardou -- essas não são baixadas de novo; guarda 30 dias */
      let zplGuardadas = 0;
      try {
        const g = env && env.ok && env.resposta && Array.isArray(env.resposta.zpl_guardados) ? env.resposta.zpl_guardados : [];
        if (g.length) {
          /* Codex #804: o "já entregue" é POR DESTINO (servidor + empresa) — a mesma chave que a página usa */
          const dest = env.destino;   /* Codex #804 (r2): o destino do ENVIO, não a configuração de agora (pode ter mudado no meio) */
          if (!dest) throw new Error('sem destino');
          const todos = ((await chrome.storage.local.get(['mm_zpl_entregues'])) || {}).mm_zpl_entregues || {};
          const atual = (todos && typeof todos[dest] === 'object' && todos[dest]) || {};
          const agora = Date.now(), limite = agora - 30 * 86400000;
          for (const k of Object.keys(atual)) if (!(atual[k] > limite)) delete atual[k];
          for (const b of g) atual[String(b)] = agora;
          const novo = {};
          for (const d of Object.keys(todos)) if (todos[d] && typeof todos[d] === 'object') novo[d] = todos[d];   /* o formato velho (plano) é descartado */
          novo[dest] = atual;
          await chrome.storage.local.set({ mm_zpl_entregues: novo });
          zplGuardadas = g.length;
        }
      } catch (e) { /* sem a marca, a próxima rodada manda de novo (o servidor só sobrescreve) */ }
      await registrarStatus(Object.assign({ etapa: 'sync', motivo: msg.motivo, pedidos: msg.pedidos || [], zpl_falhas: Array.isArray(msg.zpl_falhas) ? msg.zpl_falhas.slice(0, 20) : [], lidos: lotes.length, prontos: prontos.length, etiquetas: zplGuardadas }, env));
      sendResponse(env);
    })();
    return true; // resposta assíncrona
  }
});
