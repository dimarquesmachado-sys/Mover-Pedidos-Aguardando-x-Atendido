/* Toolbox — leitura da página de vendas do ML pro código da coleta (09/11). Só funções puras sobre o TEXTO da página
   (testáveis fora do navegador): o código de autorização do dia e, do painel "Detalhes das coletas", o horário, o
   status, o motorista, a placa e o depósito. O que não estiver na tela volta vazio — nunca inventado. */
(function (raiz) {
  'use strict';
  var RE_CODIGO = /C[óo]digo de autoriza[çc][ãa]o para hoje:?\s*([A-Za-z0-9]{6,12})\b/;
  function lerCodigo(txt) { var m = RE_CODIGO.exec(String(txt || '')); return m ? m[1].toUpperCase() : null; }
  function limpar(s, max) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max || 80); }
  function lerDetalhes(txt) {
    var t = String(txt || '');
    var d = {};
    var mh = /Coleta\s*\|\s*(\d{1,2}(?::\d{2})?\s*h?\s*-\s*\d{1,2}(?::\d{2})?\s*h)/i.exec(t);
    if (mh) d.horario = limpar(mh[1], 30);
    var ms = /(?:^|\n)\s*([A-ZÀ-Ú][A-ZÀ-Ú ]{3,28})\s*\n\s*Coleta\s*\|/.exec(t);
    if (ms) d.status = limpar(ms[1], 30);
    var mm = /Motorista:\s*([^\n]{3,80})/i.exec(t);
    if (mm) d.motorista = limpar(mm[1], 80);
    var mp = /Placa:\s*([A-Za-z0-9-]{6,8})\b/i.exec(t);
    if (mp) d.placa = mp[1].toUpperCase();
    var md = /(?:^|\n)\s*(Dep[óo]sito [^\n]{2,60})/.exec(t);
    if (md) d.deposito = limpar(md[1], 60);
    return d;
  }
  raiz.tbColetaLer = { lerCodigo: lerCodigo, lerDetalhes: lerDetalhes };
})(typeof window !== 'undefined' ? window : this);
