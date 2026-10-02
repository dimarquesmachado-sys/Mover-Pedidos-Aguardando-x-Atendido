/* 02/10 — POR CANAL e TOP PRODUTOS no painel da GOOD.

   Pedido do dono: "segue criando os cards todos e acessos, botões todos multiloja e que funcione
   pra GOOD".

   ⚠️ A PRIMEIRA TENTATIVA FOI COPIAR O PAINEL DA AMB POR CIMA, e é a lição que este teste
   guarda: a cópia passou no `node --check` e deixou SETE testes vermelhos de uma vez. A GOOD
   abre no DIA (a Girassol abre no mês, por pedido do dono), decide "alíquota apurada" pela
   presença na tabela, e tem o cuidado com card vazio — copiar apagava os três. Desfiz e
   acrescentei no lugar certo, dentro do `pintarCards` que a GOOD já tinha.

   Painel igual não é painel COPIADO: é o mesmo recurso respeitando o que cada empresa já
   aprendeu. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const tela = fs.readFileSync(path.join(__dirname, '..', 'good-checkout-offline', 'dashboard.html'), 'utf8');

assert.ok(/function pintarQuebras/.test(tela), 'sumiu o pintarQuebras da GOOD');
assert.ok(/id="quebras"/.test(tela), 'sumiu o contêiner — a função desenharia no vazio');

/* ⚠️ os comportamentos PRÓPRIOS da GOOD que a cópia teria apagado */
/* ⚠️ eu tinha posto aqui um assert de `UI_BUILD` e ele falhou: o DASHBOARD da GOOD não tem
   essa marca (quem tem é o `painel.html`). Supus em vez de conferir — o erro que a regra da
   casa chama de "ler o produtor antes de escrever o consumidor". */
assert.ok(!/amb-checkout-offline/.test(tela),
  'o painel da GOOD aponta pro prefixo da AMB — chamaria as rotas da outra empresa');
assert.ok(!/AMBTotal/.test(tela), 'sobrou o nome da AMB no painel da GOOD');

/* o comportamento, com a função COMO ESTÁ no arquivo */
const m = tela.match(/function pintarQuebras[\s\S]*?\n\}/);
assert.ok(m, 'não consegui recortar a função');
let _html = '';
const amb = {
  esc: x => String(x == null ? '' : x),
  BRL: v => 'R$ ' + Number(v || 0).toFixed(2),
  PCT: v => Number(v || 0).toFixed(1) + '%',
  document: { getElementById: (id) => id === 'quebras' ? { set innerHTML(v) { _html = v; } } : null },
};
const pintar = new Function('esc', 'BRL', 'PCT', 'document',
  m[0] + '; return pintarQuebras;')(amb.esc, amb.BRL, amb.PCT, amb.document);

/* ⚠️ A FORMA REAL DA RESPOSTA, que é o que o Codex pegou no #579: `canais` e `skus` vêm
   IRMÃOS de `totais`, não dentro dele. Meu teste montava o objeto achatado e passava; o painel
   chamava `pintarQuebras(d.totais)` e as duas seções nasceriam SEMPRE VAZIAS, sem erro na tela
   — pareceria "a GOOD não tem dado". Teste que inventa a forma do dado não testa nada. */
assert.ok(/pintarQuebras\(d\);/.test(tela),
  'o painel voltou a passar só `d.totais` — `canais` e `skus` ficariam de fora e as seções ' +
  'nasceriam vazias, sem erro nenhum');

/* `skus` real é ARRAY de registros (lib/checkout/historico.js), cortado por margem; o ranking por
   faturamento vem em `skus_top_fat`. Denominador do produto é `totais.produtos`. */
pintar({ totais: { faturamento: 1000, produtos: 800 }, canais: { ml: { fat: 600 }, shopee: 300, '': 100 },
         skus: [{ sku: 'MARGEM-ALTA', fat: 10 }],
         skus_top_fat: [{ sku: 'GLOBO12', fat: 250 }, { sku: 'PT-06', fat: 400 }] });
assert.ok(/PT-06/.test(_html) && /GLOBO12/.test(_html), 'não mostrou o SKU (usou o índice do array?)');
assert.ok(!/MARGEM-ALTA/.test(_html), 'ignorou skus_top_fat e usou o array cortado por margem');
assert.ok(/50\.0%/.test(_html), 'percentual do produto não usa totais.produtos (400/800)');
/* sem skus_top_fat (servidor antigo): cai no array */
pintar({ totais: { faturamento: 1000 }, skus: [{ sku: 'ARR-1', fat: 100 }] });
assert.ok(/ARR-1/.test(_html), 'fallback para o array skus falhou');
pintar({ totais: { faturamento: 1000, produtos: 800 }, canais: { ml: { fat: 600 }, shopee: 300, '': 100 },
         skus_top_fat: [{ sku: 'GLOBO12', fat: 250 }, { sku: 'PT-06', fat: 400 }] });
/* troca de período limpa as seções antes e na falha */
assert.ok(/getElementById\('quebras'\)[^\n]*innerHTML = ''/.test(tela), 'carregar() não limpa #quebras ao iniciar');
assert.ok(/60\.0%/.test(_html),
  'o percentual não bate: o faturamento tem que vir de `totais`, que é onde ele está de verdade');
assert.ok(/Por Canal/.test(_html), 'não desenhou Por Canal');
assert.ok(/Top 15/.test(_html), 'não desenhou o Top de produtos');
assert.ok(/outro/.test(_html), 'canal sem nome sumiu da conta em vez de virar "outro"');
assert.ok(_html.indexOf('600') < _html.indexOf('300'), 'não ordenou por valor');

/* ⚠️ SEM DADOS NÃO PODE QUEBRAR nem mostrar bloco vazio: a GOOD é a empresa que acabou de
   ganhar estas seções, e período sem venda é o caso comum enquanto o histórico não cobre tudo. */
_html = 'sujeira';
pintar({ totais: { faturamento: 0 } });
assert.strictEqual(_html, '', 'período sem dados desenhou bloco vazio — card vazio é pior que card ausente');
_html = 'sujeira';
pintar({});
assert.strictEqual(_html, '', 'resposta sem os campos quebrou ou sujou a tela');

/* 02/10 — POR DIA, a terceira seção (mesmo PR do Por Canal / Top produtos, segunda leva). */
{
  _html = '';
  pintar({ totais: { faturamento: 1000 }, canais: { ml: 600 }, skus: { 'X': 400 },
           dias: { '2026-09-30': { fat: 300, pedidos: 4, mar: 90 },
                   '2026-10-01': { fat: 600, pedidos: 9, mar: 150 },
                   '2026-09-29': { fat: 100, pedidos: 2, mar: 20 } } });
  assert.ok(/Faturamento por Dia/.test(_html), 'não desenhou a seção por dia');
  assert.ok(_html.indexOf('29/09') < _html.indexOf('30/09'),
    'os dias não saem em ordem de data — a leitura do mês fica embaralhada');
  assert.ok(/width:100%/.test(_html),
    'a barra do MAIOR dia não chega a 100% — é ela que dá a escala pro resto');
  assert.ok(/9 ped/.test(_html) && /25\.0%/.test(_html),
    'sumiram pedidos ou margem do dia — o faturamento sozinho não diz se o dia foi bom');

  /* ⚠️ sem dias, nada é desenhado: período sem venda é o caso comum na GOOD enquanto o
     histórico não cobre tudo, e bloco vazio é pior que bloco ausente */
  _html = 'sujeira';
  pintar({ totais: { faturamento: 0 } });
  assert.strictEqual(_html, '', 'sem dias desenhou bloco vazio');
}

console.log('OK: painel da GOOD ganhou Por Canal e Top produtos, sem perder o que era dela');
