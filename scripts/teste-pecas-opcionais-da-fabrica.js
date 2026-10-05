/* 05/10 — PEÇA OPCIONAL QUE A EMPRESA NÃO PASSA FALHA EM SILÊNCIO.

   Classe descoberta no P1 do #622. A fábrica confere no boot só `empresa`, `prefixo` e `pecas` —
   NÃO as peças de dentro. As que chegam por `cfg.pecas.X` e têm `|| null` passam batidas: a rota
   funciona, responde 200, e faz MENOS do que devia.

   O caso real: ao remover a cópia do `custos-manuais` da AMB, `skuInfoCache` deixou de ser
   passado. Mudar um custo manual limpava só o cache de DISCO; as entradas em MEMÓRIA seguiam
   servindo o custo ANTIGO por até 6h de TTL. O dono corrigia o custo, a tela confirmava, e a
   margem continuava velha — número errado, que a regra da casa trata como pior que número
   ausente.

   ⚠️ E O RISCO É DE QUEM VEM DEPOIS: a Girassol ainda responde essa rota pela cópia, então hoje
   não tem bug — mas no dia em que a cópia sair, repetiria o mesmo em silêncio. Por isso as três
   passam o cache AGORA, antes de precisar.

   Este teste exige: toda peça que a fábrica lê de `cfg.pecas` ou é CONFERIDA por ela (com recusa
   clara), ou tem um PADRÃO de fonte conhecida, ou é passada pelas três empresas. O que não se
   encaixa em nenhum dos três vira buraco silencioso.

   Marcador estável [PECA-OPC]. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
const fab = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'fabrica-rotas-painel.js'), 'utf8');

const usadas = [...new Set([...fab.matchAll(/cfg\.pecas\.(\w+)/g)].map((m) => m[1]))];
assert.ok(usadas.length > 0,
  '[PECA-OPC] não achei nenhuma peça lida de `cfg.pecas` — o teste virou decoração');

/* peça com PADRÃO de fonte conhecida não precisa ser passada: a fábrica resolve sozinha */
const temPadrao = (p) => new RegExp('cfg\\.pecas\\.' + p + "\\s*\\|\\|\\s*require").test(fab);
/* peça CONFERIDA: a fábrica recusa explicitamente quando falta */
const confere = (p) => new RegExp('if \\(!\\s*cfg\\.pecas\\.' + p).test(fab);

/* ⚠️ a janela é o BLOCO `pecas: { … }`, não a chamada inteira. Minha 1ª versão pegava a chamada
   toda — e na AMB e na GOOD ela engloba também o `_ctxCusto`, que MENCIONA `skuInfoCache`. Com
   isso, tirar a peça do bloco não derrubava o teste: o nome continuava aparecendo ali do lado.
   Duas das três mutações passaram batidas até eu olhar por quê. */
function blocoDasPecas(fonte) {
  const i = fonte.indexOf('criarRotasPainel');
  if (i < 0) return '';
  const iP = fonte.indexOf('pecas:', i);
  if (iP < 0) return '';
  let prof = 0;
  const j = fonte.indexOf('{', iP);
  for (let k = j; k < fonte.length; k++) {
    if (fonte[k] === '{') prof++;
    else if (fonte[k] === '}') { prof--; if (prof === 0) return fonte.slice(iP, k + 1); }
  }
  return fonte.slice(iP);
}

const EMPRESAS = [
  ['AMB', 'amb-checkout-offline/index.js'],
  ['GOOD', 'good-checkout-offline/index.js'],
  ['Girassol', 'girassol-backup-offline/gbo-app.js'],
];

for (const peca of usadas) {
  if (temPadrao(peca) || confere(peca)) continue;

  const semPassar = [];
  for (const [emp, arq] of EMPRESAS) {
    const bloco = blocoDasPecas(fs.readFileSync(path.join(raiz, arq), 'utf8'));
    if (!bloco) continue;                       /* empresa que ainda não usa a fábrica */
    /* ⚠️ sem COMENTÁRIOS e procurando a PASSAGEM, não a menção. Meus próprios comentários
       explicando o bug citam `skuInfoCache` 7 vezes no bloco da AMB — contar menção fazia o teste
       dizer "está passando" com a peça removida. Duas de três mutações passavam batidas. */
    const semComentario = bloco.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const passa = new RegExp('(^|[,{\\s])' + peca + '\\s*[,:}]|get\\s+' + peca + '\\s*\\(').test(semComentario);
    if (!passa) semPassar.push(emp);
  }

  assert.deepStrictEqual(semPassar, [],
    '[PECA-OPC] a fábrica usa `' + peca + '` mas ' + semPassar.join(' e ') + ' não passa(m) — e ' +
    'ninguém confere: a rota responde 200 fazendo MENOS do que devia, sem erro nenhum. Foi assim ' +
    'que `skuInfoCache` sumiu na AMB (#622) e a margem ficou velha por 6h. Passe a peça, dê um ' +
    'padrão de fonte conhecida (`cfg.pecas.X || require(...)`) ou faça a fábrica RECUSAR sem ela.');
}

console.log('OK: toda peca opcional da fabrica e conferida, tem padrao, ou e passada pelas 3 empresas');
