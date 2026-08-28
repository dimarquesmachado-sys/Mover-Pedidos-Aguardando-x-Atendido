/* ESTEIRA BLING - page-hook v0.14.1 (roda no contexto da pagina)
   Escuta a consulta que o Bling faz quando o painel multiloja de um
   produto abre (obterVinculoProdutosMultilojas) e avisa a extensao
   QUAL IdProduto foi carregado. Identidade absoluta, sem depender
   do titulo truncado. Nao altera nenhuma requisicao. */
(function () {
  'use strict';

  function avisa(id) {
    try { window.postMessage({ __esteiraVinculoAberto: true, idProduto: String(id), t: Date.now() }, '*'); } catch (e) {}
  }

  window.addEventListener('message', function (ev) {
    if (ev.source === window && ev.data && ev.data.__esteiraHookPing) {
      try { window.postMessage({ __esteiraHookOk: true }, '*'); } catch (e) {}
    }
  });

  /* Codex #238 (Toolbox): numa instancia GOOD/AMB este script (world MAIN, sem acesso a
     chrome.storage) tambem era injetado e patchava XHR/fetch da pagina a toa. Agora os
     patches so APLICAM quando o content — que roda o gate de instancia — manda ativar
     (__esteiraHookAtivar); antes disso, nada e tocado. O robo so age muito depois do
     idle, entao nada se perde entre o start e a ativacao. */
  var _patchesAplicados = false;
  window.addEventListener('message', function (ev) {
    if (ev.source === window && ev.data && ev.data.__esteiraHookAtivar && !_patchesAplicados) {
      _patchesAplicados = true;
      aplicarPatches();
    }
  });

  function aplicarPatches() {
    var openO = XMLHttpRequest.prototype.open;
    var sendO = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) {
      this.__estUrl = u;
      return openO.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (corpo) {
      try {
        var u = String(this.__estUrl || '');
        var xhr = this;
        if (u.indexOf('obterVinculoProdutosMultilojas') !== -1) {
          var m = String(corpo || '').match(/xajaxargs\[\]=(\d+)/);
          if (m) {
            xhr.addEventListener('load', function () {
              if (xhr.status === 200) avisa(m[1]);
            });
          }
        }
        if (u.indexOf('salvarProdutoLoja') !== -1) {
          xhr.addEventListener('load', function () {
            if (xhr.status === 200) {
              try { window.postMessage({ __esteiraSalvou: true, t: Date.now() }, '*'); } catch (e) {}
            }
          });
        }
      } catch (e) {}
      return sendO.apply(this, arguments);
    };

    var fo = window.fetch;
    if (fo) {
      window.fetch = function (entrada, opts) {
        var url = (typeof entrada === 'string') ? entrada : (entrada && entrada.url) || '';
        var corpo = opts && opts.body;
        var p = fo.apply(this, arguments);
        try {
          if (String(url).indexOf('obterVinculoProdutosMultilojas') !== -1) {
            var m = String(corpo || '').match(/xajaxargs\[\]=(\d+)/);
            if (m) {
              p.then(function (r) { if (r && r.ok) avisa(m[1]); }).catch(function () {});
            }
          }
        } catch (e) {}
        return p;
      };
    }
  }
})();
