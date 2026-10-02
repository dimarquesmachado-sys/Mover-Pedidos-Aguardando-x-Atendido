'use strict';
// b9 — a Toolbox importa SOZINHA no Bling o que a vigia achou faltando (pedido do dono:
// "nao quero baixar nada, quero que ja migre pra dentro do Bling automaticamente").
// Servidor: extEstado/extRegistrar DE PRODUCAO com disco real. Toolbox: as funcoes de
// leitura da tela (tb-importacao.js, Node-testaveis) e o bloco do ct-nf.js por fonte.
const fs = require('fs');
const os = require('os');
const path = require('path');
let falhas = 0;
const ok = (c, o) => { if (!c) falhas++; console.log((c ? 'ok  ' : 'FALHA ') + o); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-full-ext-'));
process.env.ML_FULL_DIR = dir;
delete require.cache[require.resolve('../ml-full.js')];
const I = require('../ml-full.js')._interno;

// ── servidor: estado e registrar ──
{
  const ch = (n) => String(n).repeat(44).slice(0, 44);
  fs.mkdirSync(path.join(dir, 'saida'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'entrada'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'saida', 'girassol-111-' + ch(1) + '.xml'), '<x/>');
  fs.writeFileSync(path.join(dir, 'saida', 'girassol-222-' + ch(2) + '.xml'), '<x/>');
  fs.writeFileSync(path.join(dir, 'entrada', 'girassol-333-' + ch(3) + '.xml'), '<x/>');
  fs.writeFileSync(path.join(dir, 'saida', 'amb-444-' + ch(4) + '.xml'), '<x/>');   // outra empresa
  const e = I.extEstado('girassol');
  ok(e.novas_saida === 2 && e.novas_entrada === 1, '⚠️ estado: 2 de venda e 1 de devolucao pendentes da girassol (a da AMB nao entra)');
  ok(e.chaves_saida.includes(ch(1)) && e.chaves_entrada[0] === ch(3), '  ...com as chaves');
  const r = I.extRegistrar('girassol', [ch(1), ch(3), ch(9), 'lixo', ch(4)]);
  ok(r.arquivadas === 2 && r.ok, '⚠️ registrar: as 2 chaves da girassol saem do ZIP (vao pra importadas/)');
  ok(r.nao_achadas.includes(ch(9)) && r.nao_achadas.includes(ch(4)) && !r.nao_achadas.includes('lixo'), '  chave que nao esta salva (ou de outra empresa) volta em nao_achadas; lixo e ignorado');
  ok(fs.existsSync(path.join(dir, 'importadas', 'girassol-111-' + ch(1) + '.xml')), '  a copia foi pra importadas/ (historico preservado)');
  const e2 = I.extEstado('girassol');
  ok(e2.novas_saida === 1 && e2.novas_entrada === 0, '  estado depois: so a que nao foi registrada continua pendente');
  ok(fs.existsSync(path.join(dir, 'saida', 'amb-444-' + ch(4) + '.xml')), '  o arquivo da AMB ficou intacto (registrar e por empresa)');
  ok(I.extRegistrar('girassol', null).arquivadas === 0, '  registrar sem lista: nada, sem erro');
}
// ── servidor: rotas e CORS ──
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'ml-full.js'), 'utf8');
  ok(/p === '\/ml-full\/ext\/estado'/.test(src) && /p === '\/ml-full\/ext\/registrar'/.test(src), '  rotas /ml-full/ext/estado e /ml-full/ext/registrar');
  ok(/req\.method !== 'POST'/.test(src.slice(src.indexOf("'/ml-full/ext/registrar'"))), '  registrar so aceita POST');
  const idx = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const i = idx.indexOf("if (path.startsWith('/ml-full/'))");
  const bloco = idx.slice(i, i + 1400);
  ok(/res\.setHeader\('Access-Control-Allow-Origin', '\*'\)/.test(bloco), '⚠️ index.js: /ml-full/ libera a LEITURA pro content script (Allow-Origin)');
  ok(bloco.indexOf("method === 'OPTIONS'") < bloco.indexOf('lerChaveAdmin(req, urlObj) !== ADMIN_KEY'), '  o preflight (OPTIONS) responde ANTES da checagem da chave');
  ok(bloco.indexOf('lerChaveAdmin(req, urlObj) !== ADMIN_KEY') > 0, '  a chave continua obrigatoria');
}
// ── Toolbox: leitura da tela de importacao ──
{
  const t = require('../toolbox-extensao/tb-importacao.js');
  const html = '<select id="loja_xml" name="loja_xml"><option value="">Selecione</option><option value="111">SHOPEE</option><option value="222">Mercado Livre</option></select>'
             + '<select name="id_conf_unidade_negocio_xml"><option value="9">Matriz</option><option value="88">MLivre FULL</option></select>';
  const lojas = t.opcoesDoSelectBling(html, ['loja_xml']);
  const unid = t.opcoesDoSelectBling(html, ['id_conf_unidade_negocio_xml']);
  ok(lojas.length === 3 && lojas[2].v === '222' && unid[1].t === 'MLivre FULL', '  le as opcoes dos selects (por id OU name)');
  ok(t.opcoesDoSelectBling(html, ['nao_existe']) === null, '  select ausente: null');
  const e1 = t.escolherLojaUnidadeML(lojas, unid, {});
  ok(e1.loja === '222' && e1.unidade === '88', '⚠️ acha sozinho a loja Mercado Livre e a unidade FULL');
  ok(t.escolherLojaUnidadeML([{ v: '1', t: 'MLivre' }], null, {}).loja === '1', '  "MLivre" (nome da loja na AMB) tambem conta');
  const amb = t.escolherLojaUnidadeML([{ v: '1', t: 'Mercado Livre' }, { v: '2', t: 'Mercado Livre Full' }], null, {});
  ok(amb.loja === null && /ambigua/.test(amb.motivoLoja), '⚠️ duas lojas do ML: NAO escolhe (ambigua) — importar na loja errada e pior que nao importar');
  ok(t.escolherLojaUnidadeML([{ v: '1', t: 'SHOPEE' }], null, {}).loja === null, '  nenhuma loja do ML: nao escolhe');
  ok(t.escolherLojaUnidadeML(lojas, unid, { mlf_loja: '555', mlf_unidade: '77' }).loja === '555', '  configurada vence a deteccao');
  const sem = t.escolherLojaUnidadeML(lojas, null, {});
  ok(sem.unidade === '' && /nao tem unidade/.test(sem.motivoUnidade), '  tela sem unidade de negocio: vazio');
  const def = t.escolherLojaUnidadeML(lojas, [{ v: '9', t: 'Matriz' }, { v: '10', t: 'Filial' }], {});
  ok(def.unidade === '9' && /padrao/.test(def.motivoUnidade), '  sem unidade Full: o padrao da tela (o que o Bling usaria)');
}
// ── Toolbox: o bloco ML Full do ct-nf.js ──
{
  const ct = fs.readFileSync(path.join(__dirname, '..', 'toolbox-extensao', 'ct-nf.js'), 'utf8');
  const i = ct.indexOf('BLOCO ML FULL');
  const b = ct.slice(i);
  ok(i > 0, '  bloco ML Full existe');
  ok(/const args = \[tmp, tipo, loja, unidade, 'false', 'false'\];/.test(b), '⚠️ Lancar Contas NAO e Estoque NAO (espelha a nativa do Full)');
  ok(/if \(!res\.falhas_reais && !res\.corpo_vazio\)/.test(b) && /\/ml-full\/ext\/registrar/.test(b), '⚠️ so registra (tira do ZIP) quando NAO houve recusa real nem corpo vazio');
  ok(/'mlf_vinculo_' \+ empresa/.test(b) && /Conta errada/.test(b), '  trava de conta (vinculo aprendido na 1a importacao limpa)');
  ok(/if \(!esc\.loja\)/.test(b) && /Falta a loja/.test(b), '  loja indefinida: NAO importa, pede pra configurar');
  ok(/if \(cfg\.mlf_automatico\) verificar\(false\);/.test(b), '  ao abrir o Bling: silencioso (so aparece com nota faltando)');
  ok(/ev\.ctrlKey && ev\.altKey && \(ev\.key === 'f'/.test(b), '  Ctrl+Alt+F chama na mao');
  ok(/EMPRESA_DO_MOTOR\[String\(tb \|\| ''\)\.toLowerCase\(\)\]/.test(b), '  a empresa vem da instancia (tb_empresa)');
  ok(/mercado-livre|mover-pedidos-aguardando-x-atendido\.onrender\.com/.test(b), '  fala com o Mover-Pedidos');
  const man = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'toolbox-extensao', 'manifest.json'), 'utf8'));
  ok(man.version === '2.1.5', '  manifest 2.1.5');
  const cs = (man.content_scripts || []).find((c) => (c.js || []).includes('ct-nf.js'));
  ok(cs && cs.js.indexOf('tb-importacao.js') >= 0 && cs.js.indexOf('tb-importacao.js') < cs.js.indexOf('ct-nf.js'), '  tb-importacao.js carrega ANTES do ct-nf.js (as funcoes novas sao globais dele)');
}
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
console.log('');
console.log(falhas === 0 ? '=== TODOS OS CASOS PASSARAM' : '=== ' + falhas + ' FALHA(S)');
process.exit(falhas ? 1 : 0);
