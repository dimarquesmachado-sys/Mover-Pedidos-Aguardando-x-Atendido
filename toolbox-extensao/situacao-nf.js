/* Toolbox — NF em "Consultar situação": a LEITURA da resposta do Bling (2.1.17, 12/11). Sem página nem chrome aqui: dá
   pra testar em Node (scripts/teste-toolbox-situacao.js). O contrato veio do robô local de junho (as mesmas duas chamadas
   internas do Bling que o clique "3 pontinhos → Consultar situação" faz):
     1) getEnvelopeSituacao(idNota)  → <xjx>… callbackSituacao(id, '<retConsSitNFe …><cStat>100</cStat>…', '') …
     2) updateSituacao(idNota, xmlEmBase64, cStat, xMotivo, 'S')   — SÓ quando a SEFAZ respondeu 100 (Autorizado). */
(function (root) {
  'use strict';
  function corpo(fn, args) {
    var p = ['xajax=' + encodeURIComponent(fn), 'xajaxr=' + Date.now()];
    for (var i = 0; i < args.length; i++) p.push('xajaxargs[]=' + encodeURIComponent(String(args[i])));
    return p.join('&');
  }
  /* devolve { tipo: 'nao_logado' | 'sem_callback' | 'resposta', xml, cStat, xMotivo } */
  function lerEnvelope(texto) {
    var t = String(texto || '');
    if (t.indexOf('<xjx') === -1 && /login|entrar|sess[aã]o expirad/i.test(t.slice(0, 3000))) return { tipo: 'nao_logado' };
    var m = t.match(/callbackSituacao\(\s*\d+\s*,\s*'([\s\S]*?)'\s*,\s*'[^']*'\s*\)/);
    if (!m) return { tipo: 'sem_callback', amostra: t.replace(/\s+/g, ' ').slice(0, 160) };
    var xml = m[1];
    var c = xml.match(/<cStat>(\d+)<\/cStat>/), x = xml.match(/<xMotivo>([^<]*)<\/xMotivo>/);
    return { tipo: 'resposta', xml: xml, cStat: c ? c[1] : '', xMotivo: x ? x[1] : '' };
  }
  function base64(xml) {
    return btoa(unescape(encodeURIComponent(xml)));   /* UTF-8 → base64, como o Bling espera */
  }
  /* a gravação deu certo? o Bling responde em xjx; página de login ou erro HTTP = não */
  function gravou(status, texto) {
    var t = String(texto || '');
    if (!(status >= 200 && status < 300)) return false;
    if (t.indexOf('<xjx') === -1 && /login|entrar/i.test(t.slice(0, 3000))) return false;
    return true;
  }
  root.tbSituacaoNF = { corpo: corpo, lerEnvelope: lerEnvelope, base64: base64, gravou: gravou };
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this));
