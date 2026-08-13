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
  ADD COLUMN IF NOT EXISTS ml_etiqueta_em        TIMESTAMPTZ;

-- Painel: separar rapido quem ja tem etiqueta
CREATE INDEX IF NOT EXISTS idx_lixas_pendentes_etiqueta
  ON lixas_combinar_pendentes (ml_etiqueta_em DESC NULLS LAST);

-- ── Conferencia ─────────────────────────────────────────────────────────────
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'lixas_combinar_pendentes'
  AND column_name IN ('ml_shipment_status','ml_shipment_substatus','ml_etiqueta_em')
ORDER BY column_name;
-- Esperado: 3 linhas.
