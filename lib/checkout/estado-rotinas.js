/* ════════════════════════════════════════════════════════════════════════════
   ESTADO DAS ROTINAS PESADAS, POR EMPRESA (01/10/2026).

   POR QUE ISTO EXISTE — e é o passo que faltava pra fábrica de rotas do painel.

   O dono, comparando o painel da GOOD com o da Girassol: "falta botões, cards, um monte de
   coisa. não tá multiempresas não"; e o alvo: "tem q ser multiempresa, pra outro CNPJ ser
   ligado mais facilmente".

   Tentei extrair as rotas direto pra uma fábrica, como a Fase 2 fez com o módulo fiscal. Não
   deu, e o motivo é este arquivo: as rotas PARECEM idênticas entre as empresas — algumas não
   diferem em uma linha —, mas carregam 13 dependências do arquivo da empresa, e duas delas
   são ESTADO VIVO em memória: `_cst` (rodada de custo) e `_vsy` (sincronização de vendas).

   Estado vivo não pode ser injetado como as outras peças. Cada empresa precisa do SEU: se
   duas compartilhassem o mesmo objeto, a rodada de uma zeraria o contador da outra e a trava
   de "já está rodando" passaria a mentir — que é exatamente a classe de erro que já derrubou
   o serviço aqui (ver lib/checkout/trava-pesada.js, nascida do 503 de 13/09).

   Esta peça NÃO substitui a trava-pesada. São coisas diferentes e complementares:
     · trava-pesada  → impede DUAS EMPRESAS de rodarem pesado ao mesmo tempo (heap de 340MB)
     · esta peça     → guarda o PROGRESSO de cada empresa, isolado das demais

   Com o estado fora do arquivo da empresa, as rotas que o usam ficam finas de verdade e a
   fábrica passa a ser possível — que é o passo seguinte.
   ════════════════════════════════════════════════════════════════════════════ */

'use strict';

/* um conjunto por empresa, criado sob demanda. O mapa é de módulo: dura o processo inteiro,
   como as variáveis soltas que ele substitui — trocar por algo que reinicia perderia a trava
   de rodada em andamento, que é o que ele serve pra guardar. */
const _porEmpresa = new Map();

/* o formato é o MESMO que estava solto nos três arquivos, campo por campo. Copiado, não
   reinventado: qualquer campo a menos quebraria a tela que já lê este objeto. */
function _novo() {
  return {
    custo:  { rodando: false, feitos: 0, total: 0, ok: 0, falhas: 0, inicio: null, falhas_detalhe: [] },
    vendas: { rodando: false, total: 0, atualizado_em: null, erro: null },
  };
}

/* devolve o estado da empresa, criando na primeira vez.

   ⚠️ Devolve a REFERÊNCIA viva, de propósito: o código que já existe faz `_cst.feitos++` e
   `_cst.rodando = true` direto no objeto. Devolver uma cópia deixaria o contador parado e a
   tela mostraria "0 de 1.768" a rodada inteira — falha silenciosa, a pior espécie. */
function estadoDe(empresa) {
  const id = String(empresa || '').trim().toLowerCase();
  if (!id) throw new Error('lib/checkout/estado-rotinas: empresa é obrigatória');
  if (!_porEmpresa.has(id)) _porEmpresa.set(id, _novo());
  return _porEmpresa.get(id);
}

/* zera o estado de UMA empresa, sem tocar nas outras. Usado no fim de uma rodada e nos
   testes — nunca enquanto `rodando` é true, senão a trava da rodada em curso se perde. */
function zerar(empresa) {
  const id = String(empresa || '').trim().toLowerCase();
  if (!id) throw new Error('lib/checkout/estado-rotinas: empresa é obrigatória');
  /* EM LUGAR, nunca trocando o objeto: quem guardou a referência de estadoDe() (`_cst`, `_vsy`)
     precisa continuar enxergando o estado vigente. Apaga também campos extras que a rotina
     acrescentou (fase, rodada_em...), pra voltar exatamente ao formato inicial. */
  const atual = estadoDe(id);
  const novo = _novo();
  for (const k of Object.keys(novo)) {
    for (const c of Object.keys(atual[k])) delete atual[k][c];
    Object.assign(atual[k], novo[k]);
  }
  return atual;
}

/* quem tem rotina pesada em pé agora, em todas as empresas. Serve pro diagnóstico de
   sobreposição sem precisar abrir três rotas de status. */
function emAndamento() {
  const fora = [];
  for (const [id, e] of _porEmpresa) {
    if (e.custo.rodando)  fora.push({ empresa: id, rotina: 'custo',  inicio: e.custo.inicio, feitos: e.custo.feitos, total: e.custo.total });
    if (e.vendas.rodando) fora.push({ empresa: id, rotina: 'vendas', total: e.vendas.total });
  }
  return fora;
}

module.exports = { estadoDe, zerar, emAndamento };
