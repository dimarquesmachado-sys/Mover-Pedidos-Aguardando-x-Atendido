'use strict';
/* 17/09 — a MEDIÇÃO das rotas estava inflada, e o erro tinha risco junto: minha regex casava
   com qualquer MENÇÃO a `p === '/<empresa>/<rota>'`, e a GOOD tem uma lista de EXCEÇÕES do
   portão de sessão que cita várias rotas por nome. A `/backfill-status`, de 6 linhas de corpo,
   aparecia com 25 de diferença porque eu capturava aquele bloco — e extrair "aquilo" teria
   movido a TRAVA CENTRAL DE AUTENTICAÇÃO junto.

   ⚠️ Codex #493: a primeira versão deste teste comparava CONJUNTOS DE NOMES, e a regressão
   nunca foi sobre nomes — era sobre qual BLOCO o medidor escolhe quando o mesmo nome aparece
   duas vezes no arquivo. Agora ele extrai o corpo de verdade e confere que veio a declaração,
   não a lista de exceções.

   E não trava contagem mínima: esta fase MOVE declarações para handlers compartilhados de
   propósito, então exigir um piso faria o teste acusar exatamente o trabalho que ele deveria
   acompanhar. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const ALVOS = [
  ['amb-checkout-offline/index.js', 'amb-checkout-offline'],
  ['girassol-backup-offline/gbo-app.js', 'girassol-backup-offline'],
  ['good-checkout-offline/index.js', 'good-checkout-offline'],
];

/* A FUNÇÃO SOB TESTE: dado um arquivo e uma rota, devolve o CORPO da declaração.
   É esta escolha — qual bloco pegar — que estava errada e que o teste precisa exercitar. */
function corpoDaRota(texto, mod, nome) {
  const re = new RegExp(
    String.raw`^( *)if \([^\n]*p === (?:R\('` + nome + String.raw`'\)|'/` + mod + '/' + nome +
    String.raw`')[^\n]*\{ *$`, 'm');
  const m = re.exec(texto);
  if (!m) return null;
  const fim = texto.indexOf('\n' + m[1] + '}', m.index);
  if (fim < 0) return null;
  return texto.slice(m.index, fim);
}

/* 1. O CASO QUE PRODUZIU O ERRO: na GOOD, `backfill-status` aparece DUAS vezes — na lista de
   exceções do portão e na declaração da rota. O medidor tem que pegar a segunda. */
{
  const s = fs.readFileSync(path.join(raiz, 'good-checkout-offline/index.js'), 'utf8');
  const mencoes = (s.match(/p === '\/good-checkout-offline\/backfill-status'/g) || []).length;
  assert.ok(mencoes >= 2,
    'esperava que /backfill-status aparecesse na lista de exceções E na declaração — ' +
    'se isso mudou, a armadilha mudou de forma e a medição precisa ser revista');

  const corpo = corpoDaRota(s, 'good-checkout-offline', 'backfill-status');
  assert.ok(corpo, 'o medidor não achou a declaração de /backfill-status na GOOD');

  /* a prova: o corpo NÃO pode conter a trava de sessão nem as outras rotas da lista */
  assert.ok(!/Sessão necessária\. Faça login\./.test(corpo),
    'o medidor pegou a LISTA DE EXCEÇÕES: o corpo contém a trava central de sessão. ' +
    'Extrair isso moveria a autenticação do módulo inteiro achando que era uma rota de status');
  assert.ok(!/shopee-sessao-cookies/.test(corpo),
    'o corpo contém outras rotas — é a lista de exceções, não a declaração');
  assert.ok(corpo.split('\n').length < 15,
    'o corpo de /backfill-status tem ~6 linhas; veio ' + corpo.split('\n').length +
    ' — sinal de que o medidor capturou o bloco errado');
}

/* 2. O corpo extraído tem que ser plausível em TODAS as rotas comuns: nenhuma pode arrastar a
   trava de sessão junto. É a forma geral do mesmo erro. */
{
  const arquivos = ALVOS.map(([arq, mod]) => [mod, fs.readFileSync(path.join(raiz, arq), 'utf8')]);
  const declaradas = (texto, mod) => {
    const re = new RegExp(String.raw`^ *if \([^\n]*p === (?:R\('([\w-]+)'\)|'/` + mod +
      String.raw`/([\w-]+)')[^\n]*\{ *$`, 'gm');
    const out = new Set();
    let m;
    while ((m = re.exec(texto))) out.add(m[1] || m[2]);
    return out;
  };
  const conjuntos = arquivos.map(([mod, texto]) => declaradas(texto, mod));
  const comuns = [...conjuntos[0]].filter(r => conjuntos[1].has(r) && conjuntos[2].has(r));

  for (const [mod, texto] of arquivos) {
    for (const nome of comuns) {
      const corpo = corpoDaRota(texto, mod, nome);
      if (!corpo) continue;
      assert.ok(!/Sessão necessária\. Faça login\./.test(corpo),
        mod + ': o corpo medido de /' + nome + ' contém a trava de sessão — o medidor pegou o bloco errado');
    }
  }
}

console.log('OK: medição de rotas — o medidor extrai a DECLARAÇÃO e não a lista de exceções, e nenhum corpo medido arrasta a trava de sessão');
