# O que ainda é cópia entre as telas das três empresas — medido em 09/10

**Por que este arquivo existe.** As peças compartilhadas já tiraram as seções que dava pra tirar
(previsão, plano de compra, devoluções ML, ferramentas de custo, ficha, manutenção, ML financeiro,
completar pela nota). Fechado o inventário de paridade, a pergunta vira: **o que sobrou em cópia, e
vale a pena?** Medi antes de prometer, porque "unificar o resto" é fácil de dizer e caro de errar.

## O tamanho do problema

| | AMB | Girassol |
|---|---|---|
| funções na tela | 104 | 105 |
| **funções com o mesmo nome nas duas** | **104** | |

Praticamente tudo tem par. Mas **par não é cópia**: muitas divergiram ao longo do ano, e é
justamente aí que mora o risco de unificar errado.

## As 12 maiores, medidas

| função | AMB | Girassol | iguais? |
|---|---|---|---|
| `render` | 615 | 568 | diferem |
| `renderAnalise` | 347 | 347 | **idênticas** |
| `montar` | 203 | 203 | diferem |
| `_bqRender` | 177 | 177 | diferem |
| `renderCfg` | 105 | 94 | diferem |
| `desenharDespesasShopee` | 89 | 89 | **idênticas** |
| `renderHistLinhas` | 85 | 85 | **idênticas** |
| `calcPL` | 82 | 82 | **idênticas** |
| `salvarCfg` | 69 | 64 | diferem |
| `renderProjecao` | 50 | 50 | **idênticas** |
| `carregarFaturaCartao` | 48 | 47 | diferem |
| `renderMapaUF` | 44 | 44 | **idênticas** |

Só nessas doze há **~1.850 linhas** duplicadas.

## ⚠️ Idêntica NÃO quer dizer fácil de extrair

`renderAnalise` tem 347 linhas idênticas nas duas — e **767 identificadores externos**: `DADOS`,
`SINT`, `SKUINFO`, dezenas de `_an*` de estado da tela, filtros, seletores. Ela não recebe dados por
parâmetro: ela **lê o estado inteiro do painel**.

Isso é a mesma conclusão que já apareceu duas vezes:

- `vendasSync` (#633): 368 linhas, 236 identificadores externos → porte é refatoração, não cópia;
- `renderProjecao` (#671): 51 linhas, 14 dependências, lê `DADOS` + `SINT` → as duas convivem.

**Então a regra que vale aqui:** o tamanho da função não diz o custo do porte. O que diz é **quanto
estado da tela ela lê**. Extrair sem resolver isso entrega uma peça que calcula em cima de outro
dado — e número diferente do que o dono vê hoje é pior que número ausente.

## Medição fina das candidatas (09/10, segunda passada)

A primeira contagem de "identificadores externos" estava **inflada**: eu contava palavras de
comentário e de string como se fossem código. Refiz limpando comentários e strings antes de contar.
A diferença é grande e muda a conclusão:

| função | linhas de código | dependências REAIS | recebe o dado? |
|---|---|---|---|
| `desenharDespesasShopee` | 58 | **6** (`BRL`, `dBR`, `MOTIVO_SHP`, `NOME_TIPO_SHP` + 2 locais de ordenação) | **sim, por parâmetro** |
| `calcPL` | 65 | 12 (`CFG`, `SKUINFO`, `canalKey`…) | parcial |
| `renderMapaUF` | 44 | 16 (`BR_UF`, `BR_CEN`, `BR_TAM`, `porUF`…) | não, lê do estado |
| `renderHistLinhas` | 76 | 17 (`HLIN`, `SKUINFO`, `_qAn`, `_hlErro`…) | não, lê do estado |

**A candidata real é `desenharDespesasShopee`**, e por um motivo concreto: ela **recebe o dado por
parâmetro** (`function desenharDespesasShopee(d)`) e só depende de quatro utilitários de formatação
e dois rótulos. É o oposto da `renderAnalise`, que lê o painel inteiro.

`renderMapaUF` tinha sido meu palpite na primeira passada — a medição fina derrubou: ela lê `porUF`
do estado, além de três tabelas de geometria do mapa.

## O que fazer, na ordem que faz sentido

1. **Nada agora, sem decisão do dono.** Isto é débito medido, não tarefa pronta.
2. Se for atacar, começar pelas que o dado JÁ vem de rota (não do estado da tela). Pelas medições
   acima, `renderMapaUF` e `calcPL` são as candidatas mais prováveis — medir uma a uma antes.
3. `render`, `montar` e `_bqRender` **divergiram** entre as empresas. Unificar essas exige antes
   decidir, caso a caso, qual comportamento é o certo — e isso é pergunta pro dono, não escolha
   minha. Nivelar por cima vale aqui como em tudo: a que faz mais é o espelho.
4. `renderAnalise` e `renderProjecao`: só depois de o dado sair do estado da tela e virar rota.
