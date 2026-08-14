-- ════════════════════════════════════════════════════════════════════════════
-- Painel Lixas — 2 bolsões: colunas de STATUS DE ENVIO no ML
--
-- RODA EM: https://supabase.com/dashboard/project/wexikjzztxpfdbzjfnxl/sql/new
--          (projeto "Expedicao-Imagens-Girassol")
--
-- Pra que serve: o painel tira da sua frente a venda que ja tem etiqueta ou ja
-- foi postada no ML. Quem preenche essas colunas e o cron de hora em hora
-- (rotinaChecarCanceladasML), que ja visita venda por venda.
--
-- Pode rodar mais de uma vez (tudo IF NOT EXISTS).
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE lixas_combinar_pendentes
  ADD COLUMN IF NOT EXISTS ml_shipment_status    TEXT,
  ADD COLUMN IF NOT EXISTS ml_shipment_substatus TEXT,
  ADD COLUMN IF NOT EXISTS ml_etiqueta_em        TIMESTAMPTZ,
  -- Timestamp SEPARADO do de cancelamento. Sem ele, uma checagem so-de-envio
  -- carimbava ml_status_atualizado_em e a repescagem achava que o CANCELAMENTO
  -- tinha sido conferido — adiando a 1a checagem real e deixando uma janela em
  -- que venda cancelada seguia pro processamento automatico.
  ADD COLUMN IF NOT EXISTS ml_envio_checado_em   TIMESTAMPTZ,
  -- Marca o "✓ Processado" clicado no painel. Diferencia conclusao manual
  -- legitima de venda que ficou 'processado' sem NF por engano/falha.
  ADD COLUMN IF NOT EXISTS processado_manual_em  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS alerta_reconhecido_em TIMESTAMPTZ,
  -- Reserva da emissao manual de NF. O endpoint grava aqui antes de chamar o Bling
  -- (PATCH condicional) e o cron de cancelamento respeita a janela de 2 min — assim a
  -- checagem de cancelamento e a emissao irreversivel viram mutuamente exclusivas.
  ADD COLUMN IF NOT EXISTS nf_emitindo_em        TIMESTAMPTZ,
  -- Backoff curto (15 min) quando a consulta de status ao ML falha. Separado do
  -- ml_status_atualizado_em, que significa "conferido com sucesso" e suprime novas
  -- tentativas por 6h — carimbar ele numa falha deixaria uma venda cancelada sem
  -- checagem por horas, justamente quando a emissao automatica segue em frente.
  ADD COLUMN IF NOT EXISTS ml_status_falha_em    TIMESTAMPTZ,
  -- Dono da reserva de emissao. Sem ele, um worker cuja chamada ao Bling passou do
  -- lease liberaria, ao terminar, a reserva FRESCA de outro que ja assumiu a venda.
  ADD COLUMN IF NOT EXISTS nf_emitindo_por       TEXT;

-- Painel: separar rapido quem ja tem etiqueta
CREATE INDEX IF NOT EXISTS idx_lixas_pendentes_etiqueta
  ON lixas_combinar_pendentes (ml_etiqueta_em DESC NULLS LAST);

-- ── SEM BACKFILL — de proposito ─────────────────────────────────────────────
-- A versao anterior marcava como "conclusao manual" toda linha 'processado' com
-- pedido montado no Bling e sem NF local. Mas pedido montado prova so que os itens
-- foram lancados, NAO que existe nota — e a rota /recuperar-nf existe justamente
-- porque montagem sem NF acontece (bug antigo do montar, clique por engano).
-- Marcar essas linhas as mandaria pro bolsao Resolvidos e faria TODOS os caminhos
-- de NF (automatico e manual) pularem elas: pedido sem nota fiscal, em silencio.
--
-- Entao nao marcamos nada. As linhas historicas aparecem em Pendentes como
-- "marcado processado mas SEM NF", com os botoes de Recuperar NF e de Confirmar
-- conclusao — voce tria uma vez, sabendo o que cada uma e.
SELECT count(*) AS processados_sem_nf_para_triar
  FROM lixas_combinar_pendentes
 WHERE status = 'processado' AND nf_emitida_em IS NULL;

-- ── Conferencia ─────────────────────────────────────────────────────────────
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'lixas_combinar_pendentes'
  AND column_name IN ('ml_shipment_status','ml_shipment_substatus','ml_etiqueta_em','ml_envio_checado_em','processado_manual_em','alerta_reconhecido_em','nf_emitindo_em','ml_status_falha_em','nf_emitindo_por')
ORDER BY column_name;
-- Esperado: 9 linhas.
