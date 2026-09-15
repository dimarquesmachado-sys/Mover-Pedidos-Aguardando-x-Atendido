# Bling Automação — multiempresa

Serviço Node.js no **Render** que roda a operação de e-commerce de **três empresas** —
Magazine Girassol, AMBTotal e GOOD Import — sobre contas separadas do Bling e dos
marketplaces, no mesmo processo.

> Este README descrevia "Bling Automação GIRASSOL — v2.0", de quando o serviço atendia uma
> empresa só e fazia uma coisa só, e ainda mandava descompactar um zip. Foi reescrito em
> 15/09/2026: quem chega abre este arquivo primeiro, e README desatualizado desorienta mais
> do que a ausência dele.

---

## Por onde começar

| Se você quer… | Abra |
|---|---|
| entender a consolidação multiempresa e onde ela parou | [`docs/plano-multiloja-passos.md`](docs/plano-multiloja-passos.md) |
| **ligar uma empresa nova** | [`docs/embarque-empresa-nova.md`](docs/embarque-empresa-nova.md) |
| saber por que as empresas diferem em alguma coisa | [`docs/fase2-diferencas-girassol.md`](docs/fase2-diferencas-girassol.md) e [`docs/fase3-diferencas-ciclo.md`](docs/fase3-diferencas-ciclo.md) |
| retomar o contexto numa conversa nova | [`docs/CONTEXTO-NOVA-CONVERSA-CLAUDE.md`](docs/CONTEXTO-NOVA-CONVERSA-CLAUDE.md) |

---

## O que o serviço faz

**Fiscal** — uma pasta por empresa, com o código em `lib/fiscal/`:

| Fluxo | O quê |
|---|---|
| F1 · a cada 3 min | ATENDIDO → AGUARDANDO: tira da tela do estoquista o pedido do ML que ainda não tem etiqueta |
| F2 · 00:10, 06:00, 06:30, 07:00 | AGUARDANDO → ATENDIDO: o ML libera as etiquetas de madrugada |
| F3 · a cada 10 min | manda ao marketplace a NF-e emitida |
| Corrigir-NFs · a cada 5 min | conserta e reenvia NF-e rejeitada pela SEFAZ |

**Checkout offline** — separação, conferência, etiquetas, histórico de vendas e margem, por
empresa. **Aplicações** — ponto, estoque, alerta de frágil, imagens do Drive, respostas
rápidas, backup, Madeira Madeira, entre outras.

---

## Como a multiempresa funciona

**Uma empresa é um registro**, não uma pasta. O `contrato-empresas.json` é a fonte de
verdade: id canônico, aliases, slug HTTP, prefixo de env por serviço, sufixo de tabelas e
**capacidades**. O `lib/empresas/registro.js` lê o contrato e valida colisões no boot — duas
empresas com o mesmo prefixo de env leriam a mesma credencial em silêncio.

⚠️ **O contrato é espelhado byte a byte com o repositório Devoluções.** Qualquer mudança nele
exige o PR gêmeo lá, e o verificador acusa enquanto os dois não baterem — vale até para o
campo de data.

**As capacidades decidem o comportamento**, não o nome da empresa. Exemplo real: só a
Girassol tem `expedicao`, e é isso que define para onde o checkout manda o pedido conferido —
com Expedição vai para VERIFICADO e o app move para DESPACHADOS quando a equipe bipa na
entrega; sem ela, vai direto para DESPACHADOS.

**Nem toda diferença entre empresas é dívida.** Pausas e cota são por conta; os crons do F3
são escalonados para não disputarem a cota do Bling; o caminho dos arquivos de token é estado
vivo. Antes de "uniformizar" qualquer coisa, leia os documentos de diferenças acima.

---

## Ferramentas de operação

```
node scripts/verifica.js                          # portão antes de qualquer push
node scripts/empresa.js validar <empresa>         # a env existe?
node scripts/empresa.js plano <empresa>           # os passos de embarque
node scripts/preflight-empresa.js <empresa>       # a env FUNCIONA? (rodar NO RENDER)
```

Duas rotas, ambas protegidas por chave de admin:

- `/<empresa>/descobrir-ids` — pergunta ao Bling os depósitos, as situações e os canais de
  venda, identifica qual é o do Mercado Livre (provando contra a conta), sugere as envs com
  os nomes que o código lê e **confere** contra o que está no Render.
- `/embarque` — uma tela com o que falta autorizar em cada empresa.

---

## Regras da casa

- `node scripts/verifica.js` **antes de todo push**: sintaxe, painéis, espelhos, paridade,
  contrato e a bateria inteira. Sai `PODE SUBIR` ou `NAO SUBIR`.
- **Apontamento que se repete vira teste**, não regra escrita: `imports-existem`,
  `escopo-de-variaveis`, `onclick-existe`, `campo-tem-produtor`, entre outros.
- Autenticação administrativa aceita **header** (`x-admin-key` ou `Bearer`); a query `?k=`
  segue aceita por compatibilidade.
- Nada de segredo em resposta, log ou tela de diagnóstico — nem parcial.

---

## Detalhes técnicos

- **Ritmo do Bling:** espaçamento entre chamadas com retry em 429, configurável **por
  empresa** — a cota é da conta, não do código.
- **Token renovado no meio do caminho:** se expirar durante uma execução, é renovado e a
  operação é retentada. O refresh do ML é de **uso único**: dois serviços renovando a mesma
  conta deixam um com token morto.
- **Rotinas pesadas não se sobrepõem:** uma trava única do processo adia a segunda em vez de
  enfileirar — enfileirar guardaria trabalho na memória, que é o recurso escasso aqui.
- **Sem banco:** tokens em arquivo no disco persistente; histórico de vendas no Supabase, com
  a fatia de cada empresa isolada por `empresa=eq.<id>`.
