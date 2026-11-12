/* Toolbox — NF em "CONSULTAR SITUAÇÃO" destrava sozinha (2.1.17, 12/11 — pedido do dono: "é só 1 clique e resolve… tinha
   que ajustar isso pra todas as empresas não ficarem com as NFs travadas").

   O que é: a SEFAZ autorizou a nota, o Bling perdeu o retorno e a nota fica em "Consultar situação" — o pedido não anda.
   O conserto manual é 3 pontinhos → Consultar situação (uns 10 s). Este bloco faz ESSE clique sozinho, com qualquer página
   do Bling aberta: pergunta ao servidor quais notas desta empresa estão paradas, consulta cada uma na própria sessão do
   Bling e, SÓ quando a SEFAZ responde 100 (Autorizado), grava — exatamente o que o clique faz. Qualquer outra resposta
   não grava nada: fica registrada e vira aviso no checkout do admin (pelo servidor).

   Antes isto era um robô num computador do dono (Tarefa Agendada); com ele desligado, nada destravava. Aqui roda onde
   houver um Bling aberto com a Toolbox. Invisível: não mostra nada na página. Uma rodada por empresa a cada 10 min, no
   máximo (o fundo da extensão decide), 10 notas por rodada, 1,5 s entre elas. */
(function () {
  'use strict';
  if (window.top !== window || window.__tbSituacao) return;
  window.__tbSituacao = true;
  var L = window.tbSituacaoNF;
  var ENDERECOS = ['/services/notas.fiscais.server.php', '/b/services/notas.fiscais.server.php', '/notas.fiscais.server.php'];
  var rodando = false;
  var PRAZO_MS = 15000;
  function pedir(msg) { return new Promise(function (ok) { try { chrome.runtime.sendMessage(msg, function (r) { void chrome.runtime.lastError; ok(r || null); }); } catch (e) { ok(null); } }); }
  function espera(ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }
  async function xajax(fn, args) {
    var ult = null;
    for (var i = 0; i < ENDERECOS.length; i++) {
      /* cada chamada tem PRAZO (15 s): a rodada inteira tem que caber na vez que o fundo deu (Codex #848) */
      var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
      var tm = ctl ? setTimeout(function () { ctl.abort(); }, PRAZO_MS) : null;
      try {
        var r = await fetch(ENDERECOS[i] + '?f=' + fn, { method: 'POST', credentials: 'include', signal: ctl ? ctl.signal : undefined,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' }, body: L.corpo(fn, args) });
        ult = { status: r.status, texto: await r.text() };
      } finally { if (tm) clearTimeout(tm); }
      if (r.status !== 404) return ult;   /* 404 = este endereço não existe nesta conta: tenta o próximo */
    }
    return ult;
  }
  async function umaNota(nf) {
    var id = String(nf.id), base = { id: id, numero: nf.numero || null };
    try {
      var r1 = await xajax('getEnvelopeSituacao', [id]);
      if (!(r1.status >= 200 && r1.status < 300)) return Object.assign(base, { via: 'erro', erro: 'HTTP ' + r1.status + ' ao consultar' });
      var e = L.lerEnvelope(r1.texto);
      if (e.tipo === 'nao_logado') return Object.assign(base, { via: 'nao_logado' });
      if (e.tipo === 'sem_callback') return Object.assign(base, { via: 'sem_resposta', erro: e.amostra });
      if (e.cStat !== '100') return Object.assign(base, { via: 'nao_autorizada', cStat: e.cStat, xMotivo: e.xMotivo });
      var r2 = await xajax('updateSituacao', [id, L.base64(e.xml), e.cStat, e.xMotivo, 'S']);
      if (!L.gravou(r2.status, r2.texto)) return Object.assign(base, { via: 'erro', cStat: e.cStat, xMotivo: e.xMotivo, erro: 'a SEFAZ autorizou, mas o Bling não gravou (HTTP ' + r2.status + ')' });
      /* 'gravada' = o Bling aceitou; quem confirma que DESTRAVOU é o fundo, pela lista do servidor (Codex #848) */
      return Object.assign(base, { via: 'gravada', cStat: e.cStat, xMotivo: e.xMotivo });
    } catch (err) { return Object.assign(base, { via: 'erro', erro: String((err && err.message) || err).slice(0, 160) }); }
  }
  async function rodada(forcar) {
    if (rodando) return;
    rodando = true;
    try {
      var p = await pedir({ tipo: 'SITUACAO_PEDIR', forcar: !!forcar });
      if (!p || !p.rodar || !p.nfs || !p.nfs.length) return;
      var res = [];
      for (var i = 0; i < p.nfs.length; i++) {
        var r = await umaNota(p.nfs[i]); res.push(r);
        if (r.via === 'nao_logado') break;   /* sem sessão não adianta tentar as outras */
        if (i < p.nfs.length - 1) await espera(1500);
      }
      await pedir({ tipo: 'SITUACAO_RESULTADO', empresa: p.empresa, ficha: p.ficha, resultados: res });
    } finally { rodando = false; }
  }
  try { chrome.runtime.onMessage.addListener(function (msg, _s, responder) { if (msg && msg.tipo === 'SITUACAO_RODAR') { rodada(true); responder({ ok: true }); } }); } catch (e) { /* sem runtime */ }
  setTimeout(function () { rodada(false); }, 5000);
  setInterval(function () { rodada(false); }, 5 * 60000);   /* o fundo segura em 10 min por empresa */
})();
