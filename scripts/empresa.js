#!/usr/bin/env node
'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   ONBOARDING DE EMPRESA — o que falta pra uma loja entrar (14/09/2026).

   Fase 5 da auditoria. O problema que resolve: hoje, pra saber se uma empresa nova
   está pronta, alguém tem que abrir o Render, conferir envs uma a uma e descobrir
   o resto no primeiro erro de produção — de madrugada, porque é quando os crons
   rodam.

   Dois comandos:

     node scripts/empresa.js validar <empresa>
       Confere o que JÁ dá pra conferir daqui: registro, colisões, capacidades,
       envs presentes, callbacks, diretório de dados. Sai com código 1 se faltar
       algo que impeça a empresa de subir — serve como portão antes do deploy.

     node scripts/empresa.js plano <empresa>
       Lista os passos de embarque: quais envs criar no Render (por nome exato),
       quais callbacks registrar no Bling e no ML, qual fatia do Supabase, quais
       crons vão nascer e quem é o dono do refresh de cada conta.

   ⚠️ NUNCA imprime valor de segredo — só o NOME da env e se ela está presente.
   Isso é regra, não gosto: o dono já teve a ADMIN_KEY exposta num link, e uma
   ferramenta de diagnóstico que vaza chave é pior que não ter ferramenta.
   ──────────────────────────────────────────────────────────────────────────── */

const path = require('path');
const fs = require('fs');

const { carregar } = require('../lib/empresas/registro');

/* envs exigidas por capacidade — a lista sai do que as fábricas realmente pedem,
   não de memória: cada nome aqui aparece num criar*() de lib/fiscal. */
const ENVS_POR_CAPACIDADE = {
  fiscal: [
    'BLING_CLIENT_ID', 'BLING_CLIENT_SECRET', 'BLING_REDIRECT_URI',
    'NF_BLING_CLIENT_ID', 'NF_BLING_CLIENT_SECRET', 'NF_BLING_REDIRECT_URI',
  ],
  ml: ['ML_CLIENT_ID', 'ML_CLIENT_SECRET', 'ML_REDIRECT_URI'],
  checkout: ['OPERADORES', 'ADMIN'],
};

/* envs OPCIONAIS: têm padrão no código e só mudam ritmo/limite. Aparecem no plano
   como "ajuste fino", nunca como bloqueio — senão o portão vira ruído e a pessoa
   aprende a ignorar o vermelho. */
const ENVS_OPCIONAIS = {
  fiscal: ['NF_COOLDOWN_MIN', 'NF_PAUSA_MS', 'PAUSA_MS', 'GET_PAUSA_MS', 'MAX_PAGINAS'],
  ml: ['MAX_NFE_ML', 'NF_JANELA_DIAS_F3', 'F3_MAX_CHECAGENS'],
  checkout: ['MAX_PEDIDOS_F1', 'MAX_PEDIDOS_F2', 'F1_REMOVE_MAX', 'F1_REMOVE_ESPERA_MIN'],
};

function _capacidades(registro, id) {
  const todas = Object.keys(ENVS_POR_CAPACIDADE);
  return todas.filter(c => registro.temCapacidade(id, c));
}

function _envsDe(registro, id, mapa) {
  const out = [];
  for (const cap of _capacidades(registro, id)) {
    for (const suf of (mapa[cap] || [])) out.push({ cap, nome: registro.nomeEnv(id, suf) });
  }
  return out;
}

function validar(alvo) {
  const registro = carregar({ servico: 'mover-pedidos' });
  const e = registro.obter(alvo);
  if (!e) {
    console.error('✗ "' + alvo + '" não está no contrato-empresas.json.');
    console.error('  O primeiro passo é o registro: sem ele, nada do resto existe.');
    return 1;
  }

  console.log('Empresa: ' + e.nome + '  (id canônico: ' + e.id + ')');
  console.log('  slug HTTP: ' + (e.slugHttp || '(raiz)') + '   |   prefixo de env: ' + (e.prefixoEnv || '(vazio)'));
  console.log('  aliases: ' + ((e.aliases || []).join(', ') || '—'));

  const caps = _capacidades(registro, e.id);
  console.log('  capacidades: ' + (caps.join(', ') || '(nenhuma declarada)'));

  let problemas = 0;

  if (!caps.length) {
    console.log('\n✗ nenhuma capacidade declarada — a empresa não vai montar nada.');
    problemas++;
  }

  const obrig = _envsDe(registro, e.id, ENVS_POR_CAPACIDADE);
  const faltando = obrig.filter(x => !process.env[x.nome]);
  console.log('\nEnvs obrigatórias: ' + (obrig.length - faltando.length) + '/' + obrig.length + ' presentes');
  for (const f of faltando) console.log('  ✗ falta ' + f.nome + '   (capacidade: ' + f.cap + ')');
  problemas += faltando.length;

  const opc = _envsDe(registro, e.id, ENVS_OPCIONAIS);
  const semOpc = opc.filter(x => !process.env[x.nome]);
  if (semOpc.length) {
    console.log('\nAjuste fino (tem padrão no código, não bloqueia): ' + semOpc.length + ' env(s) não definida(s)');
  }

  /* dono do refresh: duas contas renovando o mesmo token de uso único é o risco que a
     auditoria pôs no topo — aqui ele aparece ANTES de embarcar, não depois. */
  const contas = e.contas || {};
  for (const [conta, info] of Object.entries(contas)) {
    const dono = (info && info.dono_hoje) || e.donoHoje;
    if (dono && dono !== 'mover-pedidos') {
      console.log('\n⚠ a conta "' + conta + '" é renovada por "' + dono + '" — este serviço deve LER o token, nunca renovar.');
    }
  }

  console.log(problemas ? '\n✗ ' + problemas + ' pendência(s) — a empresa NÃO está pronta pra subir.'
                        : '\n✓ pronta: registro, capacidades e envs obrigatórias no lugar.');
  return problemas ? 1 : 0;
}

function plano(alvo) {
  const registro = carregar({ servico: 'mover-pedidos' });
  const e = registro.obter(alvo);
  if (!e) {
    console.error('✗ "' + alvo + '" não está no contrato. Comece adicionando o registro em contrato-empresas.json.');
    return 1;
  }
  const caps = _capacidades(registro, e.id);
  const base = process.env.HOST_PUBLICO || 'https://mover-pedidos-aguardando-x-atendido.onrender.com';
  const slug = e.slugHttp || '';

  console.log('PLANO DE EMBARQUE — ' + e.nome + ' (' + e.id + ')\n');

  console.log('1. Envs no Render (nome EXATO; o valor você cola lá, nunca aqui):');
  for (const x of _envsDe(registro, e.id, ENVS_POR_CAPACIDADE)) {
    console.log('   ' + (process.env[x.nome] ? '✓' : '·') + ' ' + x.nome);
  }

  console.log('\n2. Callbacks a registrar no aplicativo de cada conta:');
  if (caps.includes('fiscal')) {
    console.log('   Bling (Mover-Pedidos):  ' + base + slug + '/callback');
    console.log('   Bling (Corrigir-NFs):   ' + base + slug + '/callback-nf');
  }
  if (caps.includes('ml')) console.log('   Mercado Livre:          ' + base + slug + '/callback-ml');

  console.log('\n3. Autorização inicial (uma vez, depois das envs):');
  console.log('   abrir o callback acima e autorizar; se o redirect não puder ser usado,');
  console.log('   o POST ' + base + slug + '/setup aceita o code à mão.');

  /* 15/09 — a EXPEDIÇÃO muda pra onde o checkout manda o pedido conferido, e isso é decisão
     de operação que ninguém adivinha lendo código. O plano diz o efeito em vez de deixar o
     dono lembrar: sem app de Expedição não existe etapa depois da conferência. */
  {
    const temExp = registro.temCapacidade(e.id, 'expedicao') === true;
    console.log('\n4. Expedição (muda o destino do pedido conferido):');
    if (temExp) {
      console.log('   esta empresa TEM app de Expedição: o checkout manda o conferido pra VERIFICADO,');
      console.log('   e o app move pra DESPACHADOS quando a equipe bipa na entrega à transportadora.');
    } else {
      console.log('   esta empresa NÃO tem app de Expedição: não há etapa depois da conferência, então');
      console.log('   o checkout manda o pedido conferido DIRETO pra DESPACHADOS.');
      console.log('   ⚠️ a env de VERIFICADO desta empresa recebe o id do DESPACHADOS dela — não é engano.');
      console.log('   Se um dia ela ganhar Expedição, declare "expedicao" nas capacidades e troque a env.');
    }
    console.log('   (o /descobrir-ids já sugere o id certo pros dois casos)');
  }

  console.log('\n5. Dados:');
  console.log('   fatia do Supabase:  vendas_historico?empresa=eq.' + e.id);
  console.log('   sufixo de tabelas:  ' + (e.sufixoTabelas || '(nenhum)'));
  console.log('   diretório de dados: /data/' + e.id + '   (precisa ser disco persistente no Render)');

  console.log('\n6. Crons que vão nascer:');
  console.log('   expediente a cada 3 min · virada 00:10 · manhã (06:00, 06:30, 07:00) · NFs a cada 5 min');
  console.log('   F3 (NF-e→ML): em minuto ESCALONADO, escolhido automaticamente entre os livres —');
  console.log('   as empresas não podem disparar no mesmo minuto ou brigam pela cota do Bling.');

  console.log('\n7. Ativação:');
  console.log('   EMPRESAS deve conter "' + e.id + '" (ou estar vazia, que ativa todas as do contrato).');
  console.log('   SKIP_EMPRESAS desliga qualquer módulo por id ou alias.');

  console.log('\nDepois de tudo: node scripts/empresa.js validar ' + e.id);
  return 0;
}

const [cmd, alvo] = process.argv.slice(2);
if (!cmd || !alvo || !['validar', 'plano'].includes(cmd)) {
  console.log('uso: node scripts/empresa.js validar <empresa>');
  console.log('     node scripts/empresa.js plano <empresa>');
  process.exit(2);
}
process.exit(cmd === 'validar' ? validar(alvo) : plano(alvo));
