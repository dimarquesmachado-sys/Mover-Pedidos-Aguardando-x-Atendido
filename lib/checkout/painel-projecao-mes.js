/* ════════════════════════════════════════════════════════════════════════════════════════
   COMO O MÊS DEVE FECHAR — peça compartilhada do painel (05/10).

   Pega o faturamento do mês corrente até hoje e projeta o fechamento pelo ritmo diário. É a
   resposta pra "vamos bater o mês?" sem esperar o dia 30.

   ⚠️ O CUIDADO QUE DEFINE ESTA SEÇÃO: ritmo de POUCOS DIAS não projeta mês. No dia 2, dois dias
   bons viram uma projeção eufórica e dois ruins viram pânico — e a decisão de compra sai disso.
   Abaixo de 5 dias fechados a seção mostra o faturamento até aqui e DIZ que ainda não dá pra
   projetar, em vez de cuspir um número que ninguém deveria usar.

   ⚠️ E vale pra todo mês: a divisão é pelo dia ATUAL e a multiplicação pelos dias REAIS do mês
   (28, 29, 30 ou 31) — nada de "30 dias" fixo, que erraria todo fevereiro e todo mês de 31.
   ════════════════════════════════════════════════════════════════════════════════════════ */

'use strict';

function scriptDaProjecaoMes(base) {
  const BASE = JSON.stringify(String(base || ''));
  return `(function () {
  'use strict';
  var BASE = ${BASE};
  var alvo = document.getElementById('projecaoMesAqui');
  if (!alvo) return;

  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  function brl(v) {
    if (v == null || v === '' || !isFinite(Number(v))) return null;   /* ausente NÃO é zero */
    return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function chave() {
    try {
      var v = new URLSearchParams(window.location.search).get('k');
      return v ? ('&k=' + encodeURIComponent(v)) : '';
    } catch (e) { return ''; }
  }

  /* ⚠️ abaixo disso, projetar o mês é chute: 2 dias bons viram euforia, 2 ruins viram pânico */
  var MINIMO_DIAS = 5;

  alvo.innerHTML =
    '<div class="card" style="grid-column:1/-1;margin-top:14px">' +
      '<div class="card-tit">📆 Como o mês deve fechar ' +
        '<span style="opacity:.6;font-weight:400;font-size:12px">pelo ritmo até agora</span>' +
        '<button id="pmAtualizar" type="button" style="float:right">↻ atualizar</button></div>' +
      '<div id="pmCorpo" style="margin-top:8px;font-size:13px"></div>' +
    '</div>';

  var elCorpo = document.getElementById('pmCorpo');
  var bt = document.getElementById('pmAtualizar');
  var seq = 0;

  function carregar(forcar) {
    var meu = ++seq;
    /* ⚠️ Codex #628 (P2): a data vem no fuso DA LOJA, não do navegador. O resto do painel usa
       America/Sao_Paulo; com o navegador em outro fuso, perto da virada do mês isto pedia outro
       intervalo e dividia por outro dia — card discordando do painel ao lado. */
    var hojeSP = new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 10);
    var ano = Number(hojeSP.slice(0, 4)), mes = Number(hojeSP.slice(5, 7)), diaHoje = Number(hojeSP.slice(8, 10));
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    var ini = ano + '-' + p(mes) + '-01';
    var hoje = hojeSP;

    bt.disabled = true;
    elCorpo.textContent = 'carregando…';

    /* ⚠️ Codex #628 (P2): o clique em "atualizar" precisa de 'fresh=1' — a rota guarda o agregado
       por 10 min, então sem isso o botão devolvia o MESMO número e a venda recém-registrada não
       aparecia. Botão que não atualiza é pior que botão ausente. */
    fetch(BASE + '/historico-longo?de=' + ini + '&ate=' + hoje + (forcar ? '&fresh=1' : '') + chave(),
          { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (meu !== seq) return;
        bt.disabled = false;
        /* 'ok' ausente é FALHA, não mês zerado */
        if (!d || d.ok !== true || !d.totais) {
          elCorpo.innerHTML = '⚠️ ' + esc((d && (d.erro || d.error)) || 'não consegui o faturamento do mês');
          return;
        }

        /* ⚠️ Codex #628 (P2): acima de 60.000 linhas a rota devolve 'ok:true' com 'truncado:true'
           e totais PARCIAIS. Projetar sobre isso mostraria um mês menor do que é, com cara de
           número completo — o pior caso da regra da casa. */
        if (d.truncado) {
          elCorpo.innerHTML = '⚠️ o histórico deste mês passou do limite que a consulta devolve ' +
            '(resposta truncada): o faturamento viria incompleto, então não projeto o fechamento.';
          return;
        }

        var fat = Number(d.totais.faturamento);
        if (!isFinite(fat)) {
          elCorpo.innerHTML = '⚠️ o servidor não mandou o faturamento do mês';
          return;
        }

        /* ⚠️ Codex #628 (P2): intervalo SEM linhas não é prova de venda zero — pode ser período
           não importado (o painel tem avisarOndeTemDado() por isso). Projetar daí diria "fecha em
           R$ 0,00" com cara de previsão. Sem itens, não há base. */
        if (!(Number(d.totais.itens) > 0)) {
          elCorpo.innerHTML = '⚠️ não há vendas registradas neste mês até hoje — o período pode não ' +
            'estar importado, então não há base pra projetar o fechamento.';
          return;
        }

        /* dias REAIS do mês: 28/29/30/31 — nada de 30 fixo */
        var diasNoMes = new Date(ano, mes, 0).getDate();   /* no fuso da loja */
        var diaAtual = diaHoje;
        var diasFechados = diaAtual - 1;   /* HOJE AINDA NÃO ACABOU: ritmo e guarda contam só dias fechados */

        var ateAqui = '<div>faturado até hoje (dia ' + diaAtual + '): <b>' + esc(brl(fat) || '—') + '</b></div>';

        if (diasFechados < MINIMO_DIAS) {
          /* ⚠️ o ponto da seção: com poucos dias, NÃO projeta. Número eufórico ou em pânico no
             dia 2 vira decisão de compra errada. */
          elCorpo.innerHTML = ateAqui +
            '<div style="margin-top:6px;padding:7px 10px;border:1px solid rgba(128,128,128,.35);' +
            'border-radius:8px;opacity:.85">ainda não dá pra projetar o fechamento: ' + diasFechados +
            ' dia(s) fechado(s) não formam ritmo. A partir do dia ' + (MINIMO_DIAS + 1) + ' a projeção aparece aqui.</div>';
          return;
        }

        /* ⚠️ Codex #628 (P2): HOJE AINDA NÃO ACABOU, nos dois sentidos. Dividir por 'diaAtual'
           contava o dia em curso como completo (subestima ~20% no dia 5). Mas a requisição vai
           até HOJE, então 'fat' já traz a venda parcial de hoje: dividir isso pelos dias
           FECHADOS inflava o ritmo (~20% no dia 6). O ritmo sai do faturamento dos dias
           fechados: total menos o de hoje (d.dias[hoje], mesma base valor_nota do total). */
        var fatHoje = (d.dias && d.dias[hoje] && Number(d.dias[hoje].fat)) || 0;
        var ritmo = (fat - fatHoje) / diasFechados;
        var previsto = ritmo * diasNoMes;

        elCorpo.innerHTML = ateAqui +
          '<div style="margin-top:4px">ritmo: <b>' + esc(brl(ritmo) || '—') + '</b> por dia</div>' +
          '<div style="margin-top:6px;padding:8px 10px;border:1px solid rgba(128,128,128,.35);' +
          'border-radius:8px">deve fechar o mês em <b style="font-size:15px">' + esc(brl(previsto) || '—') + '</b>' +
          '<div style="opacity:.75;margin-top:3px">projeção pelo ritmo dos ' + diasFechados + ' dias já fechados, ' +
          'sobre os ' + diasNoMes + ' dias deste mês — não considera sazonalidade nem campanha</div></div>';
      })
      .catch(function (e) {
        if (meu !== seq) return;
        bt.disabled = false;
        elCorpo.innerHTML = '⚠️ ' + esc((e && e.message) || e);
      });
  }

  bt.addEventListener('click', function () { carregar(true); });
  carregar(false);
})();`;
}

module.exports = { scriptDaProjecaoMes };
