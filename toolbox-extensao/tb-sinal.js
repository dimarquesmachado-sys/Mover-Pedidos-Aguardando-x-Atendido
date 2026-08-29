/* Sinal de vida dos módulos da Toolbox (29/08). Chamado quando o módulo MONTA de verdade —
   não no load do script: o que interessa saber é se ele ainda consegue aparecer na página.
   Limitado a 1x por dia por módulo (storage local), pra não virar tráfego nem ruído. */
window.tbSinalDeVida = function (modulo) {
  try {
    var chaveDia = 'tb_sinal_' + modulo;
    var hoje = new Date().toISOString().slice(0, 10);
    chrome.storage.local.get([chaveDia, 'tb_empresa', 'tb_servidor'], function (cfg) {
      if (cfg[chaveDia] === hoje) return;                       // já sinalizou hoje
      var base = cfg.tb_servidor || 'https://mover-pedidos-aguardando-x-atendido.onrender.com';
      fetch(base + '/diagnostico/modulos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modulo: modulo, empresa: cfg.tb_empresa || '', versao: (chrome.runtime.getManifest() || {}).version }),
      }).then(function () {
        var o = {}; o[chaveDia] = hoje; chrome.storage.local.set(o);
      }).catch(function () { /* offline ou servidor fora: tenta de novo na próxima montagem */ });
    });
  } catch (e) { /* nunca atrapalha o módulo */ }
};
