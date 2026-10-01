/* ════════════════════════════════════════════════════════════════════════════
   ESTADO DAS ROTINAS PESADAS, POR EMPRESA (01/10/2026).

   POR QUE ISTO EXISTE — é o passo que faltava pra fábrica de rotas do painel.

   O dono, comparando o painel da GOOD com o da Girassol: "falta botões, cards, um monte de
   coisa. não tá multiempresas não"; e o alvo dele: "tem q ser multiempresa, pra outro CNPJ
   ser ligado mais facilmente".

   Tentei extrair as rotas direto pra uma fábrica, como a Fase 2 do plano fez com o módulo
   fiscal. NÃO DEU, e o motivo é este arquivo: as rotas PARECEM idênticas entre as empresas —
   `/completar-detalhes` e `/config-frete-magalu` não diferem em UMA linha —, mas carregam 13
   dependências do arquivo da empresa, e duas delas são ESTADO VIVO em memória: `_cst` (rodada
   de custo) e `_vsy` (sincronização de vendas).

   Estado vivo não pode ser injetado como as outras peças. Cada empresa precisa do SEU: se
   duas compartilhassem o mesmo objeto, a rodada de uma zeraria o contador da outra e a trava
   de "já está rodando" passaria a mentir — exatamente a classe de erro que já derrubou o
   serviço aqui (ver lib/checkout/trava-pesada.js, nascida do 503 de 13/09).

   ESTA PEÇA NÃO SUBSTITUI A trava-pesada. São coisas diferentes e complementares:
     · trava-pesada  → do PROCESSO: impede que a rodada da AMB e a da Girassol se sobreponham
     · esta aqui     → da EMPRESA: guarda o progresso da rodada DELA (quantos SKUs, falhas…)

   Com o estado fora do arquivo da empresa, as rotas que o usam ficam finas de verdade e a
   fábrica passa a ser possível — que é o próximo passo.
   ════════════════════════════════════════════════════════════════════════════ */

'use strict';

/* um conjunto por empresa, criado na primeira vez que é pedido. Guardar por id (e não por
   instância devolvida) garante que dois `require` do mesmo módulo em pontos diferentes do
   arquivo falem com o MESMO objeto — se não, a rota de status leria um contador e a rodada
   escreveria em outro, e o painel diria "parado" com a rotina em pé. */
const _porEmpresa = new Map();

function novoCusto() {
  /* o formato é o que as três telas já esperam — mudar nome de campo aqui quebraria o painel
     sem erro nenhum no console, só número sumido */
  return { rodando: false, feitos: 0, total: 0, ok: 0, falhas: 0, inicio: null, falhas_detalhe: [] };
}

function novoVendas() {
  return { rodando: false, total: 0, atualizado_em: null, erro: null };
}

/* devolve o estado da empresa. O MESMO objeto em toda chamada: quem guarda a referência
   (`const _cst = estadoDe('good').custo`) continua enxergando as mudanças. */
function estadoDe(empresa) {
  const id = String(empresa || '').trim().toLowerCase();
  if (!id) throw new Error('lib/checkout/estado-rotinas: informe a empresa');
  if (!_porEmpresa.has(id)) {
    _porEmpresa.set(id, { empresa: id, custo: novoCusto(), vendas: novoVendas() });
  }
  return _porEmpresa.get(id);
}

/* leitura pra diagnóstico — quais empresas têm rotina em pé agora. Só leitura: devolve cópia
   rasa pra ninguém zerar o contador de outra empresa sem querer. */
function emCurso() {
  const fora = [];
  for (const [id, e] of _porEmpresa) {
    if (e.custo.rodando) fora.push({ empresa: id, rotina: 'custo', desde: e.custo.inicio, feitos: e.custo.feitos, total: e.custo.total });
    if (e.vendas.rodando) fora.push({ empresa: id, rotina: 'vendas', total: e.vendas.total });
  }
  return fora;
}

module.exports = { estadoDe, emCurso };
