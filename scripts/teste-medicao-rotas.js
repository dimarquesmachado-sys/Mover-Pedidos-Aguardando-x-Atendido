'use strict';
/* 17/09 — a MEDIÇÃO das rotas estava inflada, e o erro tinha risco junto. A regex casava com
   qualquer menção a `p === '/<empresa>/<rota>'`, e a GOOD tem uma lista de EXCEÇÕES do portão
   de sessão que cita várias rotas por nome. A `/backfill-status`, de 6 linhas, aparecia com 25
   de diferença porque eu capturava aquele bloco — e extrair "aquilo" teria movido a trava
   central de autenticação junto.

   O número de divergentes caiu de 21 para 6 quando a medição passou a contar DECLARAÇÃO em vez
   de menção. Este teste guarda essa distinção extraindo o CORPO de verdade (não só o nome da
   rota) e travando as rotas pesadas — que não entram nesta fase de extração e por isso não
   podem sumir do conjunto comum às três, ao contrário das quase-idênticas (Codex, 17/09). */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const ALVOS = [
  ['amb-checkout-offline/index.js', 'amb-checkout-offline'],
  ['girassol-backup-offline/gbo-app.js', 'girassol-backup-offline'],
  ['good-checkout-offline/index.js', 'good-checkout-offline'],
];

/* as rotas pesadas ficam de fora desta fase (viram o próximo ciclo.js) — diferente das
   quase-idênticas, elas não têm extração planejada, então continuam declaradas nas três */
/* Codex #501 (P2): `status` e `etiqueta-anexar` foram RECLASSIFICADAS como idêntica e quase
   idêntica — mantê-las aqui exigiria que a declaração continuasse em cada pasta, e é
   exatamente isso que a extração vai remover. O guarda passaria a reprovar o trabalho que ele
   deveria acompanhar, e alguém contornaria o vermelho. */
/* Codex #501 (P2, r2): o `backfill-status` volta. Eu o tirei olhando só o TAMANHO do corpo (7
   linhas, 4 de diferença), mas o que diverge nele é o CONTRATO DE RESPOSTA: a AMB e a Girassol
   devolvem { ok, status, ano }, a GOOD devolve o estado do backfill de vendas dela. São rotas
   com o mesmo nome e propósitos diferentes — extrair juntaria dois contratos num só. */
const DIVERGENTES = ['config-fiscal', 'sku-info', 'custo-sync', 'backfill-status'];

/* backfill-status não divergiu por TAMANHO — a razão de ficar de fora é outra (a lista de
   exceções do portão da GOOD já a citou por engano, ver o bloco dedicado logo abaixo), mas
   também não tem extração planejada e precisa continuar declarada nas três, como as acima.
   Ficou fora de DIVERGENTES pra não confundir com "as três que a nova medição aponta", mas
   sai do loop de baixo do mesmo jeito — senão amb e girassol perdem essa checagem. */
const PESADAS = ['backfill-status'];

/* declaração = `if (… p === … ) {` abrindo bloco no fim da linha.
   menção em lista de exceções termina com `||` e não abre bloco. */
function reDeclaracao(mod, rota) {
  return new RegExp(String.raw`^ *if \([^\n]*p === (?:R\('${rota}'\)|'/${mod}/${rota}')[^\n]*\{ *$`, 'm');
}

function declaradas(arq, mod) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const out = new Set();
  const re = new RegExp(String.raw`^ *if \([^\n]*p === (?:R\('([\w-]+)'\)|'/` + mod + String.raw`/([\w-]+)')[^\n]*\{ *$`, 'gm');
  let m;
  while ((m = re.exec(s))) out.add(m[1] || m[2]);
  return out;
}

/* Codex #501 (P2, r4): contar chave por CARACTERE CRU confunde código com comentário e string —
   um `}` dentro de uma mensagem de erro ou de um comentário explicando o próprio código fechava
   o bloco cedo demais, e o que viesse depois (a diferença de verdade) nunca era comparado.
   `paraContagem` devolve a linha sem o CONTEÚDO de comentário (bloco ou linha) e de string
   simples/dupla — só o que sobra conta como chave de código. As linhas ORIGINAIS continuam
   sendo o que `corpoDaRota` devolve; só a contagem que ignora esse texto.
   Não cobre template literal com `${}` nem regex — isso pediria um parser de verdade, e o
   arquivo já documenta abaixo (POR QUE ESTE TESTE NÃO GENERALIZA) que um heurístico que erra
   feio é pior que nenhum. Hoje nenhuma das rotas que passam por aqui (status, saude,
   backfill-status) usa template ou regex com chave no corpo — se um dia usar, o teste do
   tamanho/conteúdo abaixo vai denunciar. */
function paraContagem(linha, jaEmComentarioBloco) {
  let limpa = '';
  let emBloco = jaEmComentarioBloco;
  let i = 0;
  while (i < linha.length) {
    if (emBloco) {
      const fim = linha.indexOf('*/', i);
      if (fim === -1) { i = linha.length; break; }
      emBloco = false;
      i = fim + 2;
      continue;
    }
    const ch = linha[i];
    const prox = linha[i + 1];
    if (ch === '/' && prox === '*') { emBloco = true; i += 2; continue; }
    if (ch === '/' && prox === '/') break;   // resto da linha é comentário de linha
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < linha.length && linha[j] !== ch) { if (linha[j] === '\\') j++; j++; }
      i = j + 1;
      continue;
    }
    limpa += ch;
    i++;
  }
  return { limpa, emBloco };
}

/* extrai o CORPO da rota a partir da linha de DECLARAÇÃO (nunca da primeira menção), contando
   chaves até fechar no mesmo nível — é exatamente o passo que a medição original pulou */
function corpoDaRota(arq, mod, rota) {
  const linhas = fs.readFileSync(path.join(raiz, arq), 'utf8').split('\n');
  const re = reDeclaracao(mod, rota);
  const inicio = linhas.findIndex((l) => re.test(l));
  assert.ok(inicio >= 0, arq + ': declaração de /' + rota + ' não encontrada');
  let prof = 0;
  let fim = -1;
  let emComentarioBloco = false;
  for (let i = inicio; i < linhas.length && fim < 0; i++) {
    const { limpa, emBloco } = paraContagem(linhas[i], emComentarioBloco);
    emComentarioBloco = emBloco;
    for (const ch of limpa) {
      if (ch === '{') prof++;
      else if (ch === '}') { prof--; if (prof === 0) { fim = i; break; } }
    }
  }
  assert.ok(fim >= 0, arq + ': corpo de /' + rota + ' nunca fecha');
  return linhas.slice(inicio, fim + 1);
}

/* a lista de exceções da GOOD é o que enganava a medição — se ela mudar de forma, a medição
   precisa ser revista junto, e é por isso que o teste a vigia */
{
  const s = fs.readFileSync(path.join(raiz, 'good-checkout-offline/index.js'), 'utf8');
  assert.ok(/p === '\/good-checkout-offline\/[\w-]+' \|\|/.test(s),
    'a lista de exceções do portão sumiu ou mudou de forma — revisar a medição de rotas junto');
}

/* o corpo real de /backfill-status tem 6 linhas; a medição errada pegava a lista de exceções
   (25 de diferença). Corpo curto e com o sinal do handler real prova que a extração achou o
   bloco certo, não a lista */
{
  const corpo = corpoDaRota('good-checkout-offline/index.js', 'good-checkout-offline', 'backfill-status');
  /* o teto separa o corpo da rota (~6-13 linhas) do bloco de exceções (24+). Subiu de 10 pra
     15 em 17/09 porque a própria rota cresceu — ganhou a checagem de sessão e o comentário
     que a explica. O que o teto precisa distinguir continua valendo com folga. */
  assert.ok(corpo.length <= 15,
    'corpo de /backfill-status tem ' + corpo.length + ' linhas — a medição provavelmente pegou a lista de exceções do portão, não a rota');

  /* 17/09 — o tamanho pega o caso de hoje; o CONTEÚDO pega a classe. Um dia a lista de
     exceções pode encolher pra menos de 10 linhas e o teste passaria com o bloco errado.
     O que nunca pode acontecer é o corpo medido conter a trava de sessão. */
  const texto = corpo.join('\n');
  assert.ok(!/Sessão necessária\. Faça login\./.test(texto),
    'o corpo medido contém a TRAVA DE SESSÃO — extrair isso moveria a autenticação do módulo ' +
    'inteiro achando que era uma rota de status');
  assert.ok(!/shopee-sessao-cookies/.test(texto),
    'o corpo medido contém outras rotas — é a lista de exceções, não a declaração');
  /* 17/09 — a marca era `__bfGood`, a variável GLOBAL onde a GOOD guardava o status do
     backfill. Ela saiu (estado de empresa não mora em global — as três rodam no mesmo
     processo e a empresa nova copiaria o nome junto), então a marca passou a ser `_bfGood`,
     o estado do módulo que a substituiu. O que o teste prova continua o mesmo: que o corpo
     medido é o da ROTA e não o da lista de exceções do portão. */
  assert.ok(corpo.some((l) => l.includes('_bfGood')),
    'o corpo medido não cita o status do backfill — provavelmente não é o corpo da rota');
}

/* as divergentes não entram nesta fase — se sumirem da declaração de alguma das três, ou a
   rota foi perdida ou a medição quebrou. Ao contrário de um piso fixo sobre o total de rotas
   comuns, isto sobrevive à extração planejada das quase-idênticas sem falhar o CI. */
const conjuntos = ALVOS.map(([arq, mod]) => declaradas(arq, mod));
for (const rota of [...DIVERGENTES, ...PESADAS]) {
  ALVOS.forEach(([arq], i) => {
    assert.ok(conjuntos[i].has(rota),
      arq + ': /' + rota + ' não aparece mais como declaração — rota sumiu ou a medição quebrou');
  });
}

for (let i = 0; i < ALVOS.length; i++) {
  assert.ok(conjuntos[i].size >= 20,
    ALVOS[i][0] + ': só ' + conjuntos[i].size + ' rotas declaradas — a regex de medição provavelmente quebrou');
}

/* 17/09 — POR QUE ESTE TESTE NÃO GENERALIZA PARA TODAS AS ROTAS.
   Tentei estender a checagem a todas as rotas comuns e ela acusou três casos seguidos que
   eram LEGÍTIMOS: a /produto-fotos valida sessão dentro dela mesma (com a mesma mensagem), e
   a /ml-trocar-code cita outra rota no próprio corpo. O extrator por indentação é heurístico —
   ele não sabe onde a rota termina quando há blocos aninhados na mesma coluna.
   Um guarda que acusa o certo é pior que guarda nenhum: ensina a ignorar o vermelho. Então
   ele fica no caso PROVADO (a /backfill-status da GOOD, onde o mesmo nome aparece na lista de
   exceções e na declaração), que é exatamente a regressão que aconteceu. */

/* 17/09 — A MEDIÇÃO CAIU DE SEIS PRA TRÊS, e pelo mesmo tipo de erro da vez anterior: o
   script solto que eu usava delimitava o corpo por INDENTAÇÃO. Onde a rota tem bloco aninhado
   fechando na mesma coluna, ele engolia o que vinha depois — na GOOD, a /status (20 linhas)
   aparecia com 59 de diferença porque levava junto a /saude inteira, que as três têm.
   Este teste já conta CHAVES (conserto do Codex), e é por isso que ele não errou junto. O
   assert abaixo mantém a diferença medida honesta: se a /status voltar a "divergir", é o
   medidor que quebrou, não o código. */
{
  /* Codex #501 (P2): comparar TAMANHO deixava passar mudança de conteúdo — trocar um campo da
     resposta, uma condição ou uma chamada numa das empresas mantinha a contagem e o teste
     seguia verde. E eu ainda tolerava 4 linhas de folga, o que só piorava. Agora compara o
     corpo NORMALIZADO linha a linha: rótulo e slug da empresa viram marcador, o resto tem que
     ser igual. */
  /* Codex #501 (P2, r2) + o que o próprio teste mostrou: o \b antes de GIRABKP não casa quando
     o rótulo faz parte de um NOME DE ENV dentro de string — "AMBBKP_SYNC_ON" ficava intacto e
     a /saude parecia divergir nas duas empresas. Sem o \b final, o prefixo vira marcador em
     qualquer posição, e aí a diferença some: as três são IGUAIS nesta rota. */
  /* Codex #501 (P2, r3): mapear os TRÊS prefixos para o mesmo marcador em TODO arquivo escondia
     o erro de copiar e colar entre empresas — a mensagem da AMB citando GOODBKP normalizava
     igual e passava. Cada arquivo só pode ter o rótulo DELE normalizado; o rótulo de outra
     empresa ali dentro é justamente o bug que queremos ver. */
  const ROTULO = { 'amb-checkout-offline': 'AMBBKP', 'girassol-backup-offline': 'GIRABKP', 'good-checkout-offline': 'GOODBKP' };
  const semRotulo = (t, mod) => t.replace(new RegExp('\\b' + ROTULO[mod], 'g'), '_T_')
    .replace(new RegExp('\\b' + mod + '\\b', 'g'), '_M_')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('//'));

  /* o limite é o que o código É HOJE, medido: /status tem diferença ZERO entre as três, e
     /saude tem UMA linha (a Girassol confere o app de Expedição, que só ela tem). Tolerância
     folgada aqui não guarda nada — foi assim que a troca de `Object.keys` por `Object.values`
     passou batido na primeira versão deste guarda. */
  /* Codex #501 (P2, r2): eu tirei a /status do conjunto protegido PRA ELA PODER SER EXTRAÍDA e,
     na mesma rodada, escrevi um guarda que exige encontrá-la inline nas três — o `corpoDaRota`
     derruba o teste quando a declaração some. Na primeira extração dela, o CI ficaria vermelho
     por causa do trabalho que ele deveria acompanhar.
     Agora o guarda só age enquanto a rota ESTÁ inline: extraída, não há o que comparar, e a
     paridade passa a ser estrutural (uma lib só). */
  const LIMITE = { status: 0, saude: 0 };
  for (const [rota, limite] of Object.entries(LIMITE)) {
    /* Codex #501 (P2, r3): `every` virava false com a rota faltando em UMA empresa só, e o
       `continue` desligava a comparação em silêncio — que é exatamente o caso perigoso:
       extração pela metade ou apagamento acidental. Ou está inline nas TRÊS (compara), ou saiu
       das TRÊS (paridade estrutural). Meio a meio é erro e tem que reprovar. */
    const ondeEsta = ALVOS.filter(([arq, mod]) => {
      const linhas = fs.readFileSync(path.join(raiz, arq), 'utf8').split('\n');
      return linhas.some((l) => reDeclaracao(mod, rota).test(l));
    });
    assert.ok(ondeEsta.length === 0 || ondeEsta.length === ALVOS.length,
      '/' + rota + ' está inline em ' + ondeEsta.length + ' de ' + ALVOS.length + ' empresas (' +
      ondeEsta.map(([, m]) => m).join(', ') + '). Extração pela metade: ou a rota sai das três ' +
      'pra uma lib, ou fica nas três — do jeito que está, uma empresa mudou e as outras não.');
    if (ondeEsta.length === 0) {
      /* Codex #501 (P2, r4): "sumiu das três" pode ser extração (bom) ou apagamento
         (péssimo), e pular sem olhar trata os dois igual. Se virou lib, tem que existir um
         registrador em lib/checkout que cite a rota — senão não foi extração, foi perda. */
      const libs = fs.readdirSync(path.join(raiz, 'lib', 'checkout'))
        .filter((f) => f.endsWith('.js'))
        .filter((f) => new RegExp("prefixo \\+ '/" + rota + "'").test(
          fs.readFileSync(path.join(raiz, 'lib', 'checkout', f), 'utf8')));
      assert.ok(libs.length > 0,
        '/' + rota + ' sumiu das três pastas e nenhuma lib de lib/checkout a registra — ' +
        'não foi extração, foi perda: a rota deixou de existir.');
      continue;
    }
    const ref = semRotulo(corpoDaRota(ALVOS[0][0], ALVOS[0][1], rota).join('\n'), ALVOS[0][1]);
    for (let i = 1; i < ALVOS.length; i++) {
      const outro = semRotulo(corpoDaRota(ALVOS[i][0], ALVOS[i][1], rota).join('\n'), ALVOS[i][1]);
      const difs = ref.filter((l, k) => outro[k] !== l).length + Math.abs(ref.length - outro.length);
      /* a folga acabou: com o normalizador consertado, /status e /saude são IDÊNTICAS nas três.
         Eu ia dar 1 linha de folga à Girassol achando que a diferença era o app de Expedição —
         era só o nome da env na mensagem. Folga baseada em suposição é como guarda nenhum. */
      const lim = limite;
      assert.ok(difs <= lim,
        ALVOS[i][0] + ': /' + rota + ' difere em ' + difs + ' linha(s) da AMB (limite ' + lim + '). ' +
        'Ou o corpo mudou numa empresa só — e aí a correção tem que ir pras três —, ' +
        'ou o medidor voltou a engolir a rota seguinte.');
    }
  }
}

console.log('OK: medição de rotas — conta declaração e não menção, delimita o corpo por CHAVES (não por indentação) e trava as rotas pesadas que não saem desta fase');
