/* 04/10 — A TELA DE LOCALIZAÇÃO ENGOLIA O MOTIVO DA FALHA.

   Caso real: o estoquista não conseguiu salvar a localização e, por isso, não conseguiu
   finalizar dois pedidos da Girassol (123037 e 123048) — o checkout BLOQUEIA a impressão
   enquanto houver item sem local. A tela só dizia "Falha ao salvar <SKU> — tente de novo".

   A rota responde POR QUE falhou, e cada motivo pede uma ação diferente:
     · "não consegui consultar o Bling agora (HTTP 401)" → token vencido: repetir não resolve;
     · "(HTTP 429)" → cota estourada: repetir resolve;
     · "produto não encontrado p/ SKU X" → o código não existe no Bling: repetir nunca resolve;
     · "Sessão necessária. Faça login." → a sessão caiu: tem que logar de novo.
   Virando tudo "tente de novo", o estoquista repete o que nunca vai dar certo e o pedido para.

   ⚠️ O `.catch(()=>null)` também apagava falha de rede/sessão — o erro agora vem junto. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const TELAS = [
  ['Girassol', 'girassol-backup-offline/painel.html'],
  ['AMB', 'amb-checkout-offline/painel.html'],
  ['GOOD', 'good-checkout-offline/painel.html'],
];

for (const [emp, cam] of TELAS) {
  const s = fs.readFileSync(path.join(raiz, cam), 'utf8');

  assert.ok(/salvarLocForce/.test(s), emp + ': sumiu o popup de localização obrigatória');

  /* o motivo da rota precisa chegar na tela */
  assert.ok(/\(r && r\.erro\) \? r\.erro/.test(s),
    emp + ': a tela voltou a engolir o motivo da falha — o estoquista fica repetindo uma ação ' +
    'que nunca vai dar certo e o pedido trava no checkout');

  assert.ok(!/toast\('Falha ao salvar '\+sku\+' — tente de novo'\)/.test(s),
    emp + ': o "tente de novo" genérico voltou');

  /* ⚠️ existem TRÊS telas que salvam localização no mesmo arquivo: a do CHECKOUT (a que travou
     os pedidos), a da separação e a da busca de produto. As outras duas já mostravam `r.erro`;
     a do checkout era a única que engolia. O teste mira a do checkout — a regex solta acusava as
     três e dava falso positivo, que ensina a ignorar o vermelho. */
  const iChk = s.indexOf('async function salvarLocForce');
  /* ⚠️ janela FIXA alcançava a função seguinte e acusava o `.catch` dela — falso positivo. Corta
     no fim da própria função (a primeira linha que fecha no nível zero). */
  const fimChk = s.indexOf('\n}', iChk);
  const trecho = s.slice(iChk, fimChk > iChk ? fimChk : iChk + 1200);
  /* ⚠️ e sem contar COMENTÁRIO: o teste estava acusando o meu próprio comentário, que CITA o
     `.catch(()=>null)` pra explicar por que ele saiu. Falso positivo, de novo. */
  const semComentario = trecho.split('\n')
    .filter((l) => /\.catch\(/.test(l) ? /postJson|await/.test(l) : true)
    .join('\n');
  assert.ok(!/\.catch\(\(\)=>null\)/.test(semComentario),
    emp + ': o .catch(()=>null) voltou no salvamento do CHECKOUT — falha de rede ou sessão ' +
    'sumiria sem explicação, e é justamente o que trava o pedido');
}

console.log('OK: as 3 telas mostram o motivo real da falha ao salvar localizacao');
