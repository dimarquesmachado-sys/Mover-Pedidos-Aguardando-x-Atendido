/* 01/10 — PERÍODO LIVRE NO PAINEL DA GOOD.

   O dono: "percebi q não consigo filtrar um mês específico... um período específico". A
   Girassol e a AMB têm seletor de data; só a GOOD não tinha — e é a empresa cujo histórico ele
   está reconstruindo agora. Sem período livre não dá pra abrir um mês do backfill e conferir
   se entrou certo, que é justamente o que ele vai querer fazer quando a rodada acabar.

   O que este teste protege: os dois jeitos de a tela MENTIR mostrando vazio — abrir sem data
   (cairia em "hoje até hoje") e data invertida (devolveria intervalo impossível). Nos dois o
   dono veria zero e concluiria que o mês não tem venda. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'good-checkout-offline', 'dashboard.html'), 'utf8');
const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');

/* o JS da página compila (o `verifica` já faz isso, mas aqui o teste depende disso pra seguir) */
new Function(js);

assert.ok(/\['custom','Escolher'\]/.test(js), 'sumiu o período livre da lista de períodos da GOOD');
assert.ok(/type="date" id="pDe"/.test(js) && /type="date" id="pAte"/.test(js),
  'sumiram os campos de data do período livre');

/* a janela do período livre, exercitada como está na página */
const corpo = js.slice(js.indexOf('function janela('), js.indexOf('function pintarPeriodos('));
const montar = (de, ate) => new Function('hojeSP', 'spDate', 'P_DE', 'P_ATE', corpo + '; return janela;')(
  () => '2026-10-01', () => '', de, ate);

{
  const j = montar('2026-01-01', '2026-01-31')('custom');
  assert.deepStrictEqual(j, { de: '2026-01-01', ate: '2026-01-31' },
    'o período livre não respeita as datas escolhidas');
}

/* data invertida é erro de digitação, não pedido: troca em vez de devolver intervalo
   impossível, que mostraria a tela vazia e faria o dono achar que o mês não tem venda */
{
  const j = montar('2026-03-15', '2026-02-10')('custom');
  assert.deepStrictEqual(j, { de: '2026-02-10', ate: '2026-03-15' },
    'data invertida não foi corrigida — a tela viria vazia e pareceria mês sem venda');
}

/* os períodos antigos não podem ter mudado de comportamento */
{
  const j = montar('', '')('ano');
  assert.strictEqual(j.de, '2026-01-01', 'o período "Ano" mudou');
  const m = montar('', '')('mes');
  assert.strictEqual(m.de, '2026-10-01', 'o período "Mês" mudou');
}

/* e `trocar('custom')` preenche o mês passado ANTES de carregar: sem isso a janela cai em
   "hoje até hoje" e a tela abre zerada */
{
  assert.ok(/if\(p === 'custom'\)\{\s*if\(!P_DE && !P_ATE\)/.test(js),
    'o período livre não se inicializa — abriria em "hoje até hoje" e mostraria zero');
  assert.ok(/P_DE = y2 \+ '-' \+ m2 \+ '-01'/.test(js),
    'a inicialização não começa no primeiro dia do mês passado');
}

/* Codex #551: a troca de datas invertidas é gravada em P_DE/P_ATE (não só na janela), e o corte
   de 60.000 linhas do servidor vira aviso na tela em vez de omitir as vendas recentes em silêncio */
{
  assert.ok(/if\(P_DE > P_ATE\)\{ const t = P_DE; P_DE = P_ATE; P_ATE = t; \}/.test(js),
    'a ordem corrigida não é gravada em P_DE/P_ATE — os campos seguiriam invertidos');
  assert.ok(/function pintarAvisos\(t, truncado\)/.test(js) && /pintarAvisos\(d\.totais, d\.truncado\)/.test(js),
    'o aviso de período truncado não chega na tela');
  const srv = fs.readFileSync(path.join(__dirname, '..', 'lib', 'checkout', 'historico.js'), 'utf8');
  assert.ok(/truncado: offset >= 60000/.test(srv), 'o servidor não sinaliza o corte de 60.000 linhas');
}

console.log('OK: periodo livre na GOOD — respeita as datas, corrige invertida, abre no mes passado');
