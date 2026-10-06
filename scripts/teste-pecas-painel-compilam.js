/* 05/10 — CRASE DENTRO DO TEMPLATE FECHA A STRING — me pegou CINCO vezes no mesmo dia.

   Toda peça `lib/checkout/painel-*.js` devolve o script do navegador dentro de um template
   literal (crase). Quando eu escrevo um comentário citando um identificador entre crases —
   `skuInfoCache`, `p180`, `fresh=1` — a crase FECHA a string e o arquivo para de compilar.

   Aconteceu em 5 peças diferentes ao longo do dia. `node --check` pega na hora, mas só se eu
   rodar; e o custo não é o erro, é o tempo de ida e volta.

   Este teste roda sobre TODAS as peças de painel, não sobre a que eu lembrei de conferir:
     · o arquivo compila;
     · o script que ela GERA compila (é o que vai pro navegador);
     · nenhuma crase sobra dentro do template.

   ⚠️ Descobre as peças pelo diretório, não por lista: peça nova entra coberta sozinha.

   Marcador estável [PECA-COMPILA]. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'lib', 'checkout');
const pecas = fs.readdirSync(dir).filter((f) => /^painel-.*\.js$/.test(f));

assert.ok(pecas.length >= 5,
  '[PECA-COMPILA] achei só ' + pecas.length + ' peça(s) de painel — o teste viraria decoração');

const PREFIXOS = ['/good-checkout-offline', '/amb-checkout-offline', '/girassol-backup-offline'];
const quebradas = [];

for (const fn of pecas) {
  const caminho = path.join(dir, fn);

  /* 1) o módulo em si carrega */
  let mod;
  try { delete require.cache[require.resolve(caminho)]; mod = require(caminho); }
  catch (e) { quebradas.push(fn + ' — não carrega: ' + String(e.message).slice(0, 70)); continue; }

  /* 2) a função geradora existe */
  const gerar = Object.values(mod).find((v) => typeof v === 'function');
  if (!gerar) { quebradas.push(fn + ' — não exporta função geradora'); continue; }

  for (const pref of PREFIXOS) {
    let script;
    try { script = gerar(pref); }
    catch (e) { quebradas.push(fn + ' (' + pref + ') — gerar falhou: ' + String(e.message).slice(0, 60)); continue; }

    /* 3) ⚠️ o que VAI PRO NAVEGADOR compila */
    try { new Function(script); }
    catch (e) {
      quebradas.push(fn + ' (' + pref + ') — o script gerado NÃO COMPILA: ' + String(e.message).slice(0, 70) +
        '. Costuma ser crase num comentário dentro do template literal, que fecha a string.');
      continue;
    }

    /* 4) e o prefixo é o da empresa pedida */
    if (!script.includes(pref)) quebradas.push(fn + ' (' + pref + ') — script sem o prefixo da empresa');
    for (const outro of PREFIXOS) {
      if (outro !== pref && script.includes(outro)) {
        quebradas.push(fn + ' (' + pref + ') — carrega o prefixo de ' + outro + ': chamaria a loja errada');
      }
    }
  }
}

assert.deepStrictEqual(quebradas, [],
  '[PECA-COMPILA] peças de painel com problema:\n  ' + quebradas.join('\n  '));

console.log('OK: as ' + pecas.length + ' pecas de painel compilam e geram script valido nas 3 empresas');
