// ============================================================
// GOOD Devoluções Bridge - content.js  (v1.4.3)
// ============================================================
// Roda dentro da pagina do admin (onrender.com).
// Escuta window.postMessage da pagina e faz "ponte" com a extensao.
// ============================================================

const BRIDGE_VERSAO = '1.4.3';

// Sinaliza pra pagina que a extensao esta presente (pra UI mostrar status)
window.postMessage({
  tipo: 'GOOD_BRIDGE_INSTALADA',
  versao: BRIDGE_VERSAO,
}, '*');

// Responde quando a pagina perguntar via PING
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.tipo !== 'GOOD_BRIDGE_PING') return;

  window.postMessage({
    tipo: 'GOOD_BRIDGE_PONG',
    versao: BRIDGE_VERSAO,
  }, '*');
});

// Escuta pedidos da pagina pra criar/emitir devolucao
window.addEventListener('message', async (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.tipo !== 'GOOD_BRIDGE_CRIAR_DEVOLUCAO') return;

  const requisicaoId = event.data.requisicaoId;

  function responder(ok, resultado, erro) {
    window.postMessage({
      tipo: 'GOOD_BRIDGE_RESPOSTA',
      requisicaoId,
      ok,
      resultado,
      erro,
    }, '*');
  }

  // Se a extensao foi recarregada/atualizada, esta pagina ficou com a
  // "ponte velha" pendurada - avisa na hora em vez de travar 45s.
  if (!chrome.runtime || !chrome.runtime.id) {
    responder(false, null, 'A extensao foi recarregada e esta pagina ficou com a versao antiga da ponte. Recarregue esta pagina do painel (Ctrl+Shift+R) e tente de novo.');
    return;
  }

  try {
    // Manda mensagem pro background.js com timeout proprio (100s)
    const resposta = await Promise.race([
      chrome.runtime.sendMessage({
        tipo: 'BLING_DEVOLUCAO_CRIAR',
        payload: event.data.payload,   // { idNFOriginal, idLoja, emitir }
      }),
      new Promise((resolve) => setTimeout(() => resolve(null), 100000)),
    ]);

    if (!resposta) {
      responder(false, null, 'A extensao nao respondeu em 100s. A NF PODE ter sido criada mesmo assim - recarregue o painel (Ctrl+Shift+R) e clique em Gerar de novo que o sistema confere e vincula.');
      return;
    }

    responder(resposta.ok, resposta.resultado, resposta.erro);

  } catch (err) {
    // Erro ao falar com background (extensao foi desabilitada/recarregada)
    responder(false, null, 'Extensao indisponivel: ' + (err.message || String(err)) + '. Se voce acabou de recarregar a extensao, recarregue esta pagina do painel (Ctrl+Shift+R).');
  }
});

console.log('[GOOD Devolucoes Bridge] content.js v' + BRIDGE_VERSAO + ' carregado');
