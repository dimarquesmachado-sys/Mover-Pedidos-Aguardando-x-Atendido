/* Sinal de vida dos módulos da Toolbox (29/08). Chamado quando o módulo MONTA de verdade —
   não no load do script: o que interessa saber é se ele ainda consegue aparecer na página.
   Limitado a 1x por dia por módulo (storage local), pra não virar tráfego nem ruído. */
window.tbSinalDeVida = function (modulo, fase) {
  try {
    fase = (fase === 'carregou') ? 'carregou' : 'montou';
    var chaveDia = 'tb_sinal_' + modulo + '_' + fase;
    var hoje = new Date().toISOString().slice(0, 10);
    chrome.storage.local.get([chaveDia, 'tb_empresa', 'tb_servidor'], function (cfg) {
      if (cfg[chaveDia] === hoje) return;                       // já sinalizou hoje
      /* 29/08 (visto em produção): numa instalação nova o módulo pode montar ANTES de o dono
         escolher a empresa no popup — o sinal ia como "sem-empresa" e criava registro órfão.
         Sem empresa definida, não sinaliza: na próxima montagem, já configurado, sinaliza
         certo (e o dia não é marcado, então nada se perde). */
      if (!cfg.tb_empresa) return;
      var base = cfg.tb_servidor || 'https://mover-pedidos-aguardando-x-atendido.onrender.com';
      /* 29/08: o POST com Content-Type JSON é cross-origin a partir da página do Bling/ML e
         o navegador o BLOQUEIA no preflight — nenhum sinal chegava. sendBeacon envia uma
         requisição SIMPLES (text/plain), que atravessa sem preflight e sem esperar resposta;
         o servidor faz JSON.parse do corpo de qualquer forma. */
      var corpo = JSON.stringify({ modulo: modulo, empresa: cfg.tb_empresa || '', fase: fase, versao: (chrome.runtime.getManifest() || {}).version });
      var url = base + '/diagnostico/modulos';
      var enviado = false;
      try {
        if (navigator.sendBeacon) enviado = navigator.sendBeacon(url, new Blob([corpo], { type: 'text/plain' }));
      } catch (e) { enviado = false; }
      if (enviado) {
        var o = {}; o[chaveDia] = hoje; chrome.storage.local.set(o);
      } else {
        /* fallback: fetch simples (text/plain também evita preflight); no-cors basta porque
           não precisamos LER a resposta, só entregar o sinal. */
        fetch(url, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: corpo })
          .then(function () { var o2 = {}; o2[chaveDia] = hoje; chrome.storage.local.set(o2); })
          .catch(function () { /* tenta de novo na próxima montagem */ });
      }
    });
  } catch (e) { /* nunca atrapalha o módulo */ }
};
