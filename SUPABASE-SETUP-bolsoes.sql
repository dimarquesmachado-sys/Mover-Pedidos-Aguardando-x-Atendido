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
  ADD COLUMN IF NOT EXISTS alerta_reconhecido_em TIMESTAMPTZ;

-- Painel: separar rapido quem ja tem etiqueta
CREATE INDEX IF NOT EXISTS idx_lixas_pendentes_etiqueta
  ON lixas_combinar_pendentes (ml_etiqueta_em DESC NULLS LAST);

-- ── BACKFILL: conclusoes manuais ANTERIORES a este deploy ───────────────────
-- O botao "✓ Processado" antigo gravava so status='processado', sem marcador.
-- Sem este passo, toda venda concluida na mao no passado seria reclassificada
-- como anomalia e voltaria pra Pendentes ("marcado processado mas SEM NF").
-- Usa atualizado_em como carimbo aproximado (e quando o status foi gravado).
-- IMPORTANTE: so marca onde ha EVIDENCIA de trabalho real (pedido montado no Bling).
-- Linha 'processado' sem NF *e* sem pedido montado e exatamente o "falso processado"
-- que o recuperarFalsosProcessados caca — clique por engano ou montagem que morreu no
-- meio. Marcar essas como conclusao manual jogaria elas pro bolsao fechado e esconderia
-- uma NF faltando. Essas ficam em Pendentes de proposito, pra voce triar uma vez.
UPDATE lixas_combinar_pendentes
   SET processado_manual_em = COALESCE(atualizado_em, criado_em, NOW())
 WHERE status = 'processado'
   AND processado_manual_em IS NULL
   AND nf_emitida_em IS NULL
   AND bling_editado_em IS NOT NULL;

-- Quantas ficaram pra triar (aparecem em Pendentes como "marcado processado mas SEM NF"):
SELECT count(*) AS falsos_processados_para_triar
  FROM lixas_combinar_pendentes
 WHERE status = 'processado' AND nf_emitida_em IS NULL
   AND bling_editado_em IS NULL AND processado_manual_em IS NULL;

-- ── Conferencia ─────────────────────────────────────────────────────────────
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'lixas_combinar_pendentes'
  AND column_name IN ('ml_shipment_status','ml_shipment_substatus','ml_etiqueta_em','ml_envio_checado_em','processado_manual_em','alerta_reconhecido_em')
ORDER BY column_name;
-- Esperado: 6 linhas.
