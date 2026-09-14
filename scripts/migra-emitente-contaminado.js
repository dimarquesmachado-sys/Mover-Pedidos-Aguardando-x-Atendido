#!/usr/bin/env node
'use strict';
/* Codex #431 (P1): a correção do CNPJ cruzado (ver amb-checkout-offline/nf.js e
   good-checkout-offline/nf.js) só vale para NF nova. Pedido cujo `nf-simp.json` já foi
   gravado ANTES do deploy — na AMB ou na GOOD, com o XML sem emitente — ficou com o CNPJ da
   MAGAZINE GIRASSOL gravado em disco, e toda rota que reimprime/reenvia lê esse arquivo
   primeiro (`index.js` debug-nf-simp/danfe-simp/etiquetas, `email-docs.js`, e `arquivo.js`
   copia ele pro arquivo morto sem olhar dentro). O código novo nunca roda de novo pra esse
   pedido porque o cache já existe — reimprimir continuaria saindo errado sem isso aqui.
   Rodar UMA VEZ manualmente após o deploy do fix, com as mesmas env vars da produção
   (AMBBKP_CACHE_DIR / AMBBKP_ARQUIVO_DIR / GOODBKP_CACHE_DIR / GOODBKP_ARQUIVO_DIR já
   setadas no ambiente, como no serviço real). Por padrão só REPORTA; passe --aplica pra
   gravar a correção nos arquivos encontrados. */
const fs = require('fs');
const path = require('path');

const CNPJ_GIRASSOL = '27548456000147';
const ENDERECO_GIRASSOL = 'Rua Jose Ruscitto, 150, BOX 1 - Galpao, Taboao da Serra - SP';

// só AMB e GOOD foram contaminadas — a Girassol usa esse CNPJ de verdade, não é sinal de bug lá.
const EMPRESAS = [
  {
    pasta: 'amb-checkout-offline',
    cacheEnv: 'AMBBKP_CACHE_DIR', cacheDefault: '/data/cache-offline/ambtotal',
    arquivoEnv: 'AMBBKP_ARQUIVO_DIR', arquivoDefault: '/data/arquivo-ambtotal',
  },
  {
    pasta: 'good-checkout-offline',
    cacheEnv: 'GOODBKP_CACHE_DIR', cacheDefault: '/data/cache-offline/good',
    arquivoEnv: 'GOODBKP_ARQUIVO_DIR', arquivoDefault: '/data/arquivo-good',
  },
];

const aplica = process.argv.includes('--aplica');

function emitenteCorrigido(pasta) {
  const fallback = require(path.join('..', pasta, 'emitente-fallback.js'));
  // rede de segurança: se algum dia uma empresa ficar sem fallback próprio de novo, o nf.js
  // sai com o bloco vazio (em vez de inventar ou repetir a Girassol) — ver <empresa>/nf.js.
  return fallback || { razao: '', cnpj: '', ie: '', endereco: '' };
}

function contaminado(dados) {
  const e = dados && dados.emitente;
  return !!e && String(e.cnpj || '') === CNPJ_GIRASSOL && String(e.endereco || '') === ENDERECO_GIRASSOL;
}

let achados = 0, corrigidos = 0;
for (const emp of EMPRESAS) {
  const correto = emitenteCorrigido(emp.pasta);
  const dirs = [
    process.env[emp.cacheEnv] || emp.cacheDefault,
    process.env[emp.arquivoEnv] || emp.arquivoDefault,
  ];
  for (const raiz of dirs) {
    let pedidos;
    try { pedidos = fs.readdirSync(raiz, { withFileTypes: true }); }
    catch (e) { console.log(`[pula] ${raiz} não existe aqui`); continue; }
    for (const p of pedidos) {
      if (!p.isDirectory()) continue;
      const arq = path.join(raiz, p.name, 'nf-simp.json');
      let dados;
      try { dados = JSON.parse(fs.readFileSync(arq, 'utf8')); } catch (e) { continue; }
      if (!contaminado(dados)) continue;
      achados++;
      console.log(`[achado] ${emp.pasta}: ${arq} — emitente = Magazine Girassol (CNPJ ${CNPJ_GIRASSOL})`);
      if (aplica) {
        dados.emitente = correto;
        fs.writeFileSync(arq, JSON.stringify(dados, null, 2));
        corrigidos++;
        console.log(`  → corrigido para ${correto.razao ? correto.razao : '(bloco vazio, ' + emp.pasta + ' sem fallback próprio)'}`);
      }
    }
  }
}

console.log(`\n${achados} nf-simp.json contaminado(s) encontrado(s).`);
if (!aplica) console.log(achados ? 'Rode de novo com --aplica pra corrigir.' : '');
else console.log(`${corrigidos} corrigido(s).`);
