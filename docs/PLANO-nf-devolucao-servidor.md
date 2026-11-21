# PLANO — NF de devolução gerada pelo SERVIDOR (sem computador ligado)

> Aberto em 21/11/2026, a pedido do dono: *"Tem como fazer os 2 jeitos? Faz o 1 agora entao. Mas deixa o 2 no nosso itens a
> fazer. E marca pra nao esquecer… ter tipo um plano ou documento pra consultar e ir riscando conforme fizermos as etapas"*.
> Também listado no `docs/NORTE-2026-11.md` (seção F). Cada etapa feita vira ✅ com o número do PR.

## O problema

O conserto da NF que o ML recusa por CEP/endereço cria a nota NOVA e a entrega ao ML (#951–#958). A nota recusada (a ANTIGA)
continua autorizada no Bling: duas notas pra mesma venda. A regra do dono: cancelar em até 24 h da emissão; passou disso,
**NF de devolução** da antiga. O checkout lista as antigas pendentes (#960).

- **Jeito 1 (em andamento, 21/11):** botão "Gerar devolução" no aviso do checkout → a **Toolbox** gera pela tela do Bling
  (o mesmo caminho do app de Devoluções e do lote da AMB: `GOOD_BRIDGE_CRIAR_DEVOLUCAO`). Precisa do clique **no
  computador**, no navegador da empresa, com o Bling aberto.
- **Jeito 2 (este plano):** o **servidor** (Render) gera e emite a devolução sozinho, pela API do Bling — funciona do
  celular, ou sem clique nenhum.

## O que a API do Bling permite (conferido na documentação v3, 21/11)

`POST /nfe` aceita: `tipo: 0` (entrada), `finalidade: 4` (devolução), `naturezaOperacao.id`, `documentoReferenciado`
(`modelo: '55'` + `chaveAcesso` da nota original) e, por item, `itens[].documentoReferenciado` (`chaveAcesso` + `numeroItem`).
Depois `POST /nfe/{id}/enviar` emite. A API **não cancela** nota (o cancelamento segue pela tela).

**A diferença pro jeito 1:** no jeito 1 quem monta a nota é o botão "gerar devolução" do próprio Bling (impostos, CFOP e
itens que ele calcula). No jeito 2 quem monta somos nós — os impostos vêm da **natureza de operação de devolução** cadastrada
em cada conta. Por isso a etapa 2 (comparar) é obrigatória antes de ligar.

## Etapas (riscar conforme for feito)

| # | Etapa | Estado | Critério de aceite |
|---|---|---|---|
| 1 | Descobrir, em cada conta (Girassol, GOOD, AMB), o id da natureza de operação "Devolução de venda" que o dono usa à mão | ⬜ | ids lidos pela API (`GET /naturezas-operacoes`) e confirmados pelo dono com print; ficam no contrato da empresa (`config-empresa`), nunca escritos à mão em rota |
| 2 | **Comparar** — gerar pela API, como RASCUNHO (sem emitir), a devolução de uma nota que o dono já devolveu à mão, e conferir campo a campo com a feita à mão (CFOP, CST, base e valor de ICMS/IPI/PIS/COFINS, itens, quantidades, valores, frete, chave referenciada) | ⬜ | diferença zero, ou cada diferença explicada e aceita pelo dono; rascunho excluído depois |
| 3 | Peça `lib/fiscal/nf-devolucao-api.js`: `montarDevolucao(nfOriginal, natureza)` pura (sem rede), testada com notas reais anonimizadas | ⬜ | teste com mutações; itens e valores iguais aos da original; só inteiros positivos em quantidade |
| 4 | Rota de ensaio `<prefixo>/nf-devolucao-ensaio?nf=` (admin): mostra a nota que SERIA criada, sem criar | ⬜ | sem dado de gente na resposta; mesma trava das rotas do conserto |
| 5 | Rota de criar + emitir, idempotente: registro antes do efeito externo (estado `criando` → `criada` → `emitida`), queda de rede = "incerta" (não repete às cegas), anti-duplicata (devolução que já existe pra aquela chave = não cria outra) | ⬜ | os mesmos estados do `nf-conserto-registro`; teste de cada saída (ok, recusa do Bling, 429, rede caiu, já existia) |
| 6 | Botão no aviso do checkout passa a oferecer "gerar pelo servidor" (funciona no celular); o jeito 1 continua como reserva | ⬜ | UI_BUILD bumpado nas três; o aviso some quando a devolução é emitida |
| 7 | (opcional, decisão do dono) gerar SOZINHO, sem clique, a devolução das antigas que passaram das 24 h | ⬜ | só depois de semanas da etapa 6 sem divergência; liga por empresa |
| 8 | Ligar nas três empresas e conferir a primeira de cada uma com o dono | ⬜ | print da nota emitida em cada conta |

## Cuidados que não podem se perder

- **Cota do Bling é da conta** — a criação é uma chamada por nota; nada em lote no horário do galpão.
- **Empresa certa**: o token usado é o da empresa da rota; a natureza vem do contrato da mesma empresa. Nota na conta errada
  é pior do que nota nenhuma.
- **Estoque**: a devolução sem retorno físico (nota duplicada) não pode lançar estoque que não voltou. Conferir na etapa 2
  o que a devolução feita à mão faz com o estoque e repetir exatamente isso.
- **Número errado é pior que ausente**: se a API recusar ou faltar dado, o aviso continua pedindo a devolução — nunca some
  sem a nota emitida.
