'use strict';
/* 13/09 — os dois P1 da auditoria do Codex, num teste só, porque são o mesmo problema visto
   de dois lados: a MESMA loja tinha destinos diferentes conforme o nome usado.
     1. `valida()` aceitava só o alias da env — quem chamasse com o id canônico do contrato
        ('ambtotal') levava "empresa inválida". Agora os dois valem.
     2. `config/empresas.js` misturava lojas com aplicações e tinha um segundo mecanismo de
        ativação (SKIP_EMPRESAS) com semântica própria, separado do EMPRESAS do registro.
   O que NÃO se mexe, e o teste protege: `lista()` continua devolvendo os nomes de sempre,
   porque há ESTADO gravado com eles — o Magalu guarda o token em /data/<empresa>.json com a
   string que recebe. Trocar ali não é refatorar, é perder o token da empresa. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const emp = require('../lib/empresas');

/* 1) alias e canônico levam ao mesmo lugar */
assert.strictEqual(emp.valida('amb'), true, 'o alias tem que continuar valendo (é o que a borda HTTP usa)');
assert.strictEqual(emp.valida('ambtotal'), true, 'o id canônico do contrato TAMBÉM tem que valer');
assert.strictEqual(emp.valida('AMB'), true, 'maiúscula não pode mudar o veredito');
assert.strictEqual(emp.valida('xpto'), false, 'empresa fora do contrato continua inválida');
assert.strictEqual(emp.valida(''), false);

/* 2) a lista de compatibilidade não muda (estado gravado depende dela) */
assert.ok(emp.lista().includes('amb'), 'lista() precisa manter o alias — o token do Magalu é nomeado por ele');
assert.ok(emp.listaCanonica().includes('ambtotal'), 'listaCanonica() é o que código novo usa');
assert.ok(!emp.listaCanonica().includes('amb'), 'a lista canônica não pode trazer alias');
assert.strictEqual(emp.listaCanonica().length, emp.lista().length, 'as duas listas têm o mesmo tamanho — muda o nome, não o conjunto');

/* 3) o config separa loja de aplicação, e o aviso da loja sem módulo existe */
const cfg = fs.readFileSync(path.join(__dirname, '..', 'config', 'empresas.js'), 'utf8');
assert.ok(/const LOJAS = \{/.test(cfg), 'o config tem que declarar LOJAS separadamente');
assert.ok(/const APLICACOES = \[/.test(cfg), 'o config tem que declarar APLICACOES separadamente');
assert.ok(/_registro\.ativas\(\)/.test(cfg), 'as lojas ativas têm que vir do registro, não de lista fixa');
/* 14/09 — a promessa EVOLUIU: ontem, loja no contrato sem pasta só era avisada; hoje ela é
   MONTADA a partir do registro (lib/fiscal/montar-empresa.js). Teste que guarda a promessa
   velha impediria a nova, então ele passa a exigir o comportamento atual — e o aviso de
   falha continua existindo pra o caso de a montagem não dar certo. */
assert.ok(/montarEmpresa\(/.test(cfg),
  'loja no contrato sem pasta tem que ser MONTADA pelo registro — é o critério de aceitação da auditoria');
assert.ok(/não consegui montar a loja/.test(cfg),
  'se a montagem falhar, tem que gritar — silêncio aqui esconderia uma empresa inteira fora do ar');
assert.ok(/SKIP_EMPRESAS/.test(cfg) && /normalizar/.test(cfg),
  'o SKIP tem que passar pelo registro, senão "amb" e "ambtotal" desligam coisas diferentes');
/* 14/09 (Codex, P1) — contrato LIDO mas com regra violada (alias colidindo, capacidade
   fora do vocabulário) tem que abortar o boot, não cair no "modo antigo" do catch genérico:
   nesse modo a ativação por EMPRESAS é ignorada e todas as lojas conhecidas sobem. */
assert.ok(/instanceof _registroLib\.ContratoInvalidoError/.test(cfg) && /throw e/.test(cfg),
  'contrato inválido (não "ilegível") tem que ser relançado, não engolido pelo catch');

console.log('OK: ativação — alias e canônico valem igual, lista() preservada pro estado gravado, e o config separa lojas de aplicações com um filtro só');
