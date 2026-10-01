/* 01/10 — O PROGRESSO DENTRO DO MÊS, no status da GOOD.

   O dono disparou o backfill do ano e ficou olhando o status repetir o MESMO texto por 15-20
   min, sem saber se andava ou tinha travado. O `_bfGood` é uma foto tirada ao começar o mês e
   não se mexe até ele acabar. O gbo já mantinha o estado vivo (página, pedidos, gravados, fase)
   e o expunha em `backfillEstado()` — faltava mostrar.

   ⚠️ O QUE ESTE TESTE PROTEGE DE VERDADE: o gbo é COMPARTILHADO com a Girassol. Mostrar o
   progresso dela no status da GOOD seria pior que não mostrar nada — o dono leria números de
   outra empresa achando que são os dele, e "número errado é pior que número ausente". */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'good-checkout-offline', 'index.js'), 'utf8');
const i = src.indexOf('function _bfStatusComProgresso');
assert.ok(i > 0, 'sumiu o helper de progresso do status da GOOD');
const corpo = src.slice(i, src.indexOf('\n}', src.indexOf('catch (e)', i)) + 2);

const montar = (vivo, ano) => new Function('require', '_bfGoodAno',
  corpo + '; return _bfStatusComProgresso;')(() => ({ backfillEstado: () => vivo }), ano || { rodando: false });

const base = { estado: 'rodando', de: '2026-01-01', ate: '2026-01-31' };

/* o caso bom: é a GOOD, é este mês, está rodando */
{
  const r = montar({ rodando: true, empresa: 'good', de: '2026-01-01', fase: 'pedidos', pagina: 7, pedidos: 412, gravados: 380, erros: 0 })(base);
  assert.ok(r.progresso, 'o status não mostra o progresso — o dono fica 20 min sem saber se anda');
  assert.strictEqual(r.progresso.pedidos, 412, 'não trouxe os pedidos do estado vivo');
  assert.strictEqual(r.progresso.pagina, 7, 'não trouxe a página');
}

/* ⚠️ a GIRASSOL rodando não pode aparecer aqui: o gbo é compartilhado */
{
  const r = montar({ rodando: true, empresa: 'girassol', de: '2026-03-01', fase: 'pedidos', pagina: 20, pedidos: 3000 })(base);
  assert.ok(!r.progresso,
    'mostrou o progresso da GIRASSOL no status da GOOD — o dono leria números de outra empresa ' +
    'como se fossem os dele');
}

/* outro mês da própria GOOD também não: seria o mês errado na tela */
{
  const r = montar({ rodando: true, empresa: 'good', de: '2026-02-01', fase: 'pedidos', pedidos: 99 })(base);
  assert.ok(!r.progresso, 'mostrou o progresso de OUTRO mês');
}

/* mês já terminado não mostra progresso vivo */
{
  const r = montar({ rodando: true, empresa: 'good', de: '2026-01-01', pedidos: 1 })({ estado: 'ok', de: '2026-01-01' });
  assert.ok(!r.progresso, 'mostrou progresso num mês que já acabou');
}

/* e o diagnóstico NUNCA pode derrubar o status: se o gbo estourar, a resposta sai mesmo assim */
{
  const f = new Function('require', '_bfGoodAno', corpo + '; return _bfStatusComProgresso;')(
    () => { throw new Error('boom'); }, { rodando: false });
  const r = f(base);
  assert.strictEqual(r.estado, 'rodando',
    'o status quebrou porque o progresso falhou — é informação extra, não pode derrubar a rota ' +
    'que o dono usa justamente quando algo está estranho');
}

console.log('OK: status da GOOD mostra o progresso vivo do mes, e NUNCA o da Girassol');
