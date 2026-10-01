/* 01/10 — ESTADO DAS ROTINAS PESADAS POR EMPRESA.

   Este é o passo que faltava pra as rotas do painel virarem fábrica. Tentei extrair as rotas
   direto e não deu: elas PARECEM idênticas entre as empresas — `/completar-detalhes` e
   `/config-frete-magalu` não diferem em UMA LINHA entre AMB e Girassol —, mas carregam 13
   dependências do arquivo da empresa, e duas são ESTADO VIVO: `_cst` e `_vsy`.

   ⚠️ O QUE ESTE TESTE PROTEGE, e é a razão de a peça existir: estado vivo COMPARTILHADO entre
   empresas seria pior que a duplicação. A rodada de uma zeraria o contador da outra, e a trava
   "já está rodando" passaria a mentir — a mesma classe de erro do 503 de 13/09 que fez nascer
   a trava-pesada. */
const assert = require('assert');
const path = require('path');
const { estadoDe, zerar, emAndamento } = require(path.join(__dirname, '..', 'lib', 'checkout', 'estado-rotinas'));

/* 1) empresas ISOLADAS — o ponto inteiro da peça */
{
  zerar('amb'); zerar('good');
  const amb = estadoDe('amb');
  amb.custo.rodando = true; amb.custo.feitos = 42;
  assert.strictEqual(estadoDe('good').custo.rodando, false,
    'o estado vazou entre empresas — a rodada de uma marcaria a outra como rodando, e a trava ' +
    'de "já está em curso" passaria a mentir');
  assert.strictEqual(estadoDe('good').custo.feitos, 0, 'o contador vazou entre empresas');
}

/* 2) REFERÊNCIA VIVA, não cópia. O código que já existe faz `_cst.feitos++` direto; devolver
      cópia deixaria a tela mostrando "0 de 1.768" a rodada inteira — falha silenciosa. */
{
  const e1 = estadoDe('amb');
  e1.custo.feitos = 7;
  assert.strictEqual(estadoDe('amb').custo.feitos, 7,
    'estadoDe devolve CÓPIA — os contadores que o código já incrementa parariam em zero na tela');
  assert.strictEqual(estadoDe('amb').custo, e1.custo, 'o objeto não é o mesmo entre chamadas');
}

/* 3) O FORMATO É O MESMO que estava solto nos três arquivos. Campo a menos quebra a tela que
      já lê este objeto — `falhas_detalhe` em especial tem teste próprio desde o #490. */
{
  const e = estadoDe('conferencia');
  assert.deepStrictEqual(Object.keys(e.custo).sort(),
    ['falhas', 'falhas_detalhe', 'feitos', 'inicio', 'ok', 'rodando', 'total'],
    'o formato do estado de custo mudou — a tela de status lê estes campos pelo nome');
  assert.deepStrictEqual(Object.keys(e.vendas).sort(),
    ['atualizado_em', 'erro', 'rodando', 'total'], 'o formato do estado de vendas mudou');
  assert.ok(Array.isArray(e.custo.falhas_detalhe), 'falhas_detalhe precisa nascer lista');
}

/* 4) zerar afeta UMA empresa */
{
  estadoDe('amb').custo.rodando = true;
  estadoDe('good').custo.rodando = true;
  zerar('amb');
  assert.strictEqual(estadoDe('amb').custo.rodando, false, 'zerar não limpou a empresa pedida');
  assert.strictEqual(estadoDe('good').custo.rodando, true, 'zerar de uma empresa limpou a outra');
  zerar('good');
}

/* 5) empresa vazia é erro, não um balde silencioso onde tudo se mistura */
for (const ruim of ['', null, undefined, '   ']) {
  assert.throws(() => estadoDe(ruim), /empresa é obrigatória/,
    'estadoDe(' + JSON.stringify(ruim) + ') devia recusar — sem id, todas as empresas cairiam no mesmo estado');
}

/* 6) o diagnóstico de sobreposição enxerga as duas empresas */
{
  zerar('amb'); zerar('good');
  estadoDe('amb').custo.rodando = true;
  estadoDe('good').vendas.rodando = true;
  const fora = emAndamento();
  assert.strictEqual(fora.length, 2, 'emAndamento não listou as duas rotinas em curso');
  assert.ok(fora.some(x => x.empresa === 'amb' && x.rotina === 'custo'), 'faltou a rodada de custo da AMB');
  assert.ok(fora.some(x => x.empresa === 'good' && x.rotina === 'vendas'), 'faltou o sync de vendas da GOOD');
  zerar('amb'); zerar('good');
}

/* 7) a AMB usa a peça — e NÃO pode voltar a reatribuir `_cst` inteiro: trocar a referência
      desliga o arquivo do objeto compartilhado e a tela lê o antigo, parado em zero */
{
  const fs = require('fs');
  const amb = fs.readFileSync(path.join(__dirname, '..', 'amb-checkout-offline', 'index.js'), 'utf8');
  assert.ok(/require\(['"]\.\.\/lib\/checkout\/estado-rotinas['"]\)/.test(amb),
    'a AMB não usa a peça de estado');
  const codigo = amb.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/\b_cst\s*=\s*\{/.test(codigo),
    'a AMB voltou a TROCAR o objeto `_cst` inteiro — isso desliga o arquivo do estado ' +
    'compartilhado e a tela de status mostraria a rodada parada em zero enquanto ela roda');
}

/* 8) ⚠️ A ORDEM IMPORTA, e isto quebrou o boot de verdade. A primeira versão declarava a peça
      perto do `_cst` (linha 7601), mas o `_vsy` é usado na 5474 — 2.100 linhas ANTES. Deu
      "Cannot access '_estadoRotinas' before initialization" e o serviço não subia.
      `node --check` não pega ordem de inicialização; a bateria também não. Só o boot real
      pegou, depois de eu já ter subido o push. */
{
  const fs = require('fs');
  const amb = fs.readFileSync(path.join(__dirname, '..', 'amb-checkout-offline', 'index.js'), 'utf8');
  /* ⚠️ sem tirar os comentários, o PRÓPRIO comentário que explica este bug (que cita
     `_estadoRotinas` no texto) conta como uso e o teste acusa o que já está certo. Falso
     positivo ensina a ignorar o vermelho — pior que não ter o teste. Aconteceu agora. */
  const linhas = amb
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))   /* apaga o texto, mantém as linhas */
    .split('\n')
    .map(l => l.trim().startsWith('//') ? '' : l);
  const decl = linhas.findIndex(l => /_estadoRotinas\s*=\s*require/.test(l));
  const primeiroUso = linhas.findIndex(l => /_estadoRotinas/.test(l) && !/require/.test(l));
  assert.ok(decl >= 0, 'a AMB não declara a peça de estado');
  assert.ok(primeiroUso < 0 || decl < primeiroUso,
    'a peça de estado é USADA na linha ' + (primeiroUso + 1) + ' e só declarada na ' + (decl + 1) +
    ' — o serviço não sobe ("Cannot access before initialization"), e nem o node --check nem a ' +
    'bateria pegam isso');
}

/* 9) zerar mexe NO MESMO objeto: quem guardou a referência não pode ficar com a antiga */
{
  const e = estadoDe('amb');
  const cst = e.custo, vsy = e.vendas;
  cst.feitos = 5; cst.rodando = true; vsy.fase = 'x'; vsy.total = 9;
  const depois = zerar('amb');
  assert.strictEqual(depois, e, 'zerar trocou o objeto da empresa');
  assert.strictEqual(estadoDe('amb').custo, cst, 'zerar trocou a referência de custo');
  assert.strictEqual(estadoDe('amb').vendas, vsy, 'zerar trocou a referência de vendas');
  assert.strictEqual(cst.feitos, 0); assert.strictEqual(cst.rodando, false);
  assert.strictEqual(vsy.total, 0); assert.ok(!('fase' in vsy), 'campo extra sobrou após zerar');
  zerar('amb');
}


console.log('OK: estado por empresa — isolado, referencia viva, formato intacto, AMB ligada sem reatribuir');
