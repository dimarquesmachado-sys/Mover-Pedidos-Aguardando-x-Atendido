/* 23/09 — NOME DA VARIAÇÃO. Achado pelo dono depois da primeira varredura profunda: procurar
   "lixas" não trazia as variações, que são JUSTAMENTE o que se conta na prateleira.
   A causa está no cadastro do Bling: a variação `10-lisa-125mm-100` tem Descrição "GRÃO:g100"
   — o nome completo ("10 X Lixas Disco Grão Liso 125mm…") mora só no PAI
   (`10-lisa-125mm-PAI-X`). O índice guardava "GRÃO:g100", que não contém "lixa"; e o SKU tem
   "lisa", não "lixa". Só o SKU exato funcionava, porque aquele caminho vai ao Bling, que
   devolve o nome montado.
   Conserto sem custo de cota: guarda id→nome de todo produto visto e o pai de cada variação;
   no FIM da varredura compõe "nome do pai + nome da variação" — assim funciona venha o pai
   antes ou depois na listagem. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const src = fs.readFileSync(path.join(raiz, 'girassol-backup-offline', 'ciclo.js'), 'utf8');

assert.ok(/_nomePorId\[it\.id\] = nome/.test(src),
  'a varredura não guarda id→nome — sem isso não há como compor o nome da variação');
assert.ok(/_paiDeSku\[sku/.test(src), 'a varredura não registra o pai de cada variação');

/* exercita a composição DE PRODUÇÃO, recortada do arquivo */
const bloco = /\/\* compõe o nome das variações[\s\S]*?\n  \}/.exec(src);
assert.ok(bloco, 'o passo de composição sumiu — as variações voltariam a ser inencontráveis por nome');
const compor = (novo, nomePorId, paiDeSku) => {
  const idxStatus = { abortou: false };
  new Function('novo', '_nomePorId', '_paiDeSku', 'idxStatus', bloco[0])(novo, nomePorId, paiDeSku, idxStatus);
  return idxStatus.nomes_compostos;
};

const PAI = 15962533049;
const NOME_PAI = '10 X Lixas Disco Grão Liso 125mm 5 Polegadas Lixadeira Politriz KaQi';
const montar = () => ({
  '7908840119810': { sku: '10-lisa-125mm-100', nome: 'GRÃO:g100', id: 16383405875 },
  'sku:PAI': { sku: '10-lisa-125mm-PAI-X', nome: NOME_PAI, id: PAI },
  'sku:SOLTO': { sku: 'SOLTO', nome: 'Martelete Demolidor', id: 999 },
});

{
  const novo = montar();
  const n = compor(novo, { [PAI]: NOME_PAI }, { '10-lisa-125mm-100': PAI });
  assert.strictEqual(n, 1, 'nenhum nome composto');
  assert.ok(novo['7908840119810'].nome.toLowerCase().includes('lixa'),
    'a variação continua sem o nome do pai — procurar "lixa" não a encontraria, e é ela que se conta');
  assert.ok(novo['7908840119810'].nome.endsWith('GRÃO:g100'),
    'a composição perdeu o grão — sem ele não dá pra distinguir uma variação da outra');
  assert.strictEqual(novo['sku:SOLTO'].nome, 'Martelete Demolidor',
    'produto sem pai foi alterado');

  /* rodar de novo não pode duplicar o prefixo */
  assert.strictEqual(compor(novo, { [PAI]: NOME_PAI }, { '10-lisa-125mm-100': PAI }), 0,
    'a composição repetida duplica o nome do pai');
}

{
  /* pai que não apareceu na varredura: deixa como está, não inventa */
  const novo = montar();
  compor(novo, {}, { '10-lisa-125mm-100': PAI });
  assert.strictEqual(novo['7908840119810'].nome, 'GRÃO:g100',
    'compôs com nome de pai inexistente');
}

/* a rota de depuração existe pras três: sem ela, consertar isto vira suposição — e cada
   suposição errada custa uma varredura de 3 horas pra descobrir */
const cat = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'rotas-catalogo.js'), 'utf8');
assert.ok(/debug-produto-cru\//.test(cat), 'a rota de depuração do produto cru sumiu');

/* Codex #520 (P2): o nome NÃO pode colidir com a `/debug-produto/` que a AMB e a GOOD já têm
   (aquela mostra estoque e localização). Esta lib é registrada ANTES dos handlers delas, então
   um nome repetido aqui derruba a ferramenta de diagnóstico das duas — e só se descobre na
   hora em que se precisa dela. */
assert.ok(!/startsWith\(prefixo \+ '\/debug-produto\/'\)/.test(cat),
  'a rota da lib voltou a se chamar /debug-produto/ e tapa a que a AMB e a GOOD já têm');
for (const arq of ['amb-checkout-offline/index.js', 'good-checkout-offline/index.js']) {
  const s2 = fs.readFileSync(path.join(raiz, arq), 'utf8');
  assert.ok(/debug-produto/.test(s2), arq + ': a rota própria de depuração sumiu');
}
assert.ok(/variacao: \(raw && raw\.variacao\)/.test(cat),
  'a depuração não mostra o campo `variacao` — que é exatamente o que precisa ser conferido');
assert.ok(/if \(!ehAdmin\(op\)\) \{ json\(res, 403/.test(cat), 'a depuração não exige admin');

console.log('OK: nome da variacao composto com o do pai — procurar "lixa" acha a variacao que se conta');
