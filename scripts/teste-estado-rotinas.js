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

console.log('OK: estado por empresa — isolado, referencia viva, formato intacto, AMB ligada sem reatribuir');
