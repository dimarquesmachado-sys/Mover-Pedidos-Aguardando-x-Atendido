/* 01/10 — O "Período…" NÃO PODE VARRER O BANCO SOZINHO.

   O dono clicou em "Período…" no painel da Girassol, não digitou nada, e os cards vieram
   preenchidos com 01/01/2000 → hoje: 26.172 pedidos buscados sem ninguém pedir. A causa era
   literal — `de = pDe || '2000-01-01'` —, um padrão de "sem filtro" que nessa tela vira
   varredura do histórico inteiro a cada clique.

   ⚠️ O QUE ESTE TESTE REALMENTE PROTEGE: a guarda ficar na FONTE. `intervalo()` é consumido em
   16 lugares em cada painel. Minha primeira tentativa foi pôr `if(!de) return` nos chamadores —
   consertei três e os outros treze seguiriam varrendo o banco. É o padrão de errar que já
   custou caro aqui: tratar sintoma em vez de causa. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

for (const arq of ['girassol-backup-offline/dashboard.html', 'amb-checkout-offline/amb-dashboard.html']) {
  const html = fs.readFileSync(path.join(__dirname, '..', arq), 'utf8');
  const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
  const quem = arq.split('/')[0];

  /* a varredura total não pode voltar, em NENHUMA das duas funções de janela */
  assert.ok(!/(pDe|anPDe)\s*\|\|\s*'2000-01-01'/.test(js),
    quem + ': voltou o `|| \'2000-01-01\'` — clicar em "Período…" varreria o histórico inteiro');

  /* a guarda está na fonte, com o período como parâmetro */
  assert.ok(/function intervaloDe\(periodo\)/.test(js),
    quem + ': sumiu `intervaloDe(periodo)` — é ela que permite devolver a janela do período ' +
    'anterior sem repetir guarda nos 16 chamadores');
  assert.ok(/function intervalo\(\)\{ return intervaloDe\(periodo\); \}/.test(js),
    quem + ': `intervalo()` deixou de delegar — os chamadores veriam comportamentos diferentes');
  assert.ok(/_perAnterior/.test(js), quem + ': sumiu a memória do período anterior');

  /* e o comportamento, exercitado na função DE PRODUÇÃO recortada da página */
  const i = js.indexOf('function intervalo(){');
  const fim = js.indexOf('\n}', js.indexOf('function intervaloDe(periodo){')) + 2;
  const corpo = js.slice(i, fim);
  const montar = (periodo, pDe, pAte, ant) => new Function('periodo', 'pDe', 'pAte', '_perAnterior', 'hojeSP', 'spDate',
    corpo + '; return intervalo;')(periodo, pDe, pAte, ant, () => '2026-10-01',
    (t) => new Date(t).toISOString().slice(0, 10));

  /* clicar em Período sem digitar: segue no período de onde veio */
  {
    const vindoDoAno = montar('custom', '', '', 'ano')();
    assert.strictEqual(vindoDoAno.de, '2026-01-01',
      quem + ': clicar em "Período…" sem digitar não manteve a janela anterior');
    assert.notStrictEqual(vindoDoAno.de, '2000-01-01', quem + ': varreu desde 2000');
  }

  /* com UMA data só, ainda não busca o período novo */
  {
    const meio = montar('custom', '2026-01-01', '', 'mes')();
    assert.strictEqual(meio.de, '2026-10-01',
      quem + ': começou a buscar com só uma data preenchida — o dono ainda está digitando');
  }

  /* com as duas, respeita */
  {
    const pronto = montar('custom', '2026-01-01', '2026-01-31', 'mes')();
    assert.deepStrictEqual(pronto, { de: '2026-01-01', ate: '2026-01-31' },
      quem + ': não respeitou as datas escolhidas');
  }

  /* e os períodos de sempre não podem ter mudado */
  assert.strictEqual(montar('ontem', '', '', 'mes')().de, '2026-09-30', quem + ': "Ontem" mudou');
  assert.strictEqual(montar('ano', '', '', 'mes')().de, '2026-01-01', quem + ': "Ano" mudou');
}

console.log('OK: "Periodo..." nao varre o banco sozinho, guarda na FONTE, periodos antigos intactos');
