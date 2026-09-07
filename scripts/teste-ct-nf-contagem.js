'use strict';
/* Teste da contagem de importação do Bling (tb-importacao.js) — nasceu do raio-x
   de 07/09: 31 duplicadas contadas como falha travaram o _importado desde 03/09.
   Exercita a função DE PRODUÇÃO (a mesma que os blocos Magalu e Shopee usam).
   Rodar: node scripts/teste-ct-nf-contagem.js */
const assert = require('assert');
const { resumirImportacaoBling } = require('../toolbox-extensao/tb-importacao.js');

const DUP = '<li>XML não importado. A nota fiscal com a chave 3526...86 já está registrada no sistema.</li>';
const REAL = '<li>XML não importado. Motivo: certificado do emitente inválido.</li>';

// 1) O caso do raio-x: 31 duplicadas → contagem bruta 31/31, mas ZERO falha real
let r = resumirImportacaoBling(DUP.repeat(31));
assert.strictEqual(r.ja_registradas, 31);
assert.strictEqual(r.nao_importados, 31, 'bruto continua contando a frase (compat)');
assert.strictEqual(r.falhas_reais, 0, 'duplicada NUNCA é falha');
assert.strictEqual(r.corpo_vazio, false);

// 2) Falha real sozinha → 1
r = resumirImportacaoBling(REAL);
assert.strictEqual(r.falhas_reais, 1);
assert.strictEqual(r.ja_registradas, 0);

// 3) Mistura: 2 duplicadas + 1 real → só a real conta (janela limitada à próxima ocorrência)
r = resumirImportacaoBling(DUP + REAL + DUP);
assert.strictEqual(r.ja_registradas, 2);
assert.strictEqual(r.falhas_reais, 1);

// 4) Layout desconhecido (motivo ANTES da frase) → conservador: vira falha real,
//    o gate NÃO marca (re-tenta visível) — nunca o erro na direção de marcar por engano
r = resumirImportacaoBling('<li>A nota já está registrada — XML não importado</li>');
assert.strictEqual(r.falhas_reais, 1, 'na dúvida, falha real (segura o registro)');
assert.strictEqual(r.ja_registradas, 1);

// 5) Resposta vazia → corpo_vazio (200 sem conteúdo não marca nada)
r = resumirImportacaoBling('   <html> </html> ');
assert.strictEqual(r.corpo_vazio, true);
assert.strictEqual(r.falhas_reais, 0);

// 6) Notas de entrada no lote de saída seguem contadas; corpo guardado pra diagnóstico
r = resumirImportacaoBling('<p>Para importar notas de entrada use a outra tela</p>' + DUP);
assert.strictEqual(r.eram_de_entrada, 1);
assert.ok(r.corpo.includes('já está registrada') && r.corpo.length <= 2000);

console.log('OK: 6 cenários — duplicada é presença, só falha real (ou corpo vazio) segura o registro');
