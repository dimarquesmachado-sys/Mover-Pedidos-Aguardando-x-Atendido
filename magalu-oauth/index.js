'use strict';
// ════════════════════════════════════════════════════════════════════════
//  MAGALU OAUTH — conecta cada empresa à API oficial do Magalu Marketplace
//  e mantém um refresh_token vivo por empresa. (Mover-Pedidos)
//
//  POR QUÊ: o ↗ do Magalu precisa do UUID interno do pacote, que só a API
//  oficial dá. Diferente da Shopee (cookie), o Magalu usa OAuth 2.0 com
//  refresh_token — que NÃO expira sozinho como o cookie. Uma vez conectado,
//  o servidor renova o access_token (2h) pra sempre, sem intervenção.
//
//  FLUXO (uma vez por empresa):
//   1. admin abre  /magalu/conectar?empresa=girassol&k=ADMIN_KEY  (logado na
//      conta Magalu daquela empresa no navegador)
//   2. redireciona pro consentimento do id.magalu.com; o seller aprova
//   3. Magalu volta em /magalu/callback?code=...&state=girassol
//   4. trocamos o code por tokens e gravamos o refresh_token em
//      /data/magalu/<empresa>.json
//
//  DEPOIS: getAccessToken('girassol') devolve um access_token válido, usando
//  o refresh_token do disco e cacheando o access por ~110 min.
//
//  Este módulo NÃO mexe nos outros. É um handler global pendurado na raiz.
// ════════════════════════════════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');
const { json, html, readBody } = require('../lib/http');

const VERSAO = 'magalu-oauth v1 b42';

const DATA_DIR = process.env.MAGALU_DATA_DIR || '/data/magalu';

// ── ARQUIVADOR DAS NF-e DE FULFILLMENT ────────────────────────────────
// O cron baixa sozinho 2x por dia e guarda no disco do Render (/data é o
// volume persistente — sobrevive a deploy). O painel só lista o que já está
// pronto: o download vira instantâneo, sem esperar a Magalu gerar.
const NF_DIR         = process.env.MAGALU_NF_DIR || (DATA_DIR + '/nf-fulfillment');
const NF_EMPRESAS    = (process.env.MAGALU_NF_EMPRESAS || 'good,amb').split(',').map(x => x.trim()).filter(Boolean);
const NF_DIAS        = 31;   // janela puxada sempre: o Bling ignora as repetidas, entao vale pegar tudo
const NF_MANTER      = 20;   // quantos arquivos guardar por empresa (com 4 rodadas/dia da ~2,5 dias)
const NF_CRON        = process.env.MAGALU_NF_CRON || '0 6,12,18,23 * * *';   // 6h, 12h, 18h e 23h, TZ do servico (America/Sao_Paulo)

// Endpoints do ID Magalu (OAuth) e da API pública.
// A tela de consentimento é /login (NÃO /oauth/authorize — esse devolve JSON
// de pre-authorization em vez de renderizar a tela). choose_tenants=true faz o
// Magalu perguntar QUAL loja autorizar — essencial pra conta que vê várias.
const OAUTH_AUTHORIZE = 'https://id.magalu.com/login';
const OAUTH_TOKEN     = 'https://id.magalu.com/oauth/token';

// Precisa BATER com o --redirect-uris usado na criação do client no idm.
const REDIRECT_URI = process.env.MAGALU_REDIRECT_URI
  || 'https://mover-pedidos-aguardando-x-atendido.onrender.com/magalu/callback';

// Escopos que o client foi criado com (leitura de pedidos e afins).
const SCOPES = (process.env.MAGALU_SCOPES
  || 'open:order-order-seller:read open:order-delivery-seller:read open:order-delivery-seller:write open:order-invoice-seller:read open:order-logistics-seller:read open:order-logistics-seller:write open:order-financial-report-seller:read open:portfolio-prices-seller:read open:portfolio-prices-seller:write open:portfolio-skus-seller:read open:portfolio-skus-seller:write open:portfolio-stocks-seller:read open:portfolio-stocks-seller:write open:logistic-carrier-shippings:read'
).trim();

const EMPRESAS_VALIDAS = ['girassol', 'good', 'amb'];

// ── util de disco ────────────────────────────────────────────────────
function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} }
function lerJson(p, def) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return def; } }
function gravarJson(p, o) { ensureDir(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(o, null, 2)); }
function arqEmpresa(emp) { return path.join(DATA_DIR, emp + '.json'); }

function creds() {
  return {
    id:     String(process.env.MAGALU_CLIENT_ID || '').trim(),
    secret: String(process.env.MAGALU_CLIENT_SECRET || '').trim(),
    uuid:   String(process.env.MAGALU_CLIENT_UUID || '').trim()   // só p/ gerenciar o client na CLI (add-scope/update)
  };
}

// ── troca de code/refresh por tokens ─────────────────────────────────
// authorization_code: a doc do Magalu usa Content-Type application/json.
// refresh_token: a doc usa application/x-www-form-urlencoded.
// Mandamos cada um no formato que a doc especifica.
async function trocarToken(params) {
  const { id, secret } = creds();
  const ehCode = params.grant_type === 'authorization_code';
  let headers, body;
  if (ehCode) {
    headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    body = JSON.stringify(Object.assign({ client_id: id, client_secret: secret }, params));
  } else {
    headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' };
    body = new URLSearchParams(Object.assign({ client_id: id, client_secret: secret }, params)).toString();
  }
  const r = await fetch(OAUTH_TOKEN, { method: 'POST', headers, body });
  const txt = await r.text();
  let j = null; try { j = JSON.parse(txt); } catch (e) {}
  return { ok: r.ok, status: r.status, json: j, corpo: txt.slice(0, 500) };
}

// Devolve um access_token válido pra empresa, renovando via refresh_token se preciso.
// Guarda o access em cache no próprio arquivo da empresa (com validade).
async function getAccessToken(emp) {
  const arq = arqEmpresa(emp);
  const st = lerJson(arq, null);
  if (!st || !st.refresh_token) throw new Error('empresa ' + emp + ' não conectada (sem refresh_token)');

  const agora = Date.now();
  if (st.access_token && st.access_exp && agora < st.access_exp - 60000) {
    return st.access_token; // cache ainda válido (margem de 1 min)
  }

  const res = await trocarToken({ grant_type: 'refresh_token', refresh_token: st.refresh_token });
  if (!res.ok || !res.json || !res.json.access_token) {
    throw new Error('falha ao renovar token de ' + emp + ': HTTP ' + res.status + ' ' + res.corpo);
  }
  const j = res.json;
  st.access_token = j.access_token;
  st.access_exp   = agora + (Number(j.expires_in || 7200) * 1000);
  if (j.refresh_token) st.refresh_token = j.refresh_token; // refresh rotativo, se vier
  st.atualizado = new Date().toISOString();
  gravarJson(arq, st);
  return st.access_token;
}

// ── rotas ────────────────────────────────────────────────────────────
// São chamadas pelo handler global só quando o path começa com /magalu/.
async function tratar(req, res, urlObj) {
  const { method } = req;
  const p = urlObj.pathname;
  const q = urlObj.searchParams;

  // /magalu/conectar?empresa=girassol  → manda o admin pro consentimento
  if (method === 'GET' && p === '/magalu/conectar') {
    const emp = String(q.get('empresa') || '').toLowerCase().trim();
    if (!EMPRESAS_VALIDAS.includes(emp)) {
      json(res, 400, { ok: false, erro: 'empresa inválida', validas: EMPRESAS_VALIDAS });
      return true;
    }
    const { id, secret } = creds();
    if (!id || !secret) {
      json(res, 500, { ok: false, erro: 'faltam env MAGALU_CLIENT_ID / MAGALU_CLIENT_SECRET no Render' });
      return true;
    }
    const auth = OAUTH_AUTHORIZE
      + '?response_type=code'
      + '&client_id=' + encodeURIComponent(id)
      + '&redirect_uri=' + encodeURIComponent(REDIRECT_URI)
      + '&scope=' + encodeURIComponent(SCOPES)
      + '&choose_tenants=true'   // deixa o seller escolher QUAL loja está autorizando
      + '&prompt=consent'   // FORÇA a tela de permissões mesmo se já consentiu antes — necessário pra puxar ESCOPOS NOVOS no refresh token (senão a Magalu pula a tela e o token sai com os escopos antigos)
      + '&state=' + encodeURIComponent(emp);
    res.writeHead(302, { Location: auth, 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }

  // /magalu/callback?code=...&state=girassol  → troca o code por tokens
  if (method === 'GET' && p === '/magalu/callback') {
    const code = String(q.get('code') || '').trim();
    const emp  = String(q.get('state') || '').toLowerCase().trim();
    const erroOAuth = q.get('error');

    if (erroOAuth) {
      html(res, 400, paginaSimples('Consentimento negado', 'O Magalu retornou: ' + esc(erroOAuth) + '. Tente de novo em /magalu/conectar?empresa=' + esc(emp)));
      return true;
    }
    if (!code || !EMPRESAS_VALIDAS.includes(emp)) {
      html(res, 400, paginaSimples('Callback inválido', 'Faltou code ou state válido. Recomece por /magalu/conectar?empresa=girassol'));
      return true;
    }

    const res2 = await trocarToken({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: REDIRECT_URI
    });
    if (!res2.ok || !res2.json || !res2.json.refresh_token) {
      html(res, 502, paginaSimples('Falha ao obter token',
        'HTTP ' + res2.status + '<br><pre style="white-space:pre-wrap">' + esc(res2.corpo) + '</pre>'));
      return true;
    }
    const j = res2.json;
    gravarJson(arqEmpresa(emp), {
      empresa: emp,
      refresh_token: j.refresh_token,
      access_token: j.access_token || null,
      access_exp: j.access_token ? (Date.now() + Number(j.expires_in || 7200) * 1000) : 0,
      escopo: j.scope || SCOPES,
      conectado_em: new Date().toISOString(),
      atualizado: new Date().toISOString()
    });
    html(res, 200, paginaSimples('✅ ' + emp.toUpperCase() + ' conectada',
      'Refresh token guardado. Essa empresa não precisa mais consentir.<br><br>'
      + 'Confira em <a href="/magalu/status?k=' + esc(q.get('k') || '') + '">/magalu/status</a> '
      + '(precisa da ADMIN_KEY).'));
    return true;
  }

  // /magalu/status  → o que já está conectado (admin)
  if (method === 'GET' && p === '/magalu/status') {
    const out = {};
    for (const emp of EMPRESAS_VALIDAS) {
      const st = lerJson(arqEmpresa(emp), null);
      out[emp] = st
        ? { conectado: true, conectado_em: st.conectado_em || null, atualizado: st.atualizado || null,
            tem_refresh: !!st.refresh_token, escopo: st.escopo || null }
        : { conectado: false };
    }
    const c = creds();
    const mask = s => !s ? null : (s.length <= 8 ? '…' : s.slice(0, 4) + '…' + s.slice(-4));
    json(res, 200, { ok: true, versao: VERSAO, client_configurado: !!(c.id && c.secret),
      client_uuid: mask(c.uuid), redirect_uri: REDIRECT_URI, escopos: SCOPES, empresas: out });
    return true;
  }

  // /magalu/teste?empresa=girassol  → tira um access token a limpo (admin), sem chamar a API de pedidos ainda
  if (method === 'GET' && p === '/magalu/teste') {
    const emp = String(q.get('empresa') || '').toLowerCase().trim();
    if (!EMPRESAS_VALIDAS.includes(emp)) { json(res, 400, { ok: false, erro: 'empresa inválida' }); return true; }
    try {
      const tok = await getAccessToken(emp);
      json(res, 200, { ok: true, empresa: emp, access_token_len: tok.length,
        preview: tok.slice(0, 12) + '…', versao: VERSAO });
    } catch (e) {
      json(res, 502, { ok: false, empresa: emp, erro: String(e.message || e) });
    }
    return true;
  }

  // ── NF-e FULFILLMENT: painel + download do ZIP ───────────────────────
  //  /magalu/nf-full?k=ADMIN_KEY                          → painel
  //  /magalu/nf-full/baixar?empresa=amb&de=X&ate=Y&k=...  → devolve o .zip
  //
  //  CONTRATO DA API (confirmado na sonda de 26-27/07, AMB e GOOD):
  //    GET /seller/v1/invoices/fulfillment?start_date=AAAA-MM-DD&end_date=AAAA-MM-DD
  //    → 200 {"expires_on":"...","signed_url":"https://storage.googleapis.com/...zip"}
  //    O link e assinado e vale ~30 min. O ZIP tem os XMLs do periodo.
  //  Outros status que a API devolve e o que significam:
  //    408 REQUEST_TIMEOUT  → "esta sendo processado, tente de novo" (geracao assincrona)
  //    429 TOO_MANY_REQUESTS→ chamou rapido demais; espacar alguns segundos resolve
  //    503                  → instabilidade momentanea do lado deles
  //  Por isso o nfPedirLink (no arquivador, mais abaixo) REPETE em vez de desistir.
  //
  //  ⚠ TRAVA DE ADMIN: o index.js da RAIZ so exige ADMIN_KEY nos paths que
  //  estao na lista precisaAdmin dele, e /magalu/nf-full NAO esta nessa lista
  //  (de proposito — nao quis mexer no orquestrador). Entao a trava e feita
  //  AQUI DENTRO. Sem ela a rota ficaria publica e qualquer um baixaria as NFs.
  // ── ROTAS QUE A EXTENSAO DO CHROME USA ────────────────────────────
  //  A extensao roda DENTRO da aba do bling.com.br, entao o upload sai da
  //  sessao real do Diego — nada de cookie guardado, IP forjado ou User-Agent
  //  inventado. Ela so precisa de duas coisas daqui: saber o que esta
  //  pendente e baixar o ZIP ja separado por tipo.
  //  Por isso essas rotas (e a de baixar arquivo) liberam CORS pro bling.
  if (p.indexOf('/magalu/nf-full') === 0) {
    const origem = (req.headers && req.headers.origin) || '';
    if (/^https:\/\/(www\.)?bling\.com\.br$/.test(origem)) {
      res.setHeader('Access-Control-Allow-Origin', origem);
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Vary', 'Origin');
    }
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
  }

  if (p === '/magalu/nf-full' || p === '/magalu/nf-full/baixar' || p === '/magalu/nf-full/arquivo' || p === '/magalu/nf-full/rodar' || p === '/magalu/nf-full/importar' || p === '/magalu/nf-full/cookie' || p === '/magalu/nf-full/cookie-testar' || p === '/magalu/nf-full/ext/estado' || p === '/magalu/nf-full/ext/registrar' || p === '/magalu/nf-full/diag') {
    const CHAVE_ADMIN = process.env.ADMIN_KEY || '';
    if (!CHAVE_ADMIN || q.get('k') !== CHAVE_ADMIN) { json(res, 404, { error: 'not found', path: p }); return true; }

    const eData = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
    const fmtD  = d => d.toISOString().slice(0, 10);

    // ── ENTREGA UM ARQUIVO JA ARQUIVADO (instantaneo) ──
    if (p === '/magalu/nf-full/arquivo') {
      const nome = String(q.get('nome') || '');
      // so aceita o padrao exato do arquivador — barra qualquer ../ ou nome torto
      if (!/^[a-z]+-\d{4}-\d{2}-\d{2}-\d{4}\.zip$/.test(nome)) { json(res, 400, { ok: false, erro: 'nome inválido' }); return true; }
      const cheio = path.join(NF_DIR, nome);
      let buf; try { buf = fs.readFileSync(cheio); } catch (e) { json(res, 404, { ok: false, erro: 'arquivo não está mais no disco' }); return true; }

      // tipo=saida  → vendas + remessas (tpNF=1)
      // tipo=entrada→ retornos simbólicos (tpNF=0)
      // sem tipo    → o ZIP original, do jeito que a Magalu mandou
      const tipo = String(q.get('tipo') || '').toLowerCase();
      const soNovas = String(q.get('novas') || '').toLowerCase().trim();   // valor = a empresa
      let saida_nome = nome;
      if (tipo === 'saida' || tipo === 'entrada') {
        let sep; try { sep = nfSeparar(buf); } catch (e) { json(res, 500, { ok: false, erro: 'não consegui abrir o zip: ' + String(e.message || e) }); return true; }
        let itens = (tipo === 'saida' ? sep.saida : sep.entrada);
        if (soNovas && BLING_IMP[soNovas]) {
          const impx = nfLerImportadas(soNovas);
          const ja = new Set(tipo === 'entrada' ? impx.entrada : impx.saida);
          itens = itens.filter(it => it.chave && !ja.has(it.chave));
        }
        if (!itens.length) { json(res, 404, { ok: false, erro: soNovas ? 'nenhuma nota nova nesse arquivo' : 'não há notas de ' + tipo + ' nesse arquivo' }); return true; }
        try { buf = nfMontarZip(itens); } catch (e) { json(res, 500, { ok: false, erro: 'falha ao montar o zip: ' + String(e.message || e) }); return true; }
        saida_nome = nome.replace(/\.zip$/, '') + '-' + (tipo === 'saida' ? 'SAIDA' : 'ENTRADA') + '.zip';
      }

      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="' + saida_nome + '"',
        'Content-Length': buf.length
      });
      res.end(buf);
      return true;
    }

    // ── MEDIDOR: ate que momento a exportacao da Magalu esta em dia ──
    //  Serve pra responder uma pergunta so: "a nota que falta no Bling nao
    //  veio porque o robo nao rodou, ou porque a Magalu ainda nao a colocou
    //  no pacote?". Le as datas de emissao (dhEmi) de dentro dos XMLs.
    if (p === '/magalu/nf-full/diag') {
      const empD = String(q.get('empresa') || '').toLowerCase().trim();
      if (!BLING_IMP[empD]) { json(res, 400, { ok: false, erro: 'empresa inválida (use good ou amb)' }); return true; }
      // ── MODO AO VIVO: /diag?empresa=amb&de=...&ate=... ──────────────
      //  Pede o pacote a Magalu NA HORA, com o intervalo que voce mandar, e
      //  diz ate que nota ele vai. Serve pra separar duas causas:
      //    - se um intervalo DIFERENTE traz notas mais recentes que o nosso
      //      arquivo do dia, entao a Magalu esta devolvendo CACHE por
      //      intervalo (o caminho do zip no storage inclui as datas)
      //    - se nem assim vem, a exportacao deles e que esta atrasada
      //  Nao grava nada, nao mexe no controle de chaves.
      const dvDe = String(q.get('de') || '').trim();
      const dvAte = String(q.get('ate') || '').trim();
      if (dvDe && dvAte) {
        let buf6;
        try { buf6 = await nfBaixarZip(empD, dvDe, dvAte); }
        catch (e) { json(res, 502, { ok: false, empresa: empD, periodo: { de: dvDe, ate: dvAte }, erro: String(e.message || e) }); return true; }
        let sep6; try { sep6 = nfSeparar(buf6); } catch (e) { json(res, 500, { ok: false, erro: String(e.message || e) }); return true; }
        const notas6 = sep6.saida.map(it => {
          const t = it.dados.toString('utf8', 0, Math.min(it.dados.length, 6000));
          return {
            numero: (/<nNF>(\d+)<\/nNF>/.exec(t) || [])[1] || null,
            emitida: (/<dhEmi>([^<]+)<\/dhEmi>/.exec(t) || [])[1] || null,
            destinatario: (/<dest>[\s\S]*?<xNome>([^<]+)<\/xNome>/.exec(t) || [])[1] || null
          };
        }).filter(x => x.emitida).sort((a7, b7) => a7.emitida.localeCompare(b7.emitida));
        json(res, 200, {
          ok: true, ao_vivo: true, empresa: empD, versao: VERSAO,
          agora_sp: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
          periodo: { de: dvDe, ate: dvAte },
          bytes: buf6.length, saida: sep6.saida.length, entrada: sep6.entrada.length,
          nota_mais_recente: notas6.length ? notas6[notas6.length - 1].emitida : null,
          ultimas_8: notas6.slice(-8)
        });
        return true;
      }

      const arqs = nfListar(empD);
      if (!arqs.length) { json(res, 200, { ok: true, empresa: empD, erro: 'nenhum arquivo baixado' }); return true; }

      const quantos = Math.min(parseInt(q.get('arquivos') || '4', 10) || 4, 10);
      const olhar = arqs.slice(0, quantos);
      const relatorio = olhar.map(a => {
        let sep; try { sep = nfSeparar(fs.readFileSync(path.join(NF_DIR, a.nome))); }
        catch (e) { return { arquivo: a.nome, erro: String(e.message || e) }; }
        const notas = sep.saida.map(it => {
          const t = it.dados.toString('utf8', 0, Math.min(it.dados.length, 6000));
          const dh = (/<dhEmi>([^<]+)<\/dhEmi>/.exec(t) || [])[1] || null;
          const nn = (/<nNF>(\d+)<\/nNF>/.exec(t) || [])[1] || null;
          const dest = (/<dest>[\s\S]*?<xNome>([^<]+)<\/xNome>/.exec(t) || [])[1] || null;
          return { numero: nn, emitida: dh, destinatario: dest, chave: it.chave };
        }).filter(x => x.emitida).sort((a2, b2) => a2.emitida.localeCompare(b2.emitida));

        return {
          arquivo: a.nome,
          baixado_em: a.em,
          saida: sep.saida.length, entrada: sep.entrada.length,
          nota_mais_antiga: notas.length ? notas[0].emitida : null,
          nota_mais_recente: notas.length ? notas[notas.length - 1].emitida : null,
          ultimas_5: notas.slice(-5)
        };
      });

      json(res, 200, {
        ok: true, empresa: empD, versao: VERSAO,
        agora_sp: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
        leia: 'Compare o "nota_mais_recente" de cada arquivo. Se os arquivos das 12h e 18h pararem na mesma nota do arquivo da manhã, a exportação da Magalu é que está atrasada — não o robô.',
        arquivos: relatorio
      });
      return true;
    }

    // ── EXTENSAO: o que esta pendente pra empresa logada ──
    //  A extensao manda o idEmpresa que leu da propria pagina do Bling, e a
    //  gente responde de quem e e o que falta. Assim ela nunca importa na
    //  conta errada — a fonte da verdade e a pagina, nao um chute.
    if (p === '/magalu/nf-full/ext/estado') {
      const idEmp = String(q.get('idEmpresa') || '').trim();
      const emp3 = Object.keys(BLING_IMP).find(e => String(BLING_IMP[e].idEmpresa) === idEmp);
      if (!emp3) { json(res, 404, { ok: false, erro: 'idEmpresa não reconhecido: ' + idEmp, conhecidos: Object.keys(BLING_IMP).map(e => ({ empresa: e, idEmpresa: BLING_IMP[e].idEmpresa })) }); return true; }

      const arqs = nfListar(emp3);
      if (!arqs.length) { json(res, 200, { ok: true, empresa: emp3, precisa: false, motivo: 'nenhum arquivo baixado ainda' }); return true; }
      const novoArq = arqs[0];
      // ANTES era "ja importou hoje?" — o que travava tudo depois da
      // primeira importacao do dia. Agora a pergunta e outra: "o arquivo
      // mais novo ja foi importado?". Assim, quantas vezes o cron rodar,
      // tantas levas a extensao importa — sem repetir a mesma.
      // A pergunta certa nao e "esse arquivo ja foi importado?" e sim
      // "tem NOTA nova aqui dentro?". Sem isso, as 4 rodadas diarias
      // mandariam o mesmo lote pro Bling rejeitar inteiro, todo dia.
      const ultimo = nfLerImportadas(emp3);
      let nS = [], tS = 0, nE = [], tE = 0;
      try {
        const rS = nfNovasDoArquivo(emp3, novoArq.nome, 'S'); nS = rS.novas; tS = rS.todas.length;
        const rE = nfNovasDoArquivo(emp3, novoArq.nome, 'E'); nE = rE.novas; tE = rE.todas.length;
      } catch (e) { json(res, 500, { ok: false, erro: 'não consegui abrir o zip: ' + String(e.message || e) }); return true; }

      const url = (t) => '/magalu/nf-full/arquivo?nome=' + encodeURIComponent(novoArq.nome) + '&tipo=' + t + '&novas=' + emp3 + '&k=' + encodeURIComponent(q.get('k') || '');

      json(res, 200, {
        ok: true, empresa: emp3, versao: VERSAO,
        arquivo: novoArq.nome, baixado_em: novoArq.em, notas: novoArq.notas,
        saida_no_arquivo: tS, entrada_no_arquivo: tE,
        novas: nS.length,              // compatibilidade com a extensao 1.0.5
        novas_saida: nS.length,
        novas_entrada: nE.length,
        precisa: (nS.length + nE.length) > 0,
        ja_importado_hoje: (nS.length + nE.length) ? null : { quando: ultimo.quando, arquivo: ultimo.arquivo, resumo: ultimo.resumo },
        ultima_importacao: ultimo.quando ? { quando: ultimo.quando, arquivo: ultimo.arquivo, guardadas_saida: ultimo.saida.length, guardadas_entrada: ultimo.entrada.length } : null,
        url_zip_saida: url('saida'),
        url_zip_entrada: url('entrada')
      });
      return true;
    }

    // ── EXTENSAO: registra o que o Bling respondeu ──
    if (p === '/magalu/nf-full/ext/registrar' && method === 'POST') {
      let corpo3 = {};
      try { corpo3 = await readBody(req); } catch (e) {}
      const emp4 = String(corpo3.empresa || '').toLowerCase();
      if (!BLING_IMP[emp4]) { json(res, 400, { ok: false, erro: 'empresa inválida' }); return true; }
      // Marca como importadas as chaves que estavam no lote enviado.
      // So chega aqui se a extensao concluiu — ela nao registra em caso de erro.
      const tipoReg = (String(corpo3.tipo || 'S').toUpperCase() === 'E') ? 'entrada' : 'saida';
      const antes = nfLerImportadas(emp4);
      const jaTinha = new Set(antes[tipoReg]);
      let acrescentadas = 0;
      try {
        const r6 = nfNovasDoArquivo(emp4, String(corpo3.arquivo || ''), tipoReg === 'entrada' ? 'E' : 'S');
        r6.novas.forEach(it => { if (!jaTinha.has(it.chave)) { jaTinha.add(it.chave); acrescentadas++; } });
      } catch (e) {}
      const reg = {
        quando: new Date().toISOString(), arquivo: corpo3.arquivo || null, resumo: corpo3.resumo || null, via: 'extensao',
        saida:   tipoReg === 'saida'   ? Array.from(jaTinha) : antes.saida,
        entrada: tipoReg === 'entrada' ? Array.from(jaTinha) : antes.entrada
      };
      nfGravarImportadas(emp4, reg);
      console.log('[magalu-nf] extensão importou ' + emp4 + ' (' + tipoReg + '): +' + acrescentadas + ' chaves novas');
      json(res, 200, { ok: true, empresa: emp4, tipo: tipoReg, chaves_novas: acrescentadas, guardadas_saida: reg.saida.length, guardadas_entrada: reg.entrada.length });
      return true;
    }

    // ── TESTA SE A SESSAO DO BLING ESTA VIVA (so leitura) ──
    if (p === '/magalu/nf-full/cookie-testar') {
      const emp2 = String(q.get('empresa') || '').toLowerCase().trim();
      if (!BLING_IMP[emp2]) { json(res, 400, { ok: false, erro: 'empresa inválida (use good ou amb)' }); return true; }
      const r2 = await blingTestarSessao(emp2);
      json(res, r2.viva ? 200 : 502, { empresa: emp2, versao: VERSAO, ...r2 });
      return true;
    }

    // ── PAGINA DE COLAR O COOKIE DO BLING ──
    // /magalu/nf-full/cookie?empresa=amb&k=ADMIN_KEY
    // Mesma ideia do /cookie-setup da Girassol: cola e salva em disco, sem
    // redeploy. Aceita o "Copiar como cURL" inteiro — ele extrai o cookie.
    if (p === '/magalu/nf-full/cookie') {
      const emp = String(q.get('empresa') || '').toLowerCase().trim();
      if (!BLING_IMP[emp]) { json(res, 400, { ok: false, erro: 'empresa inválida (use good ou amb)' }); return true; }
      const kq = encodeURIComponent(q.get('k') || '');
      const NOMES = { good: 'GOOD Import', amb: 'AMBTotal' };

      if (method === 'POST') {
        let corpo = {};
        try { corpo = await readBody(req); } catch (e) {}
        const bruto = String(corpo.texto || '');
        const cookie = blingExtrairCookie(bruto);
        if (!cookie || cookie.length < 20 || cookie.indexOf('=') < 0) {
          json(res, 400, { ok: false, erro: 'não achei um cookie válido no que você colou' }); return true;
        }
        const conf = blingConferirCookie(cookie);
        if (!conf.ok) { json(res, 400, { ok: false, erro: conf.erro, posicao: conf.posicao, trecho_ao_redor: cookie.slice(Math.max(0, conf.posicao - 40), conf.posicao + 20) }); return true; }
        try { blingSalvarCookie(emp, cookie, blingExtrairUA(bruto)); } catch (e) { json(res, 500, { ok: false, erro: String(e.message || e) }); return true; }
        json(res, 200, { ok: true, empresa: emp, caracteres: cookie.length, tem_phpsessid: /PHPSESSID=/i.test(cookie), user_agent: blingExtrairUA(bruto) || '(não veio no que você colou — vou usar um padrão)' });
        return true;
      }

      const atual = blingLerCookie(emp);
      const confAtual = atual ? blingConferirCookie(atual) : { ok: true };
      const st = (atual && !confAtual.ok) ? '<p class="nao">⚠ O cookie salvo está inválido: ' + confAtual.erro + '</p>' : atual
        ? '<p class="ok">✓ Já tem cookie salvo para ' + (NOMES[emp] || emp) + ' (' + atual.length + ' caracteres' + (/PHPSESSID=/i.test(atual) ? ', com PHPSESSID' : ', <b>sem PHPSESSID — suspeito</b>') + '). Cole de novo pra atualizar.</p>'
        : '<p class="nao">Nenhum cookie salvo para ' + (NOMES[emp] || emp) + ' ainda.</p>';

      html(res, 200, `<!doctype html><html lang="pt-br"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Cookie Bling — ${NOMES[emp] || emp}</title><style>
body{font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1115;color:#e8eaed;margin:0;padding:24px}
.wrap{max-width:720px;margin:0 auto}h1{font-size:20px;margin:0 0 16px}
.card{background:#181b21;border:1px solid #2a2f3a;border-radius:10px;padding:18px;margin-bottom:16px}
textarea{width:100%;height:150px;background:#0f1115;color:#e8eaed;border:1px solid #2a2f3a;border-radius:6px;padding:10px;font-family:ui-monospace,Menlo,monospace;font-size:12px}
button{background:#1a73e8;color:#fff;border:0;padding:12px 20px;border-radius:8px;font:inherit;font-weight:600;cursor:pointer;margin-top:12px}
.ok{color:#81c995}.nao{color:#f28b82}ol{padding-left:20px}li{margin-bottom:6px}
.msg{margin-top:12px;font-weight:600;display:none}a{color:#8ab4f8}
</style></head><body><div class="wrap">
<h1>Cookie do Bling — ${NOMES[emp] || emp}</h1>
<div class="card">
  ${st}
  <ol>
    <li>Abra o Bling <b>logado na conta da ${NOMES[emp] || emp}</b></li>
    <li>F12 → aba <b>Rede</b> → clique em qualquer requisição para bling.com.br</li>
    <li>Botão direito → <b>Copiar</b> → <b>Copiar como cURL</b></li>
    <li>Cole tudo aqui embaixo e salve — eu extraio só o cookie</li>
  </ol>
  <textarea id="t" placeholder="cole aqui o cURL inteiro, ou só a linha do Cookie"></textarea>
  <button id="b">Salvar cookie</button>
  <a href="/magalu/nf-full/cookie-testar?empresa=${emp}&k=${kq}" style="display:inline-block;margin-left:10px;margin-top:12px;background:#2a2f3a;color:#e8eaed;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Testar sessão</a>
  <div class="msg" id="m"></div>
</div>
<div class="card" style="font-size:13px;color:#9aa0a6">
  Fica salvo em disco, não em variável de ambiente — por isso não derruba o serviço.<br>
  Vai vencer de tempos em tempos: quando vencer, o envio falha avisando, e você volta aqui e cola de novo.<br><br>
  <a href="/magalu/nf-full?k=${kq}">← voltar para o painel</a>
</div>
</div><script>
document.getElementById('b').addEventListener('click', async function(){
  var m = document.getElementById('m'); m.style.display='block'; m.style.color='#9aa0a6'; m.textContent='Salvando...';
  try{
    var r = await fetch(location.pathname + location.search, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({texto: document.getElementById('t').value})});
    var j = await r.json();
    if(j.ok){ m.style.color='#81c995'; m.textContent='✓ Salvo (' + j.caracteres + ' caracteres' + (j.tem_phpsessid?', com PHPSESSID':', SEM PHPSESSID — confira') + ')'; document.getElementById('t').value=''; }
    else { m.style.color='#f28b82'; m.textContent='✗ ' + (j.erro || 'falhou'); }
  }catch(e){ m.style.color='#f28b82'; m.textContent='✗ ' + e.message; }
});
</script></body></html>`);
      return true;
    }

    // ── MANDA UM ARQUIVO JA BAIXADO PRO BLING ──
    // /magalu/nf-full/importar?empresa=amb&nome=amb-2026-07-27-0900.zip&tipo=saida&k=
    if (p === '/magalu/nf-full/importar') {
      const emp = String(q.get('empresa') || '').toLowerCase().trim();
      const nome = String(q.get('nome') || '');
      const tipo = String(q.get('tipo') || 'saida').toLowerCase() === 'entrada' ? 'E' : 'S';
      if (!BLING_IMP[emp]) { json(res, 400, { ok: false, erro: 'empresa sem configuração de Bling: ' + emp }); return true; }
      if (!/^[a-z]+-\d{4}-\d{2}-\d{2}-\d{4}\.zip$/.test(nome)) { json(res, 400, { ok: false, erro: 'nome inválido' }); return true; }
      let buf; try { buf = fs.readFileSync(path.join(NF_DIR, nome)); } catch (e) { json(res, 404, { ok: false, erro: 'arquivo não está mais no disco' }); return true; }
      try {
        const r = await blingImportar(emp, buf, tipo);
        json(res, 200, { ok: true, versao: VERSAO, arquivo: nome, ...r });
      } catch (e) {
        const msg = String(e.message || e);
        json(res, 502, {
          ok: false, arquivo: nome, empresa: emp, erro: msg,
          dica: msg.indexOf('COOKIE_EXPIRADO') === 0
            ? 'O cookie do Bling venceu. Recole em /magalu/nf-full/cookie?empresa=' + emp + ' (botão direito na requisição > Copiar como cURL).'
            : undefined
        });
      }
      return true;
    }

    // ── RODA A ROTINA NA MAO (mesma coisa que o cron faz) ──
    if (p === '/magalu/nf-full/rodar') {
      const so = String(q.get('empresa') || '').toLowerCase().trim();
      if (so && NF_EMPRESAS.indexOf(so) < 0) { json(res, 400, { ok: false, erro: 'empresa inválida: ' + so }); return true; }
      const d = nfDisparar('manual', so ? [so] : null);
      const kq2 = encodeURIComponent(q.get('k') || '');
      // Responde JA, com uma pagina que se atualiza sozinha — em vez de
      // segurar a conexao por minutos deixando a tela em branco.
      html(res, 200, `<!doctype html><html lang="pt-br"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="15;url=/magalu/nf-full?k=${kq2}">
<title>Buscando na Magalu…</title><style>
body{font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1115;color:#e8eaed;margin:0;padding:44px 24px;text-align:center}
.sp{width:38px;height:38px;margin:0 auto 22px;border:4px solid #2a2f3a;border-top-color:#1a73e8;border-radius:50%;animation:g 1s linear infinite}
@keyframes g{to{transform:rotate(360deg)}}
h1{font-size:19px;margin:0 0 10px}p{color:#9aa0a6;max-width:540px;margin:10px auto}
a{color:#8ab4f8}.box{background:#181b21;border:1px solid #2a2f3a;border-radius:10px;padding:18px;max-width:560px;margin:24px auto;text-align:left;font-size:13px;color:#9aa0a6}
</style></head><body>
<div class="sp"></div>
<h1>${d.disparou ? 'Buscando na Magalu…' : 'Já tem uma busca rodando'}</h1>
<p>Em 15 segundos eu te levo pro painel. <b>Pode fechar a aba</b> — o trabalho continua no servidor.</p>
<div class="box">
Pode levar vários minutos. A Magalu limita quantas vezes seguidas dá pra pedir o arquivo, e
quando ela responde "espera um pouco" o robô espera de verdade — 30s, 1min, 2min, 4min — em
vez de desistir. As duas empresas são pedidas com 2 minutos de intervalo, pelo mesmo motivo.
No painel aparece o andamento.
</div>
<p><a href="/magalu/nf-full?k=${kq2}">← ir agora pro painel</a></p>
</body></html>`);
      return true;
    }

    // ── PAINEL ──
    if (p === '/magalu/nf-full') {
      const hoje = new Date();
      // fmtD era UTC: depois das 21h de Brasilia o campo "Ate" vinha com amanha
      const pad = nfHojeSP(hoje), pde = nfHojeSP(new Date(hoje.getTime() - 30 * 864e5));
      const kq = encodeURIComponent(q.get('k') || '');
      const NOMES = { good: 'GOOD Import', amb: 'AMBTotal', girassol: 'Girassol' };
      const prontos = nfListar(null);
      // bloco de andamento: enquanto roda, a pagina se recarrega sozinha
      const est = nfLerEstado();
      let andamento = '';
      if (nfRodando) {
        andamento = '<div class="card" style="border-color:#1a73e8"><div class="tit" style="color:#8ab4f8">Buscando na Magalu agora…</div>'
                  + '<div style="font-size:13px;color:#9aa0a6">Começou às ' + (est && est.inicio ? new Date(est.inicio).toLocaleTimeString('pt-BR') : '?')
                  + ' — empresas: ' + ((est && est.empresas) || []).join(', ')
                  + '. Pode levar vários minutos; esta página se atualiza sozinha.</div></div>';
      } else if (est && est.fim) {
        const houveErro = (est.resultado || []).some(x => !x.ok) || est.erro;
        andamento = '<div class="card" style="border-color:' + (houveErro ? '#f28b82' : '#2a2f3a') + '">'
                  + '<div class="tit">Última busca — ' + new Date(est.fim).toLocaleString('pt-BR') + '</div>'
                  + '<div style="font-size:13px;color:#9aa0a6">'
                  + (est.erro ? 'Erro: ' + est.erro : (est.resultado || []).map(x =>
                      (x.empresa === 'good' ? 'GOOD' : 'AMB') + ': ' + (x.ok ? '✓ ' + (x.notas ? (x.notas.saida + ' saída / ' + x.notas.entrada + ' entrada') : 'ok') : '✗ ' + x.erro)
                    ).join('<br>'))
                  + '</div></div>';
      }
      const linhas = prontos.length
        ? prontos.map(f => {
            const d = f.em ? new Date(f.em) : null;
            const quando = d ? (String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0') + ' às ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0')) : '?';
            const base = '/magalu/nf-full/arquivo?nome=' + encodeURIComponent(f.nome) + '&k=' + kq;
            const n = f.notas || {};
            const qs = (x) => (typeof x === 'number' ? ' (' + x + ')' : '');
            return '<div class="arq">'
                 + '<div class="cab"><span class="emp">' + (NOMES[f.empresa] || f.empresa) + '</span>'
                 + '<span class="qd">' + quando + '</span>'
                 + '<span class="tam">' + (f.bytes / 1024 < 1024 ? Math.round(f.bytes/1024) + ' KB' : (f.bytes/1048576).toFixed(1) + ' MB') + '</span></div>'
                 + '<div class="acoes">'
                 + '<a class="mini azul" href="' + base + '&tipo=saida">Notas de SAÍDA' + qs(n.saida) + '</a>'
                 + '<a class="mini roxo" href="' + base + '&tipo=entrada">Notas de ENTRADA' + qs(n.entrada) + '</a>'
                 + '<a class="mini" href="' + base + '">tudo junto</a>'
                 + (BLING_IMP[f.empresa] && BLING_IMP[f.empresa].cookie()
                     ? '<a class="mini verde" href="/magalu/nf-full/importar?empresa=' + f.empresa + '&nome=' + encodeURIComponent(f.nome) + '&tipo=saida&k=' + kq + '">→ mandar pro Bling</a>'
                     : '')
                 + '</div></div>';
          }).join('')
        : '<p class="vazio">Nada arquivado ainda. O robô roda às 6h, 12h, 18h e 23h. Se quiser adiantar, clique em <b>Rodar agora</b>.</p>';
      html(res, 200, `<!doctype html><html lang="pt-br"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${nfRodando ? '<meta http-equiv="refresh" content="15">' : ''}
<title>NF-e Fulfillment Magalu</title><style>
*{box-sizing:border-box}body{font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1115;color:#e8eaed;margin:0;padding:24px}
.wrap{max-width:620px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}
p.sub{color:#9aa0a6;margin:0 0 24px;font-size:13px}
.card{background:#181b21;border:1px solid #2a2f3a;border-radius:10px;padding:18px;margin-bottom:16px}
label{display:block;font-size:12px;color:#9aa0a6;margin-bottom:5px}
input[type=date]{background:#0f1115;color:#e8eaed;border:1px solid #2a2f3a;border-radius:6px;padding:9px;font:inherit;width:100%}
.linha{display:flex;gap:12px;margin-bottom:16px}.linha>div{flex:1}
.btns{display:flex;gap:12px;flex-wrap:wrap}
a.btn{flex:1;min-width:120px;text-align:center;text-decoration:none;background:#1a73e8;color:#fff;padding:13px 16px;border-radius:8px;font-weight:600}
a.btn.good{background:#0f9d58}a.btn:hover{opacity:.9}
.aviso{font-size:12px;color:#9aa0a6;margin-top:14px;padding-top:14px;border-top:1px solid #2a2f3a}
.erro{color:#f28b82;font-size:13px;margin-top:10px;display:none}
.tit{font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:#9aa0a6;margin-bottom:12px}
.arq{padding:12px 12px 10px;border-radius:7px;border:1px solid #2a2f3a;margin-bottom:10px;background:#0f1115}
.cab{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.emp{font-weight:600;flex:1}.qd{color:#9aa0a6;font-size:13px}.tam{color:#9aa0a6;font-size:12px}
.acoes{display:flex;gap:8px;flex-wrap:wrap}
a.mini{text-decoration:none;font-size:12.5px;font-weight:600;padding:7px 11px;border-radius:6px;background:#2a2f3a;color:#e8eaed}
a.mini.azul{background:#1a73e8;color:#fff}a.mini.roxo{background:#6f42c1;color:#fff}a.mini.verde{background:#0f9d58;color:#fff}a.mini:hover{opacity:.88}
a.btn.cinza{background:#2a2f3a;color:#e8eaed}
p.vazio{color:#9aa0a6;font-size:13px;margin:0}
</style></head><body><div class="wrap">
<h1>NF-e Fulfillment — Magalu</h1>
<p class="sub">O robô baixa sozinho às 6h, 12h, 18h e 23h. A extensão importa no Bling quando você abre o sistema.</p>
${andamento}
<div class="card">
  <div class="tit">Prontos pra baixar</div>
  ${linhas}
  <div class="btns" style="margin-top:14px">
    <a class="btn cinza" href="/magalu/nf-full/rodar?k=${kq}">Rodar agora (as duas)</a>
    <a class="btn cinza" href="/magalu/nf-full/rodar?empresa=amb&k=${kq}">só AMB</a>
    <a class="btn cinza" href="/magalu/nf-full/rodar?empresa=good&k=${kq}">só GOOD</a>
    <a class="btn cinza" href="/magalu/nf-full?k=${kq}">Atualizar lista</a>
  </div>
  <div class="aviso">Cookie do Bling:
    ${['good','amb'].map(e => (BLING_IMP[e].cookie()
        ? '<a href="/magalu/nf-full/cookie?empresa=' + e + '&k=' + kq + '" style="color:#81c995">' + (e === 'good' ? 'GOOD' : 'AMB') + ' ✓</a>'
        : '<a href="/magalu/nf-full/cookie?empresa=' + e + '&k=' + kq + '" style="color:#f28b82">' + (e === 'good' ? 'GOOD' : 'AMB') + ' — colar</a>')
        + (BLING_IMP[e].cookie() ? ' <a href="/magalu/nf-full/cookie-testar?empresa=' + e + '&k=' + kq + '" style="color:#9aa0a6;font-size:12px">(testar)</a>' : '')).join(' &nbsp;|&nbsp; ')}
  </div>
  <div class="aviso">Se der erro de limite, use <b>só AMB</b> ou <b>só GOOD</b> e espere uns minutos entre uma e outra — a Magalu conta o limite por IP, e as duas empresas dividem o mesmo.</div>
  <div class="aviso"><b>SAÍDA</b> = vendas e remessas (importar no Bling como notas de <b>saída</b>).<br>
  <b>ENTRADA</b> = retornos simbólicos do depósito (importar como notas de <b>entrada</b>, num lote separado).<br>
  A Magalu manda os dois tipos no mesmo arquivo — por isso a separação.<br><br>
  "Rodar agora" leva de 20 a 60 segundos e devolve um texto técnico — depois volta aqui e clica em Atualizar lista.</div>
</div>
<div class="card">
  <div class="tit">Período específico (opcional)</div>
  <div class="linha">
    <div><label>De</label><input type="date" id="de" value="${pde}"></div>
    <div><label>Até</label><input type="date" id="ate" value="${pad}"></div>
  </div>
  <div class="btns">
    <a class="btn" id="bAmb" href="#">Baixar AMBTotal</a>
    <a class="btn good" id="bGood" href="#">Baixar GOOD Import</a>
  </div>
  <div class="erro" id="erro"></div>
  <div class="aviso">O período não pode passar de <b>31 dias</b> (regra da Magalu).<br>
  Pode demorar de 5 a 40 segundos: a Magalu gera o arquivo na hora, e se ela responder
  "estou processando" o servidor espera e tenta de novo sozinho.</div>
</div>
<div class="card" style="font-size:13px;color:#9aa0a6">
  <b style="color:#e8eaed">No Bling, depois:</b><br>
  Configurações → Importações de Dados → Importar Notas Fiscais em Lote → notas de <b>saída</b>.<br>
  Marcar lançar contas. <b>Não</b> marcar lançar estoque (o estoque do Full está no CD da Magalu).
</div>
</div><script>
var K = new URLSearchParams(location.search).get('k') || '';
function mont(emp){
  var de = document.getElementById('de').value, ate = document.getElementById('ate').value;
  var e = document.getElementById('erro'); e.style.display='none';
  if(!de || !ate){ e.textContent='Preencha as duas datas.'; e.style.display='block'; return null; }
  if(de > ate){ e.textContent='A data inicial está depois da final.'; e.style.display='block'; return null; }
  var dias = (new Date(ate) - new Date(de)) / 864e5;
  if(dias > 31){ e.textContent='O período tem '+Math.round(dias)+' dias. O máximo é 31.'; e.style.display='block'; return null; }
  return '/magalu/nf-full/baixar?empresa='+emp+'&de='+de+'&ate='+ate+'&k='+encodeURIComponent(K);
}
function liga(id, emp){
  document.getElementById(id).addEventListener('click', function(ev){
    ev.preventDefault(); var u = mont(emp); if(u) location.href = u;
  });
}
liga('bAmb','amb'); liga('bGood','good');
</script></body></html>`);
      return true;
    }

    // ── DOWNLOAD ──
    const emp = String(q.get('empresa') || '').toLowerCase().trim();
    const de  = String(q.get('de') || '').trim();
    const ate = String(q.get('ate') || '').trim();
    if (!EMPRESAS_VALIDAS.includes(emp)) { json(res, 400, { ok: false, erro: 'empresa inválida: ' + emp }); return true; }
    if (!eData(de) || !eData(ate))       { json(res, 400, { ok: false, erro: 'datas devem ser AAAA-MM-DD' }); return true; }
    if (de > ate)                        { json(res, 400, { ok: false, erro: 'data inicial depois da final' }); return true; }
    const dias = (new Date(ate) - new Date(de)) / 864e5;
    if (dias > 31)                       { json(res, 400, { ok: false, erro: 'período de ' + Math.round(dias) + ' dias; a Magalu aceita no máximo 31' }); return true; }

    let buf;
    try { buf = await nfBaixarZip(emp, de, ate); }
    catch (e) { json(res, 502, { ok: false, empresa: emp, periodo: { de, ate }, erro: String(e.message || e) }); return true; }

    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="NFs-' + emp + '-' + de + '_a_' + ate + '.zip"',
      'Content-Length': buf.length
    });
    res.end(buf);
    return true;
  }

  // ── SONDA NF-e FULFILLMENT (26/07) ──────────────────────────────────
  // /magalu/sonda?empresa=amb&nf=1[&de=2026-07-19&ate=2026-07-26][&delivery=UUID]
  //
  // POR QUE PENDURADA NO /magalu/sonda: esse path JÁ está na lista de rotas
  // admin do index.js da RAIZ. Criar /magalu/nf-full exigiria editar o
  // orquestrador da raiz — o arquivo que derrubou o serviço em 23/07. Não vale
  // o risco por uma sondagem.
  //
  // O QUE FAZ: chama GET /seller/v1/invoices/fulfillment PELADO (o 422 do
  // Magalu costuma listar os parâmetros obrigatórios pelo nome) e depois testa
  // uma matriz de nomes de parâmetro de período, porque a doc não renderiza os
  // parâmetros no HTML. Mostra status, content-type, tamanho e um pedaço do
  // corpo de cada tentativa. NÃO grava nada, NÃO importa nada.
  if (method === 'GET' && p === '/magalu/sonda' && q.get('nf')) {
    const emp = String(q.get('empresa') || '').toLowerCase().trim();
    if (!EMPRESAS_VALIDAS.includes(emp)) { json(res, 400, { ok: false, erro: 'empresa inválida' }); return true; }

    const fmt = d => d.toISOString().slice(0, 10);
    const hoje = new Date();
    const ate = String(q.get('ate') || fmt(hoje)).trim();
    const de  = String(q.get('de')  || fmt(new Date(hoje.getTime() - 7 * 864e5))).trim();

    let tok = '';
    try { tok = await getAccessToken(emp); }
    catch (e) { json(res, 502, { ok: false, erro: 'token: ' + String(e.message || e) }); return true; }
    const H = { 'Authorization': 'Bearer ' + tok, 'Accept': 'application/json' };

    // Lê a resposta SEM assumir que é JSON: se vier ZIP (o portal devolve um
    // .zip de 526 KB) ou XML puro, mede e identifica em vez de despejar lixo.
    async function inspecionar(url) {
      const t0 = Date.now();
      let r;
      try { r = await fetch(url, { headers: H, redirect: 'manual' }); }
      catch (e) { return { url: url.replace('https://api.magalu.com', ''), erro: String(e.message || e).slice(0, 160) }; }

      const ct  = r.headers.get('content-type') || '';
      const loc = r.headers.get('location') || null;
      let buf;
      try { buf = Buffer.from(await r.arrayBuffer()); } catch (e) { buf = Buffer.alloc(0); }

      const out = {
        url: url.replace('https://api.magalu.com', ''),
        status: r.status, content_type: ct.slice(0, 60), bytes: buf.length, ms: Date.now() - t0
      };
      if (loc) out.REDIRECT_PARA = loc.slice(0, 300);
      try {
        const hs = {};
        r.headers.forEach((v, k) => { if (!/^(date|server|connection|content-length)$/i.test(k)) hs[k] = String(v).slice(0, 120); });
        out.headers = hs;
      } catch (e) {}

      // assinatura de ZIP = PK\x03\x04
      if (buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4B) { out.VEIO_ZIP = true; return out; }

      const txt = buf.toString('utf8');
      if (/^\s*<\?xml|<nfeProc|<NFe/i.test(txt)) { out.VEIO_XML = true; out.trecho = txt.slice(0, 300); return out; }

      let j = null; try { j = JSON.parse(txt); } catch (e) {}
      if (!j) { out.corpo = txt.slice(0, 500); return out; }

      out.json_chaves = Object.keys(j).slice(0, 20);
      // caça qualquer campo que pareça link de download (o portal devolve URL
      // assinada do storage.googleapis.com)
      const links = [];
      (function caca(o, base) {
        if (!o || typeof o !== 'object' || links.length > 8) return;
        for (const k of Object.keys(o)) {
          const v = o[k];
          const cam = base ? base + '.' + k : k;
          if (typeof v === 'string' && /^https?:\/\//i.test(v)) links.push(cam + ' = ' + v.slice(0, 200));
          else if (v && typeof v === 'object') caca(v, cam);
        }
      })(j, '');
      if (links.length) out.LINKS_ENCONTRADOS = links;
      out.corpo = JSON.stringify(j).slice(0, 700);
      return out;
    }

    const BASE = 'https://api.magalu.com/seller/v1/invoices/fulfillment';
    const tentativas = [];

    // 1) pelado — é aqui que o 422 entrega o nome dos parâmetros
    tentativas.push(await inspecionar(BASE));

    // 2) FASE 2 (26/07): o 422 confirmou que os parametros sao start_date e
    //    end_date. Com eles a API passou da validacao e devolveu 503 — entao o
    //    que falta descobrir e o FORMATO da data (e se o 503 e transitorio).
    const dorme = ms => new Promise(r => setTimeout(r, ms));
    const qs = (a, b, extra) => BASE + '?start_date=' + encodeURIComponent(a) + '&end_date=' + encodeURIComponent(b) + (extra || '');

    // 2a) o formato que deu 503, repetido 3x — separa 503 transitorio de 503 sempre
    for (let i = 0; i < 3; i++) {
      const t = await inspecionar(qs(de, ate));
      t.nota = 'data simples, tentativa ' + (i + 1) + '/3';
      tentativas.push(t);
      if (i < 2) await dorme(1500);
    }

    // 2b) variacoes de formato de data/hora
    const formatos = [
      [de + 'T00:00:00Z',       ate + 'T23:59:59Z',       'ISO com Z'],
      [de + 'T00:00:00',        ate + 'T23:59:59',        'ISO sem timezone'],
      [de + 'T00:00:00-03:00',  ate + 'T23:59:59-03:00',  'ISO com offset BR'],
      [de + ' 00:00:00',        ate + ' 23:59:59',        'data e hora com espaco'],
      [de + 'T00:00:00.000Z',   ate + 'T23:59:59.999Z',   'ISO com milissegundos']
    ];
    for (const f of formatos) {
      const t = await inspecionar(qs(f[0], f[1]));
      t.nota = f[2];
      tentativas.push(t);
    }

    // 2c) janelas menores — talvez o 503 seja volume de dados
    const t1 = await inspecionar(qs(ate, ate));            t1.nota = 'janela de 1 dia (so a data final)';   tentativas.push(t1);
    // 2d) paginacao no padrao Magalu (_limit / _offset)
    const t2 = await inspecionar(qs(de, ate, '&_limit=5&_offset=0')); t2.nota = 'com _limit=5 e _offset=0';  tentativas.push(t2);

    // 3) se passar &delivery=UUID, testa também a NF por entrega
    const dlv = String(q.get('delivery') || '').trim();
    if (dlv) {
      const t3 = await inspecionar(BASE + '?delivery_id=' + encodeURIComponent(dlv));
      t3.nota = 'delivery_id na rota de fulfillment (a alternativa que o 422 ofereceu)';
      tentativas.push(t3);
      const t4 = await inspecionar('https://api.magalu.com/seller/v1/deliveries/' + encodeURIComponent(dlv) + '/invoices');
      t4.nota = 'rota de NF por entrega';
      tentativas.push(t4);
    }

    json(res, 200, {
      ok: true, empresa: emp, versao: VERSAO,
      periodo_testado: { de, ate },
      leia: 'FASE 2: start_date e end_date ja estao confirmados. Agora procure qualquer linha com status DIFERENTE de 503 e de 422 — e veja o campo nota de cada tentativa pra saber qual formato de data foi usado.',
      tentativas
    });
    return true;
  }

  // /magalu/sonda?empresa=girassol[&code=NUMERO_LU]  → exploração (admin).
  // Achamos o endpoint: GET api.magalu.com/seller/v1/orders (200). O pedido traz
  // id (uuid do pedido), code (número LU visível) e deliveries[] (onde deve estar
  // o uuid do pacote que falta na URL /pedidos/<code>/<uuid>). Esta sonda pega 1
  // pedido (ou busca por code) e mostra TODOS os uuids candidatos, expandidos.
  // 10/08: PEDIDOS DO DIA — "marketplace primeiro, Bling é conferência". Lista as
  // vendas recentes direto da API da Magalu (purchased_at_from, filtro descoberto na
  // sonda da linha ~1012) pro vendasSync mostrar a venda NA HORA, antes do XML do
  // Full descer pro Bling. Campos do total são DEFENSIVOS (a estrutura exata do
  // pedido não foi 100% mapeada): &raw=1 devolve a 1ª order crua pra calibrarmos.
  // Uso: GET /magalu/pedidos-do-dia?empresa=amb&k=ADMIN_KEY[&desde=AAAA-MM-DD][&raw=1]
  // ── SONDA DO DETALHE DO PEDIDO (13/08) ────────────────────────────────────────────
  // Motivo: a LISTAGEM /seller/v1/orders devolve os itens SEM sku (medido: skus [null] em
  // todos os pedidos de 31/07 da AMB), e por isso as vendas Magalu entraram no histórico do
  // dashboard sem SKU — 116 unidades e R$ 16.390 em julho fora do ranking de produtos.
  // Regra do Diego neste projeto: não chutar endpoint — sondar e ver o retorno real primeiro.
  // Esta rota chama GET /seller/v1/orders/{id} e devolve o DETALHE com os dados pessoais do
  // comprador REMOVIDOS (fica só o que interessa: itens, sku, quantidade, valores).
  // Uso: GET /magalu/pedido-sonda?empresa=amb&id={uuid ou code}&k=ADMIN_KEY[&cru=1]
  if (method === 'GET' && p === '/magalu/pedido-sonda') {
    const empS = String(q.get('empresa') || '').toLowerCase().trim();
    if (!EMPRESAS_VALIDAS.includes(empS)) { json(res, 400, { ok: false, erro: 'empresa inválida' }); return true; }
    const kS = String(q.get('k') || '').trim();
    if (!process.env.ADMIN_KEY || kS !== process.env.ADMIN_KEY) { json(res, 404, { error: 'not found' }); return true; }
    const idS = String(q.get('id') || '').trim();
    if (!idS) { json(res, 400, { ok: false, erro: 'use ?id={uuid ou code do pedido}' }); return true; }
    let tokS = '';
    try { tokS = await getAccessToken(empS); }
    catch (e) { json(res, 502, { ok: false, erro: 'token: ' + String(e.message || e) }); return true; }
    const outS = { ok: true, empresa: empS, id: idS, tentativas: [] };
    // 2 caminhos possíveis pro detalhe — a sonda tenta os dois e mostra qual respondeu
    const alvos = [
      'https://api.magalu.com/seller/v1/orders/' + encodeURIComponent(idS),
      'https://api.magalu.com/seller/v1/orders/' + encodeURIComponent(idS) + '/items'
    ];
    for (const u of alvos) {
      try {
        const r = await fetch(u, { headers: { Authorization: 'Bearer ' + tokS, Accept: 'application/json' } });
        const tx = await r.text();
        let j = null; try { j = JSON.parse(tx); } catch (e) {}
        const linha = { url: u.replace('https://api.magalu.com', ''), status: r.status, tem_json: Boolean(j) };
        if (j) {
          // limpa dados pessoais antes de devolver (nunca expor comprador numa sonda)
          const limpo = JSON.parse(JSON.stringify(j));
          for (const campo of ['customer', 'delivery', 'shipping', 'billing', 'buyer', 'addresses', 'address']) { if (limpo[campo]) limpo[campo] = '(omitido)'; }
          const arr = limpo.items || limpo.products || limpo.order_items || (Array.isArray(limpo) ? limpo : null);
          linha.chaves_do_topo = Object.keys(limpo).slice(0, 25);
          linha.itens_qtd = Array.isArray(arr) ? arr.length : 0;
          linha.itens = Array.isArray(arr) ? arr.slice(0, 3) : null;   // item CRU: mostra onde o SKU realmente está
          if (q.get('cru') === '1') linha.cru = limpo;
        } else { linha.corpo = tx.slice(0, 300); }
        outS.tentativas.push(linha);
        if (r.ok && j) break;
        await new Promise(r2 => setTimeout(r2, 400));
      } catch (e) { outS.tentativas.push({ url: u.replace('https://api.magalu.com', ''), erro: String(e.message || e).slice(0, 160) }); }
    }
    json(res, 200, outS);
    return true;
  }

  if (method === 'GET' && p === '/magalu/pedidos-do-dia') {
    const emp = String(q.get('empresa') || '').toLowerCase().trim();
    if (!EMPRESAS_VALIDAS.includes(emp)) { json(res, 400, { ok: false, erro: 'empresa inválida' }); return true; }
    const kD = String(q.get('k') || '').trim();
    if (!process.env.ADMIN_KEY || kD !== process.env.ADMIN_KEY) { json(res, 404, { error: 'not found' }); return true; }
    let tok = '';
    try { tok = await getAccessToken(emp); }
    catch (e) { json(res, 502, { ok: false, erro: 'token: ' + String(e.message || e) }); return true; }
    const H = { 'Authorization': 'Bearer ' + tok, 'Accept': 'application/json' };
    const BASE = 'https://api.magalu.com/seller/v1/orders';
    const hj = new Date(); hj.setDate(hj.getDate() - 1);
    const desde = String(q.get('desde') || hj.toISOString().slice(0, 10)).slice(0, 10);
    const ate = /^\d{4}-\d{2}-\d{2}$/.test(String(q.get('ate') || '')) ? String(q.get('ate')) : '';   // 11/08: janela fechada (mês inteiro)
    const paginas = Math.min(60, Math.max(6, parseInt(q.get('paginas') || '6', 10) || 6));              // 50 por página
    const querRaw = q.get('raw') === '1';
    const out = { ok: true, empresa: emp, desde, ate: ate || null, pedidos: [] };
    let foraJanela = 0, semData = 0, lidos = 0;
    try {
      let cru1 = null;
      for (let off = 0; off < paginas * 50; off += 50) {
        const r = await fetch(BASE + '?_limit=50&_offset=' + off + '&purchased_at_from=' + encodeURIComponent(desde + 'T00:00:00Z'), { headers: H });
        const tx = await r.text();
        let j = null; try { j = JSON.parse(tx); } catch (e) {}
        const arr = (j && (j.results || j.orders || (Array.isArray(j) ? j : []))) || [];
        // (Codex PR#25) falha da Magalu NÃO pode virar "período vazio" com ok:true — quem
        // consome trataria como completo e o mês ficaria faltando pedidos pra sempre, calado.
        if (!r.ok) {
          out.http = { status: r.status, corpo: tx.slice(0, 200) };
          if (off === 0) { out.ok = false; out.erro = 'Magalu recusou a listagem: HTTP ' + r.status + ' ' + tx.slice(0, 100); }
          else { out.parcial = true; out.erro_lista = 'HTTP ' + r.status + ' na página ' + (off / 50 + 1); }
          break;
        }
        if (!arr.length) break;
        for (const o of arr) {
          if (!o) continue;
          if (!cru1) cru1 = o;
          const code = String(o.code || o.order_code || '').trim();
          if (!code) continue;
          // 11/08: a Magalu IGNORA o purchased_at_from (provado: 300 pedidos vieram com
          // datas velhas). Então filtramos AQUI, pela data que o pedido traz. Sem isto o
          // consumidor recebe o histórico inteiro achando que é "o dia".
          const dtP = String(o.purchased_at || o.created_at || '').slice(0, 10);
          if (dtP) { if (dtP < desde || (ate && dtP > ate)) { foraJanela++; continue; } } else { semData++; }
          // total DEFENSIVO — candidatos em ordem de plausibilidade; 0 = não achamos (calibrar com &raw=1)
          // 11/08 ⚠️ A MAGALU MANDA VALOR EM CENTAVOS nos campos `amounts.*`. Sem dividir,
          // o pedido de R$ 145,70 entrava como R$ 14.570 — julho foi pra R$ 1,87 MILHÃO no
          // dashboard. Regra: o que vem de `amounts` é centavo (÷100); `total_amount`/`total`
          // vêm em reais. `cru` fica na resposta pra conferência.
          let tot = 0, totFonte = null;
          if (o.amounts && o.amounts.total != null) { tot = Number(o.amounts.total) / 100; totFonte = 'amounts.total (centavos)'; }
          else if (o.amount && o.amount.total != null) { tot = Number(o.amount.total) / 100; totFonte = 'amount.total (centavos)'; }
          else if (o.total_amount != null) { tot = Number(o.total_amount); totFonte = 'total_amount'; }
          else if (o.total != null) { tot = Number(o.total); totFonte = 'total'; }
          tot = Number(tot) || 0;
          // 11/08: ITENS (SKU/qtd/valor) — sem eles a caça grava faturamento sem custo,
          // e a margem do pedido sai inflada. Leitura DEFENSIVA: a Magalu põe os itens ora
          // em `items`, ora dentro de cada `deliveries[]`, com nomes variados de campo.
          let itens = [];
          try {
            // (Codex PR#25) UMA representação só: a Magalu às vezes repete os mesmos itens em
            // `items` E dentro de cada `deliveries[]`. Concatenar duplicava quantidade, custo e
            // margem do pedido. Prioridade: items do pedido; só se vazio, os das entregas.
            let fontes = Array.isArray(o.items) && o.items.length ? o.items : [];
            if (!fontes.length) fontes = [].concat(...((o.deliveries || []).map(dl => dl.items || [])));
            itens = fontes.map(i3 => {
              const qtd = Number(i3.quantity != null ? i3.quantity : (i3.qty != null ? i3.qty : 1)) || 1;
              // (Codex PR#25) `amounts.total` é o total DA LINHA, não o unitário — quem consome
              // multiplica por qtd de novo. Convertido aqui, senão o faturamento sai qtd× maior.
              // mesmo cuidado com centavos nos ITENS (e `amounts.total` continua sendo o
              // total DA LINHA — vira unitário dividindo pela quantidade)
              let valor = null;
              if (i3.amounts && i3.amounts.unit != null) valor = Number(i3.amounts.unit) / 100;
              else if (i3.amounts && i3.amounts.total != null) valor = Number(i3.amounts.total) / 100 / (qtd || 1);
              // 13/08 (sonda do pedido real): unit_price é OBJETO { value, normalizer } em
              // centavos — Number(objeto) dava NaN e o valor caía nos campos seguintes.
              else if (i3.unit_price && i3.unit_price.value != null) valor = Number(i3.unit_price.value) / (Number(i3.unit_price.normalizer) || 100);
              else if (i3.unit_price != null) valor = Number(i3.unit_price);
              else if (i3.price != null) valor = Number(i3.price);
              else if (i3.total != null) valor = Number(i3.total) / (qtd || 1);
              return {
                // 13/08 — MEDIDO na sonda do pedido real: o item da Magalu traz SKU e nome dentro
                // de `info` (deliveries[].items[].info.sku = "FL-1011-PRETO"). Sem ler `info`, TODA
                // venda Magalu entrava no histórico com sku null — 116 unidades e R$ 16.390 fora
                // do ranking de produtos em julho/2026.
                sku: String((i3.sku || i3.seller_sku || i3.code || (i3.info && (i3.info.sku || i3.info.code)) || (i3.product && (i3.product.sku || i3.product.code)) || '')).trim() || null,
                desc: String((i3.name || i3.title || (i3.info && (i3.info.name || i3.info.description)) || (i3.product && i3.product.name) || '')).slice(0, 120) || null,
                qtd,
                valor: Number(valor) || 0
              };
            }).filter(x => x.sku || x.valor);
          } catch (e) {}
          out.pedidos.push({
            code,
            id: o.id || null,
            purchased_at: o.purchased_at || o.created_at || null,
            status: (o.status && (o.status.name || o.status)) || null,
            total: tot,
            total_fonte: totFonte,
            cliente: (o.customer && (o.customer.name || o.customer.nickname)) || '',
            itens
          });
        }
        lidos += arr.length;
        if (arr.length < 50) break;
        if (off + 50 >= paginas * 50) { out.truncado = true; break; }   // não fingir janela completa
        await new Promise(r2 => setTimeout(r2, 350));
      }
      if (querRaw && cru1) out.amostra_crua = cru1;
      out.total_listado = out.pedidos.length;
      out.lidos_da_api = lidos; out.fora_da_janela = foraJanela; out.sem_data = semData;
      // se a API devolveu MUITO e quase tudo era velho, o filtro dela não funciona
      out.filtro_do_servidor_funciona = !(lidos >= 50 && foraJanela > out.pedidos.length);
    } catch (e) { out.ok = false; out.erro = String(e.message || e).slice(0, 180); }
    json(res, 200, out);
    return true;
  }

  if (method === 'GET' && p === '/magalu/sonda') {
    const emp = String(q.get('empresa') || '').toLowerCase().trim();
    if (!EMPRESAS_VALIDAS.includes(emp)) { json(res, 400, { ok: false, erro: 'empresa inválida' }); return true; }
    const code = String(q.get('code') || '').trim();

    let tok = '';
    try { tok = await getAccessToken(emp); }
    catch (e) { json(res, 502, { ok: false, erro: 'token: ' + String(e.message || e) }); return true; }
    const H = { 'Authorization': 'Bearer ' + tok, 'Accept': 'application/json' };
    const BASE = 'https://api.magalu.com/seller/v1/orders';

    async function pega(url) {
      const r = await fetch(url, { headers: H });
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch (e) {}
      return { status: r.status, j, t };
    }

    // extrai todos os pares (caminho → uuid) de um objeto, pra achar qual uuid é o do pacote
    function uuids(o, base, acc) {
      acc = acc || {};
      base = base || '';
      const RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (o && typeof o === 'object') {
        for (const k of Object.keys(o)) {
          const v = o[k];
          const cam = base ? base + '.' + k : k;
          if (typeof v === 'string' && RE.test(v)) acc[cam] = v;
          else if (v && typeof v === 'object') uuids(v, cam, acc);
        }
      }
      return acc;
    }

    try {
      let url = BASE + '?_limit=' + (code ? '10' : '1') + (code ? ('&code=' + encodeURIComponent(code)) : '');
      let out = await pega(url);
      // se busca por code não achou nada, tenta sem filtro e casa pelo campo code no cliente
      let lista = out.j && (out.j.results || out.j.data || (Array.isArray(out.j) ? out.j : []));
      if (code && (!lista || !lista.length)) {
        const alt = await pega(BASE + '?_limit=50');
        const arr = alt.j && (alt.j.results || alt.j.data || []);
        lista = (arr || []).filter(x => String(x.code || '') === code);
        out = { status: alt.status, via: 'filtro-cliente' };
      }

      const pedido = (lista && lista[0]) || null;
      if (!pedido) {
        json(res, 200, { ok: true, empresa: emp, versao: VERSAO, status: out.status,
          nota: code ? 'não achei pedido com esse code' : 'lista vazia',
          amostra_bruta: out.j ? JSON.stringify(out.j).slice(0, 400) : (out.t || '').slice(0, 400) });
        return true;
      }

      json(res, 200, {
        ok: true, empresa: emp, versao: VERSAO,
        pedido_code: pedido.code || null,
        pedido_id: pedido.id || null,
        status_pedido: pedido.status || null,
        deliveries_qtd: Array.isArray(pedido.deliveries) ? pedido.deliveries.length : 0,
        TODOS_OS_UUIDS: uuids(pedido),
        estrutura_deliveries: Array.isArray(pedido.deliveries)
          ? pedido.deliveries.map(d => ({ chaves: Object.keys(d), id: d.id || null,
              code: d.code || null, packages: d.packages ? 'sim' : 'não' }))
          : null
      });
    } catch (e) {
      json(res, 500, { ok: false, erro: String(e.message || e) });
    }
    return true;
  }

  // /magalu/valores?empresa=girassol[&code=NUMERO][&status=canceled]  → (admin)
  // Raio-X de VALORES pra montar a margem real: despeja amounts INTEIRO (comissão,
  // frete, taxa, desconto), a lista de invoices, e caça QUALQUER campo com "return"
  // /"devol"/"refund"/"reverse" no pedido (frete de retorno é o que o Diego mais quer).
  // Sem &code pega o pedido mais recente; &status filtra (ex.: canceled/returned)
  // pra tentar achar um pedido COM devolução e ver como ela aparece.
  if (method === 'GET' && p === '/magalu/valores') {
    const emp = String(q.get('empresa') || '').toLowerCase().trim();
    if (!EMPRESAS_VALIDAS.includes(emp)) { json(res, 400, { ok: false, erro: 'empresa inválida' }); return true; }
    const code = String(q.get('code') || '').trim();
    const status = String(q.get('status') || '').trim();

    let tok = '';
    try { tok = await getAccessToken(emp); }
    catch (e) { json(res, 502, { ok: false, erro: 'token: ' + String(e.message || e) }); return true; }
    const H = { 'Authorization': 'Bearer ' + tok, 'Accept': 'application/json' };
    const BASE = 'https://api.magalu.com/seller/v1/orders';

    async function pega(url) {
      const r = await fetch(url, { headers: H });
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch (e) {}
      return { status: r.status, j, t };
    }

    // acha TODOS os caminhos cujo nome sugere devolução/estorno/frete-de-volta
    function achaDevolucao(o, base, acc) {
      acc = acc || {}; base = base || '';
      const RE = /return|devol|refund|reverse|estorn|logistic.*reverse|reverse.*logistic/i;
      if (o && typeof o === 'object') {
        for (const k of Object.keys(o)) {
          const cam = base ? base + '.' + k : k;
          if (RE.test(k)) acc[cam] = (o[k] && typeof o[k] === 'object') ? '(objeto: ' + Object.keys(o[k]).join(',') + ')' : o[k];
          if (o[k] && typeof o[k] === 'object') achaDevolucao(o[k], cam, acc);
        }
      }
      return acc;
    }

    try {
      // 1) achar o pedido certo. Se for por code, a API às vezes ignora o &code=
      //    (pedido antigo fora da janela default), então paginamos fundo procurando.
      let pedido = null;
      let paginasVarridas = 0;
      // &status= opcional pra mirar a categoria certa (ex.: cancelled — a API pagina
      // "normais" por padrão e um cancelado pode não vir; então filtramos por status).
      const desde = String(q.get('desde') || '').trim();
      const statusFiltro = String(q.get('status') || '').trim();
      const filtroData = desde ? ('&purchased_at_from=' + encodeURIComponent(desde + 'T00:00:00Z')) : '';
      const filtroStatus = statusFiltro ? ('&status=' + encodeURIComponent(statusFiltro)) : '';
      if (code) {
        // varre em VÁRIOS status conhecidos, porque a listagem default pode omitir cancelados
        const statusParaVarrer = statusFiltro ? [statusFiltro] : ['', 'cancelled', 'canceled', 'delivered', 'finished'];
        for (const st of statusParaVarrer) {
          if (pedido) break;
          const fs = st ? ('&status=' + encodeURIComponent(st)) : '';
          let offset = 0;
          while (offset < 600 && !pedido) {  // 600 por status (12 páginas)
            const r = await pega(BASE + '?_limit=50&_offset=' + offset + filtroData + fs);
            const arr = r.j && (r.j.results || r.j.data || (Array.isArray(r.j) ? r.j : [])) || [];
            if (!arr.length) break;
            pedido = arr.find(x => String(x.code || '') === code) || null;
            paginasVarridas++;
            offset += 50;
          }
        }
        if (!pedido) {
          json(res, 200, { ok: false, empresa: emp, versao: VERSAO,
            nota: 'não achei o code=' + code + ' varrendo ' + paginasVarridas + ' páginas em vários status. A API pode paginar diferente do portal. Tente &status=cancelled explícito, ou me diga a POSIÇÃO do pedido na lista do portal.' });
          return true;
        }
      } else {
        // sem code: usa status (se veio) ou o mais recente
        let url = BASE + '?_limit=' + (status ? '20' : '1');
        if (status) url += '&status=' + encodeURIComponent(status);
        const out = await pega(url);
        const lista = out.j && (out.j.results || out.j.data || (Array.isArray(out.j) ? out.j : [])) || [];
        pedido = lista[0] || null;
        if (!pedido) {
          json(res, 200, { ok: true, empresa: emp, versao: VERSAO, status_http: out.status,
            nota: 'nenhum pedido' + (status ? ' com status=' + status : ''),
            bruto: out.j ? JSON.stringify(out.j).slice(0, 500) : (out.t || '').slice(0, 500) });
          return true;
        }
      }

      const d0 = Array.isArray(pedido.deliveries) && pedido.deliveries[0] ? pedido.deliveries[0] : {};

      // se pediram para cavar mais fundo (&fundo=1), busca eventos/shipping/logística/RETURNS
      let extra = null;
      if (q.get('fundo') === '1') {
        extra = { pedido_id: pedido.id, delivery_id: d0.id };
        // eventos da delivery (histórico de status — cancelamento/devolução costuma vir aqui)
        extra.eventos = d0.events || null;
        // shipping da delivery (frete, transportadora, custo)
        extra.shipping = d0.shipping || null;
        // os external_id das devoluções deste pedido (o custo do frete reverso mora atrás deles)
        const rets = (d0.returns || pedido.returns || []);
        extra.returns_ids = rets.map(r => r.external_id || r.id).filter(Boolean);
        const oid = pedido.id, did = d0.id;
        const retId = extra.returns_ids[0] || null;
        // candidatos de endpoint — inclui os de RETURNS pelo external_id (onde deve estar o frete reverso)
        const tentativas = [
          'https://api.magalu.com/seller/v1/orders/' + oid,
          'https://api.magalu.com/seller/v1/orders/' + oid + '/deliveries/' + did,
          'https://api.magalu.com/seller/v1/orders/' + oid + '/returns',
          'https://api.magalu.com/seller/v1/orders/' + oid + '/deliveries/' + did + '/returns'
        ];
        if (retId) {
          tentativas.push('https://api.magalu.com/seller/v1/returns/' + retId);
          tentativas.push('https://api.magalu.com/seller/v1/orders/' + oid + '/returns/' + retId);
          tentativas.push('https://api.magalu.com/seller/v1/reverse-logistics/' + retId);
          tentativas.push('https://api.magalu.com/seller/v1/returns?_limit=5&order_id=' + oid);
        }
        extra.endpoints = {};
        for (const u of tentativas) {
          try {
            const rr = await pega(u);
            extra.endpoints[u.replace('https://api.magalu.com', '')] = {
              status: rr.status,
              // se respondeu 200, mostra a estrutura INTEIRA (é aqui que pode estar o frete reverso)
              corpo: rr.status === 200 ? rr.j : (rr.j ? JSON.stringify(rr.j).slice(0, 150) : undefined)
            };
          } catch (e) { extra.endpoints[u.replace('https://api.magalu.com', '')] = { erro: String(e.message).slice(0, 100) }; }
        }
      }

      json(res, 200, {
        ok: true, empresa: emp, versao: VERSAO,
        pedido_code: pedido.code || null,
        status_pedido: pedido.status || null,
        // AMOUNTS inteiro do pedido (comissão, frete, taxa, desconto) — sem podar
        amounts_pedido: pedido.amounts || null,
        // a delivery também tem amounts próprios (por pacote)
        amounts_delivery0: d0.amounts || null,
        delivery0_chaves: Object.keys(d0),
        delivery0_status: d0.status || null,
        // invoices (nota) — pode ter valor/imposto oficial
        invoices: (d0.invoices || pedido.invoices || null),
        // returns/devolução se existir no corpo
        returns_delivery0: d0.returns || null,
        // varredura por qualquer campo de devolução/estorno/retorno no pedido inteiro
        CAMPOS_DEVOLUCAO: achaDevolucao(pedido),
        // chaves de topo do pedido, pra ver o que mais existe
        chaves_topo: Object.keys(pedido),
        // cavação profunda (só com &fundo=1)
        EXTRA: extra
      });
    } catch (e) {
      json(res, 500, { ok: false, erro: String(e.message || e) });
    }
    return true;
  }

  // /magalu/financeiro?empresa=good[&code=NUMERO][&external_id=UUID]  → (admin)
  // Consulta a API de ANÁLISE FINANCEIRA (DRE) — a fonte oficial dos valores reais:
  // comissão, tarifa, MDR, frete real, e principalmente DEVOLUÇÃO (REFUND) + frete de
  // retorno. Só retorna pedidos Entregue/Cancelado a partir de 05/05/2026. Precisa do
  // escopo open:order-financial-report-seller:read (já autorizado nas 3 empresas).
  // Descobre o endpoint certo testando candidatos e mostra as transações cruas.
  if (method === 'GET' && p === '/magalu/financeiro') {
    const emp = String(q.get('empresa') || '').toLowerCase().trim();
    if (!EMPRESAS_VALIDAS.includes(emp)) { json(res, 400, { ok: false, erro: 'empresa inválida' }); return true; }
    const code = String(q.get('code') || '').trim();
    const extId = String(q.get('external_id') || '').trim();
    const desde = String(q.get('desde') || '2026-05-05').trim();

    let tok = '';
    try { tok = await getAccessToken(emp); }
    catch (e) { json(res, 502, { ok: false, erro: 'token: ' + String(e.message || e) }); return true; }
    const H = { 'Authorization': 'Bearer ' + tok, 'Accept': 'application/json' };

    async function pega(url) {
      const r = await fetch(url, { headers: H });
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch (e) {}
      return { status: r.status, j, t };
    }

    // candidatos de base da API financeira (o path exato não está 100% claro na doc)
    const BASE_FIN = 'https://api.magalu.com/seller/v1/financial-analysis/orders';
    // A API exige order_id OU par de datas purchased_at__gte/__lte, e a janela
    // não pode passar de 15 DIAS. Então varremos em janelas de 15 dias, do 'ate'
    // pra trás até o 'desde', procurando o pedido pelo order_code.
    const ateFull = String(q.get('ate') || '').trim() || new Date().toISOString().slice(0, 10);
    const desdeFull = desde;  // default 2026-05-05
    const MS_DIA = 86400000;
    const d0 = new Date(desdeFull + 'T00:00:00Z').getTime();
    const dN = new Date(ateFull + 'T23:59:59Z').getTime();

    let alvo = null, comoAchou = '', amostra = null;
    let janelasVarridas = 0, paginasTotal = 0;
    // do fim pro começo, blocos de 15 dias
    let fimBloco = dN;
    while (fimBloco > d0 && !alvo && janelasVarridas < 12) {  // até 12 janelas (180 dias)
      const iniBloco = Math.max(d0, fimBloco - 15 * MS_DIA);
      const gte = new Date(iniBloco).toISOString();
      const lte = new Date(fimBloco).toISOString();
      const JANELA = 'purchased_at__gte=' + encodeURIComponent(gte) + '&purchased_at__lte=' + encodeURIComponent(lte);
      janelasVarridas++;

      let offset = 0;
      while (offset < 500 && !alvo) {
        const r = await pega(BASE_FIN + '?' + JANELA + '&_limit=50&_offset=' + offset);
        if (r.status !== 200) {
          json(res, 200, { ok: false, empresa: emp, versao: VERSAO,
            nota: 'a janela de datas retornou ' + r.status + ' — veja o corpo',
            janela: JANELA, corpo: r.j || (r.t || '').slice(0, 400) });
          return true;
        }
        const arr = r.j && (r.j.results || r.j.data || (Array.isArray(r.j) ? r.j : [])) || [];
        if (!amostra && arr.length) amostra = arr[0];
        paginasTotal++;
        if (!arr.length) break;
        if (code) {
          alvo = arr.find(o => {
            const oc = (o.extras && o.extras.order_code) || o.order_code || o.external_id || '';
            return String(oc) === code;
          }) || null;
          if (alvo) comoAchou = 'janela ' + gte.slice(0, 10) + '→' + lte.slice(0, 10);
        } else {
          alvo = arr[0]; comoAchou = 'primeiro da janela mais recente';
        }
        offset += 50;
      }
      fimBloco = iniBloco - 1000;  // próximo bloco, 15 dias antes
    }

    if (!alvo) {
      json(res, 200, { ok: true, empresa: emp, versao: VERSAO, endpoint: '/seller/v1/financial-analysis/orders',
        nota: 'API financeira OK (200), mas não achei o pedido' + (code ? ' code=' + code : '') + ' em ' + janelasVarridas + ' janelas de 15 dias (' + desdeFull + ' a ' + ateFull + ')',
        paginas: paginasTotal,
        estrutura_de_um_pedido: amostra ? Object.keys(amostra) : 'janelas vazias',
        amostra_extras: amostra && amostra.extras ? amostra.extras : null });
      return true;
    }

    // resume as transações destacando REFUND (devolução) e SHIPPING_COST (frete)
    const txs = alvo.transactions || [];
    const resumo = txs.map(t => ({
      categoria: t.category, sub: t.subcategory, tipo: t.type,
      valor: (t.value != null && t.normalizer) ? (t.value / t.normalizer) : t.value,
      desc: t.description
    }));
    const devolucao = resumo.filter(r => r.categoria === 'REFUND' || /refund|penalt/i.test(String(r.sub || '')));
    const frete = resumo.filter(r => r.categoria === 'SHIPPING_COST');
    const saldo = txs.reduce((acc, t) => {
      if (t.type === 'CREDIT') return acc + (t.value / (t.normalizer || 100));
      if (t.type === 'DEBIT') return acc - (t.value / (t.normalizer || 100));
      return acc;
    }, 0);

    json(res, 200, {
      ok: true, empresa: emp, versao: VERSAO,
      base: BASE_FIN.replace('https://api.magalu.com', ''), como_achou: comoAchou,
      order_code: (alvo.extras && alvo.extras.order_code) || alvo.order_code || null,
      external_id: alvo.external_id || null,
      DEVOLUCAO: devolucao.length ? devolucao : 'nenhuma transação REFUND neste pedido',
      FRETE: frete.length ? frete : 'nenhuma transação SHIPPING_COST',
      saldo_liquido: Math.round(saldo * 100) / 100,
      TODAS_TRANSACOES: resumo
    });
    return true;
  }

  // SONDA de reputação REMOVIDA por segurança após cumprir o diagnóstico: testou 10
  // endpoints candidatos e TODOS deram 404 — não há endpoint público de nível/coparticipação
  // na API Magalu. O nível fica manual no ⚙️ do dashboard.

  // /magalu/financeiro-lote?empresa=good&codes=A,B,C[&dias=30]  → (admin)
  // Versão em LOTE do financeiro, pro coletor (vendasSync). Recebe vários order_codes
  // e devolve o financeiro de todos de uma vez. Aproveita que uma janela de 15 dias já
  // traz muitos pedidos: varre de trás pra frente (até &dias, default 45) montando um
  // índice code→transações, e casa os codes pedidos. Devolve por code: comissão real
  // (serviço+tech), MDR, tarifa fixa, frete, devolução (REFUND), saldo líquido.
  if (method === 'GET' && p === '/magalu/financeiro-lote') {
    const emp = String(q.get('empresa') || '').toLowerCase().trim();
    if (!EMPRESAS_VALIDAS.includes(emp)) { json(res, 400, { ok: false, erro: 'empresa inválida' }); return true; }
    const codesRaw = String(q.get('codes') || '').trim();
    if (!codesRaw) { json(res, 400, { ok: false, erro: 'passe &codes=A,B,C' }); return true; }
    // sanitização: só codes numéricos (order_code da Magalu é numérico), no máximo 50 por chamada (anti-DoS)
    const codesLimpos = codesRaw.split(',').map(s => s.trim()).filter(s => /^\d{1,25}$/.test(s));
    if (!codesLimpos.length) { json(res, 400, { ok: false, erro: 'nenhum code válido (devem ser numéricos)' }); return true; }
    if (codesLimpos.length > 50) { json(res, 400, { ok: false, erro: 'máximo 50 codes por chamada' }); return true; }
    const codesPedidos = new Set(codesLimpos);
    const dias = Math.min(180, Math.max(15, parseInt(q.get('dias') || '45', 10) || 45));

    let tok = '';
    try { tok = await getAccessToken(emp); }
    catch (e) { json(res, 502, { ok: false, erro: 'token: ' + String(e.message || e) }); return true; }
    const H = { 'Authorization': 'Bearer ' + tok, 'Accept': 'application/json' };
    const BASE_FIN = 'https://api.magalu.com/seller/v1/financial-analysis/orders';

    async function pega(url) {
      const r = await fetch(url, { headers: H });
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch (e) {}
      return { status: r.status, j, t };
    }

    // resume as transações de um pedido nos campos que o dashboard usa
    function resumir(alvo) {
      const txs = alvo.transactions || [];
      let comissao = 0, mdr = 0, tarifa = 0, freteDebito = 0, freteCredito = 0, refund = 0, sale = 0;
      for (const t of txs) {
        const v = (t.value || 0) / (t.normalizer || 100);
        const cat = t.category, sub = t.subcategory, tp = t.type;
        if (cat === 'SALE') sale += v;
        else if (cat === 'COMMISSION') comissao += v;   // SERVICE + TECHNOLOGY + FREIGHT
        else if (cat === 'FEES' && sub === 'PAYMENT_PROCESSING') mdr += v;
        else if (cat === 'FEES' && sub === 'PLATFORM') tarifa += v;
        else if (cat === 'SHIPPING_COST') { if (tp === 'DEBIT') freteDebito += v; else if (tp === 'CREDIT') freteCredito += v; }
        else if (cat === 'REFUND') refund += v;
      }
      const saldo = txs.reduce((a, t) => {
        const v = (t.value || 0) / (t.normalizer || 100);
        return t.type === 'CREDIT' ? a + v : (t.type === 'DEBIT' ? a - v : a);
      }, 0);
      return {
        sale: Math.round(sale * 100) / 100,
        comissao: Math.round(comissao * 100) / 100,   // comissão real total (serviço+tech)
        mdr: Math.round(mdr * 100) / 100,
        tarifa_fixa: Math.round(tarifa * 100) / 100,
        frete_debito: Math.round(freteDebito * 100) / 100,   // frete que a Magalu cobra (inclui reverso)
        frete_credito: Math.round(freteCredito * 100) / 100,
        refund: Math.round(refund * 100) / 100,   // estorno de devolução (0 = sem devolução financeira)
        saldo_liquido: Math.round(saldo * 100) / 100,
        tem_devolucao: refund !== 0
      };
    }

    const MS_DIA = 86400000;
    const agora = Date.now();
    const limite = agora - dias * MS_DIA;
    const achados = {};   // code → resumo
    let fimBloco = agora, janelas = 0;
    // varre em janelas de 15 dias até cobrir 'dias' OU achar todos os codes pedidos
    while (fimBloco > limite && janelas < 13 && Object.keys(achados).length < codesPedidos.size) {
      const iniBloco = Math.max(limite, fimBloco - 15 * MS_DIA);
      const gte = new Date(iniBloco).toISOString();
      const lte = new Date(fimBloco).toISOString();
      const JAN = 'purchased_at__gte=' + encodeURIComponent(gte) + '&purchased_at__lte=' + encodeURIComponent(lte);
      janelas++;
      let offset = 0;
      while (offset < 1000) {
        const r = await pega(BASE_FIN + '?' + JAN + '&_limit=50&_offset=' + offset);
        if (r.status !== 200) {
          json(res, 200, { ok: false, empresa: emp, versao: VERSAO,
            nota: 'janela retornou ' + r.status, corpo: r.j || (r.t || '').slice(0, 300) });
          return true;
        }
        const arr = r.j && (r.j.results || r.j.data || (Array.isArray(r.j) ? r.j : [])) || [];
        if (!arr.length) break;
        for (const o of arr) {
          const oc = String((o.extras && o.extras.order_code) || o.order_code || o.external_id || '');
          if (codesPedidos.has(oc) && !achados[oc]) {
            // &cru=1: devolve TODAS as transações sem agrupar (pra ver o frete/tudo cru)
            if (q.get('cru') === '1') {
              achados[oc] = (o.transactions || []).map(t => ({
                categoria: t.category, sub: t.subcategory, tipo: t.type,
                valor: (t.value || 0) / (t.normalizer || 100), desc: t.description
              }));
            } else {
              achados[oc] = resumir(o);
            }
          }
        }
        offset += 50;
        if (Object.keys(achados).length >= codesPedidos.size) break;
      }
      fimBloco = iniBloco - 1000;
    }

    json(res, 200, {
      ok: true, empresa: emp, versao: VERSAO,
      pedidos: achados,   // { code: {comissao, mdr, tarifa_fixa, frete_debito, refund, saldo_liquido, tem_devolucao} }
      achados: Object.keys(achados).length,
      pedidos_faltando: [...codesPedidos].filter(c => !achados[c]),
      janelas_varridas: janelas
    });
    return true;
  }

  // ── IR PRO PEDIDO NO PORTAL DO MAGALU ────────────────────────────────
  // O ↗ do Magalu apontava pra /pedidos/<numero>, que dá 404 — a URL que abre
  // exige o UUID do PACOTE: /pedidos/<numero>/<uuid>. Esse uuid é deliveries[0].id
  // (confirmado: deliveries[0].code = "LU-<numero>-1", o "Pacote #...-1" do portal).
  // Buscamos o pedido pela API oficial (seller/v1/orders?code=<numero>), pegamos o
  // uuid do pacote, guardamos em disco (nunca muda) e redirecionamos. O token
  // renova sozinho, então não tem manutenção. &diag=1 mostra o passo a passo.
  // empresa vem no path: /magalu/ir/<empresa>?n=<numero>
  if (method === 'GET' && p.startsWith('/magalu/ir/')) {
    const emp = p.slice('/magalu/ir/'.length).toLowerCase().trim();
    const numero = String(q.get('n') || '').replace(/\D/g, '').trim();  // só dígitos (tira o "LU-")
    const diag = q.get('diag') === '1';
    const portalBusca = 'https://seller.magalu.com/pedidos';  // fallback: lista de pedidos
    const vai = dest => { res.writeHead(302, { Location: dest, 'Cache-Control': 'no-store' }); res.end(); };

    if (!EMPRESAS_VALIDAS.includes(emp)) {
      if (diag) json(res, 400, { ok: false, erro: 'empresa inválida', validas: EMPRESAS_VALIDAS });
      else vai(portalBusca);
      return true;
    }
    if (!numero) { if (diag) json(res, 400, { ok: false, erro: 'faltou ?n=' }); else vai(portalBusca); return true; }

    // cache: numero → uuid do pacote (nunca muda)
    const ARQ = path.join(DATA_DIR, emp + '-pacotes.json');
    const mapa = lerJson(ARQ, {}) || {};
    const urlPedido = uuid => 'https://seller.magalu.com/pedidos/' + numero + '/' + uuid;
    if (mapa[numero] && !diag) { vai(urlPedido(mapa[numero])); return true; }

    const passos = [];
    let uuid = mapa[numero] || null;
    if (uuid) passos.push({ passo: 'cache', uuid });

    try {
      const tok = await getAccessToken(emp);
      const r = await fetch('https://api.magalu.com/seller/v1/orders?_limit=5&code=' + encodeURIComponent(numero),
        { headers: { 'Authorization': 'Bearer ' + tok, 'Accept': 'application/json' } });
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch (e) {}
      let lista = j && (j.results || j.data || (Array.isArray(j) ? j : []));
      // fallback: se o filtro por code não bateu, casa no cliente
      let ped = (lista || []).find(x => String(x.code || '') === numero) || (lista || [])[0] || null;
      passos.push({ passo: 'consulta', status: r.status, achou_pedido: !!ped,
        corpo: ped ? undefined : (t || '').slice(0, 300) });

      if (ped && Array.isArray(ped.deliveries) && ped.deliveries[0] && ped.deliveries[0].id) {
        uuid = ped.deliveries[0].id;
        mapa[numero] = uuid;
        try { gravarJson(ARQ, mapa); } catch (e) {}
        passos.push({ passo: 'achou', uuid, delivery_code: ped.deliveries[0].code || null });
      } else if (ped) {
        passos.push({ passo: 'sem_delivery', chaves_pedido: Object.keys(ped) });
      }
    } catch (e) {
      passos.push({ passo: 'excecao', erro: String(e.message || e).slice(0, 250) });
    }

    if (diag) {
      json(res, 200, { ok: !!uuid, empresa: emp, numero, uuid,
        destino: uuid ? urlPedido(uuid) : portalBusca,
        pacotes_em_cache: Object.keys(mapa).length, versao: VERSAO, passos });
      return true;
    }
    vai(uuid ? urlPedido(uuid) : portalBusca);
    return true;
  }

  return false; // não é rota nossa
}

// ── páginas simples ──────────────────────────────────────────────────
function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }
function paginaSimples(titulo, corpoHtml) {
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + esc(titulo) + '</title>'
    + '<div style="max-width:640px;margin:40px auto;font:16px/1.5 system-ui,sans-serif;padding:0 16px">'
    + '<h2>' + esc(titulo) + '</h2><p>' + corpoHtml + '</p></div>';
}

// ══════════════════════════════════════════════════════════════════════
//  ARQUIVADOR — baixa as NF-e de fulfillment sozinho, 2x por dia
// ══════════════════════════════════════════════════════════════════════
//  POR QUE ARQUIVAR EM VEZ DE BAIXAR NA HORA: a Magalu leva de 3 a 40s pra
//  gerar o ZIP, e as vezes responde 408/429/503 pedindo pra esperar. Com o
//  cron, quando o Diego abre o painel o arquivo do dia JA ESTA PRONTO — o
//  download é instantâneo e não depende da Magalu estar de bom humor.

// ══════════════════════════════════════════════════════════════════════
//  ENVIO PRO BLING — replica a tela importador.notas.fiscais.lote.php
// ══════════════════════════════════════════════════════════════════════
//  TUDO AQUI FOI LIDO DO CODIGO DO PROPRIO BLING (27/07), nada chutado:
//
//  PASSO 1 (libs/fileuploader.js, qq.UploadHandlerXhr._upload):
//    POST {base}/upload.restore.php?idEmpresa={idEmpresa}
//    multipart/form-data com UM campo chamado "qqfile" (data.append("qqfile", file))
//    cabecalhos: X-Requested-With: XMLHttpRequest
//                X-File-Name: encodeURIComponent(nome)
//                Accept: application/json, text/javascript
//    resposta: {"success":true,"tmp":"<nome do arquivo temporario>"}
//
//  PASSO 2 (libs/xajax-*.js, Xajax.call, caso xajaxDefinedPost):
//    POST {base}/services/importador.notas.fiscais.lote.server.php?f=validarArquivoNotasFiscais
//    application/x-www-form-urlencoded, corpo:
//      xajax={funcao}&xajaxr={Date.now()}&xajaxargs[]={arg}...
//    a ordem dos argumentos vem de validarArquivo() do form.importador:
//      (nomeArquivo, tipo, loja, unidadeNegocio, lancarContas, lancarEstoque)
//
//  O COOKIE nunca fica no codigo: vem de BLING_COOKIE_GOOD / BLING_COOKIE_AMB.
//  Quando ele expira, o Bling devolve a tela de login em vez do JSON — e a
//  gente AVISA em vez de fingir que importou. Isso e nota fiscal.

const BLING_BASE = process.env.BLING_BASE || 'https://www.bling.com.br';

// idEmpresa / loja / unidade sao por conta. Tudo trocavel por env var, pra
// nao precisar mexer no codigo se ele criar outra unidade de negocio.
const BLING_IMP = {
  good: {
    idEmpresa: process.env.BLING_EMPRESA_GOOD || '4956030980',
    loja:      process.env.BLING_LOJA_GOOD    || '203381869',
    unidade:   process.env.BLING_UNIDADE_GOOD || '1726045',
    cookie:    () => blingLerCookie('good'),
    ua:        () => blingLerUA('good')
  },
  amb: {
    idEmpresa: process.env.BLING_EMPRESA_AMB || '14901993834',
    loja:      process.env.BLING_LOJA_AMB    || '206018666',
    unidade:   process.env.BLING_UNIDADE_AMB || '2920232',
    cookie:    () => blingLerCookie('amb'),
    ua:        () => blingLerUA('amb')
  }
};

const BLING_LIMITE = 3000000;   // tamMax do form.importador (3 MB)

// ── COOKIE DO BLING: arquivo em disco, env como fallback ──────────────
//  MESMO PADRAO do girassol/stagingImport.js (que ja faz isso ha tempo
//  pro importador de staging). Guardar em ARQUIVO e nao em env var e de
//  proposito: mexer em variavel de ambiente no Render REDEPLOYA o servico
//  inteiro, e esse cookie vence toda hora. Colar numa pagina nao derruba nada.
function blingCookieArquivo(emp) { return path.join(DATA_DIR, 'bling-cookie-' + emp + '.json'); }
function blingCookieArquivoAntigo(emp) { return path.join(DATA_DIR, 'bling-cookie-' + emp + '.txt'); }

// Extrai o User-Agent do cURL colado. IMPORTANTE: o Bling (PHP) amarra a
// sessao ao User-Agent — mandar um UA diferente do navegador que gerou o
// cookie faz ele responder com redirect pro /login (visto em 27/07).
// Por isso guardamos o UA junto e repetimos exatamente o mesmo.
function blingExtrairUA(texto) {
  const t = String(texto || '');
  const m = t.match(/-H\s+'user-agent:\s*([^']+)'/i) || t.match(/-H\s+"user-agent:\s*([^"]+)"/i)
         || t.match(/(?:^|\n)\s*user-agent:\s*([^\n'"]+)/i);
  return m ? m[1].trim() : '';
}

// Aceita o "Copiar como cURL" inteiro, um -H 'cookie: ...', ou a linha crua.
// Regras copiadas do extrairCookie() do stagingImport, que ja e testado em campo.
function blingExtrairCookie(texto) {
  if (!texto) return '';
  const t = String(texto).trim();
  const tenta = s => {
    let m = s.match(/-b\s+'([^']+)'/) || s.match(/-b\s+"([^"]+)"/) ||
            s.match(/--cookie\s+'([^']+)'/) || s.match(/--cookie\s+"([^"]+)"/);
    if (m) return m[1];
    m = s.match(/-H\s+'cookie:\s*([^']+)'/i) || s.match(/-H\s+"cookie:\s*([^"]+)"/i);
    if (m) return m[1];
    m = s.match(/(?:^|\n)\s*cookie:\s*([^\n'"]+)/i);
    if (m) return m[1];
    return null;
  };
  const achado = tenta(t) || tenta(t.replace(/\^/g, ''));
  if (achado) return achado.trim();
  if (t.indexOf('=') >= 0 && t.indexOf(';') >= 0) return t.replace(/^cookie:\s*/i, '').trim();
  return t;
}

// Cabecalho HTTP so aceita ASCII imprimivel. Se veio "…" (caractere 8230),
// e porque o texto foi copiado do PAINEL DE CABECALHOS do DevTools, que corta
// valores longos na exibicao. Melhor recusar na hora do que quebrar depois.
function blingConferirCookie(cookie) {
  for (let i = 0; i < cookie.length; i++) {
    const c = cookie.charCodeAt(i);
    if (c < 32 || c > 126) {
      const ch = cookie[i];
      return {
        ok: false, posicao: i, codigo: c, caractere: ch,
        erro: (ch === '…' || c === 8230)
          ? 'o cookie está CORTADO: tem "…" na posição ' + i + '. Isso acontece quando se copia do painel de cabeçalhos do DevTools, que encurta valores longos. Use botão direito na requisição → Copiar → Copiar como cURL, e cole o cURL inteiro aqui.'
          : 'o cookie tem um caractere inválido para cabeçalho HTTP na posição ' + i + ' (código ' + c + '). Recopie usando Copiar como cURL.'
      };
    }
  }
  return { ok: true };
}

function blingSalvarCookie(emp, cookie, ua) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
  fs.writeFileSync(blingCookieArquivo(emp), JSON.stringify({ cookie, ua: ua || '', salvo_em: new Date().toISOString() }), 'utf8');
}

// Ordem: arquivo em disco > env no padrao dele (GOOD_BLING_COOKIE) > env antiga
function blingLerSessao(emp) {
  try {
    const f = blingCookieArquivo(emp);
    if (fs.existsSync(f)) { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (j && j.cookie) return j; }
  } catch (e) {}
  try {
    const fv = blingCookieArquivoAntigo(emp);   // formato antigo (so o cookie)
    if (fs.existsSync(fv)) { const c = fs.readFileSync(fv, 'utf8').trim(); if (c) return { cookie: c, ua: '' }; }
  } catch (e) {}
  const env = process.env[emp.toUpperCase() + '_BLING_COOKIE'] || process.env['BLING_COOKIE_' + emp.toUpperCase()] || '';
  return env ? { cookie: env, ua: '' } : null;
}
function blingLerCookie(emp) { const ss = blingLerSessao(emp); return ss ? ss.cookie : ''; }
function blingLerUA(emp) {
  const ss = blingLerSessao(emp);
  return (ss && ss.ua) ? ss.ua : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:154.0) Gecko/20100101 Firefox/154.0';
}

function blingMultipart(nomeArquivo, buf) {
  const b = '----MoverPedidos' + Date.now().toString(16);
  const cab = Buffer.from(
    '--' + b + '\r\n' +
    'Content-Disposition: form-data; name="qqfile"; filename="' + nomeArquivo + '"\r\n' +
    'Content-Type: application/zip\r\n\r\n', 'utf8');
  const fim = Buffer.from('\r\n--' + b + '--\r\n', 'utf8');
  return { corpo: Buffer.concat([cab, buf, fim]), tipo: 'multipart/form-data; boundary=' + b };
}

// Se o cookie morreu, o Bling manda HTML de login em vez de JSON.
function blingParecePaginaDeLogin(txt) {
  const t = String(txt || '');
  // O Bling nao devolve HTML de login: devolve um <script> que redireciona.
  // Foi exatamente isso que voltou em 27/07 quando a sessao foi recusada.
  if (/location\.href\s*=\s*["'][^"']*\/login/i.test(t)) return true;
  if (/\/login\?r=/i.test(t)) return true;
  return /<html/i.test(t) && /login|senha|acesso/i.test(t);
}

async function blingUpload(cfg, nomeArquivo, buf) {
  const mp = blingMultipart(nomeArquivo, buf);
  const url = BLING_BASE + '/upload.restore.php?idEmpresa=' + encodeURIComponent(cfg.idEmpresa);
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Cookie': cfg.cookie(),
      'Accept': 'application/json, text/javascript',
      'X-Requested-With': 'XMLHttpRequest',
      'X-File-Name': encodeURIComponent(nomeArquivo),
      'Content-Type': mp.tipo,
      'Origin': BLING_BASE,
      'Referer': BLING_BASE + '/importador.notas.fiscais.lote.php',
      'User-Agent': cfg.ua()
    },
    body: mp.corpo
  });
  const txt = await r.text();
  if (blingParecePaginaDeLogin(txt)) throw new Error('COOKIE_EXPIRADO: o Bling devolveu a tela de login no upload');
  let j = null; try { j = JSON.parse(txt); } catch (e) {}
  if (!j || !j.success || !j.tmp) {
    throw new Error('upload não retornou o tmp (HTTP ' + r.status + '): ' + txt.slice(0, 250));
  }
  return j.tmp;
}

async function blingProcessar(cfg, tmp, tipo) {
  const args = [tmp, tipo, String(cfg.loja), String(cfg.unidade), 'true', 'false'];
  //                                                              ^lancarContas ^lancarEstoque
  // lancarEstoque SEMPRE false: o estoque do Full esta no CD da Magalu, nao no galpao.
  let corpo = 'xajax=' + encodeURIComponent('validarArquivoNotasFiscais') + '&xajaxr=' + Date.now();
  args.forEach(a => { corpo += '&xajaxargs[]=' + encodeURIComponent(a); });

  const url = BLING_BASE + '/services/importador.notas.fiscais.lote.server.php?f=validarArquivoNotasFiscais';
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Cookie': cfg.cookie(),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': '*/*',
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': BLING_BASE,
      'Referer': BLING_BASE + '/importador.notas.fiscais.lote.php',
      'User-Agent': cfg.ua()
    },
    body: corpo
  });
  const txt = await r.text();
  if (blingParecePaginaDeLogin(txt)) throw new Error('COOKIE_EXPIRADO: o Bling devolveu a tela de login ao processar');
  return { status: r.status, texto: txt };
}

// Bate na propria tela do importador so pra ver se a sessao esta viva.
// E leitura pura: nao envia nada, nao importa nada.
async function blingTestarSessao(empresa) {
  const cfg = BLING_IMP[empresa];
  if (!cfg) return { ok: false, erro: 'empresa inválida' };
  if (!cfg.cookie()) return { ok: false, viva: false, erro: 'nenhum cookie salvo' };
  const conf = blingConferirCookie(cfg.cookie());
  if (!conf.ok) return { ok: false, viva: false, erro: conf.erro };
  let r, txt;
  try {
    r = await fetch(BLING_BASE + '/importador.notas.fiscais.lote.php', {
      headers: {
        'Cookie': cfg.cookie(),
        'User-Agent': cfg.ua(),
        'Accept': 'text/html,application/xhtml+xml',
        'Referer': BLING_BASE + '/'
      }
    });
    txt = await r.text();
  } catch (e) { return { ok: false, viva: false, erro: String(e.message || e) }; }

  if (blingParecePaginaDeLogin(txt)) {
    return { ok: true, viva: false, http: r.status, motivo: 'o Bling mandou pra tela de login — sessão recusada', amostra: txt.slice(0, 200) };
  }
  // a pagina do importador tem o select loja_xml e a chamada initForm(idEmpresa)
  const achouForm = /loja_xml/.test(txt);
  const mId = /initForm\s*\(\s*(\d+)/.exec(txt);
  return {
    ok: true, viva: !!achouForm, http: r.status,
    achou_tela_do_importador: achouForm,
    idEmpresa_da_pagina: mId ? mId[1] : null,
    idEmpresa_configurado: cfg.idEmpresa,
    confere: mId ? (mId[1] === String(cfg.idEmpresa)) : null,
    amostra: achouForm ? undefined : txt.slice(0, 200)
  };
}

// Le o retorno do Bling e traduz pra numeros. As frases sao as que aparecem
// na tela de resultado (vistas em 27/07 num lote real da AMB).
function blingResumir(txt) {
  // tira os marcadores de CDATA antes das tags, senao sobra "]]>" no texto
  const limpo = String(txt || '')
    .replace(/<!\[CDATA\[/g, ' ').replace(/\]\]>/g, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const conta = re => (limpo.match(re) || []).length;
  return {
    ja_registradas: conta(/já está registrada|ja esta registrada/gi),
    eram_de_entrada: conta(/Para importar notas de entrada/gi),
    nao_importados: conta(/XML não importado|XML nao importado/gi),
    trecho: limpo.trim().slice(0, 400)
  };
}

// Quebra os XMLs em ZIPs de no maximo 3 MB (limite do Bling).
function blingFatiar(itens, limite) {
  const fatias = [];
  let atual = [];
  for (const it of itens) {
    atual.push(it);
    const tam = nfMontarZip(atual).length;
    if (tam > limite) {
      if (atual.length === 1) { fatias.push(atual); atual = []; continue; }  // um XML sozinho ja estoura: manda assim mesmo
      atual.pop();
      fatias.push(atual);
      atual = [it];
    }
  }
  if (atual.length) fatias.push(atual);
  return fatias;
}

// Importa um ZIP inteiro no Bling. tipo: 'S' (saida) ou 'E' (entrada).
// Manda SO as notas do tipo pedido — o Bling recusa as do outro tipo, mas
// mandar so o certo deixa o retorno legivel e o arquivo menor.
async function blingImportar(empresa, bufZip, tipo) {
  const cfg = BLING_IMP[empresa];
  if (!cfg) throw new Error('empresa sem configuração de Bling: ' + empresa);
  if (!cfg.cookie()) throw new Error('SEM_COOKIE: nenhum cookie do Bling salvo para ' + empresa + ' — cole em /magalu/nf-full/cookie?empresa=' + empresa);
  const confC = blingConferirCookie(cfg.cookie());
  if (!confC.ok) throw new Error('COOKIE_INVALIDO: ' + confC.erro);

  const sep = nfSeparar(bufZip);
  const itens = (tipo === 'E' ? sep.entrada : sep.saida);
  if (!itens.length) return { empresa, tipo, enviados: 0, aviso: 'nenhuma nota desse tipo no arquivo', lotes: [] };

  const fatias = blingFatiar(itens, BLING_LIMITE);
  const lotes = [];
  for (let i = 0; i < fatias.length; i++) {
    const buf = nfMontarZip(fatias[i]);
    const nome = 'magalu-' + empresa + '-' + (tipo === 'E' ? 'entrada' : 'saida') + '-' + (i + 1) + '.zip';
    const tmp = await blingUpload(cfg, nome, buf);
    const resp = await blingProcessar(cfg, tmp, tipo);
    lotes.push({ lote: i + 1, arquivo: nome, notas: fatias[i].length, bytes: buf.length, http: resp.status, resumo: blingResumir(resp.texto) });
    if (i < fatias.length - 1) await new Promise(r => setTimeout(r, 3000));
  }
  return { empresa, tipo, enviados: itens.length, lotes };
}

// ── SEPARAR O ZIP POR TIPO DE NOTA ────────────────────────────────────
//  DESCOBERTO EM 27/07 abrindo um ZIP real da AMB (183 XMLs): a Magalu
//  devolve TRES tipos de nota juntos, em pastas diferentes:
//    NfeVenda            (89) venda ao consumidor      tpNF=1  SAIDA
//    NfeRemessa           (3) remessa pro operador log. tpNF=1  SAIDA
//    NfeRetornoSimbolico (91) retorno simbolico         tpNF=0  ENTRADA
//  A importacao em lote do Bling pergunta se o lote e de saida OU de
//  entrada — entao mandar os 183 de uma vez classifica metade errado.
//  Por isso separamos AQUI, e o painel oferece um download de cada.
//
//  Classificamos pelo <tpNF> de dentro do XML, nao pelo nome da pasta:
//  se a Magalu renomear as pastas um dia, isso aqui continua certo.
// Chave de acesso (44 digitos). Tenta o Id="NFe..." do XML, que e o lugar
// canonico; se nao achar, cai pro nome do arquivo, que a Magalu monta como
// {pedido}-{chave}.xml. Sem chave, a nota nao entra na conta de "ja foi".
function nfChave(dados, nome) {
  const txt = dados.toString('utf8', 0, Math.min(dados.length, 4000));
  let m = /Id="NFe(\d{44})"/.exec(txt) || /<chNFe>(\d{44})<\/chNFe>/.exec(txt);
  if (m) return m[1];
  m = /(\d{44})/.exec(String(nome || ''));
  return m ? m[1] : null;
}

function nfSeparar(buf) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(buf);
  const saida = [], entrada = [], indefinido = [];
  zip.getEntries().forEach(e => {
    if (e.isDirectory) return;
    const nome = e.entryName.split('/').pop();
    if (!/\.xml$/i.test(nome)) return;
    let dados; try { dados = e.getData(); } catch (err) { return; }
    const m = /<tpNF>\s*([01])\s*<\/tpNF>/.exec(dados.toString('utf8'));
    const alvo = !m ? indefinido : (m[1] === '1' ? saida : entrada);
    alvo.push({ nome, dados, chave: nfChave(dados, nome) });
  });
  return { saida, entrada, indefinido };
}

// Monta um ZIP novo, com os arquivos soltos na raiz (sem subpasta).
function nfMontarZip(itens) {
  const AdmZip = require('adm-zip');
  const out = new AdmZip();
  itens.forEach(it => out.addFile(it.nome, it.dados));
  return out.toBuffer();
}

// Conta quantas notas de cada tipo tem no ZIP, pro painel mostrar.
function nfContar(buf) {
  try {
    const s = nfSeparar(buf);
    return { saida: s.saida.length, entrada: s.entrada.length, indefinido: s.indefinido.length };
  } catch (e) { return null; }
}

// Data no fuso de Sao Paulo, formato AAAA-MM-DD. O servico roda com
// TZ=America/Sao_Paulo, mas passamos o timeZone explicito pra nao depender
// disso — se alguem mexer na variavel, as datas continuam certas.
function nfHojeSP(d) {
  try { return (d || new Date()).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); }
  catch (e) { return (d || new Date()).toISOString().slice(0, 10); }
}

function nfGarantirDir() {
  try { fs.mkdirSync(NF_DIR, { recursive: true }); } catch (e) {}
}

// Pede o link assinado, insistindo nos status que significam "espera um pouco".
async function nfPedirLink(empresa, dIni, dFim) {
  const tok = await getAccessToken(empresa);
  const alvo = 'https://api.magalu.com/seller/v1/invoices/fulfillment'
             + '?start_date=' + encodeURIComponent(dIni) + '&end_date=' + encodeURIComponent(dFim);
  // O 429 da Magalu vem da BORDA (a resposta traz cabecalhos x-goog-* e um
  // last-modified de 2025: e uma pagina estatica de limite). Limite de borda
  // e por IP — e o IP aqui e o do Render, compartilhado por tudo que roda nele.
  // Uso real sao 4 chamadas por dia, entao o certo e ser MUITO paciente:
  // esperar minutos nao custa nada agora que a rotina roda em segundo plano.
  // Teto de ~17,5 min. A geracao levou 36s de manha, mas a noite (27/07,
  // 21h) um pacote novo devolveu 408 + 503s por mais de 7 min — a Magalu
  // gera mais devagar no horario de pico. Como roda em segundo plano,
  // esperar mais nao custa nada; desistir cedo custa a rodada inteira.
  const esperas = [0, 30000, 60000, 120000, 240000, 300000, 300000];
  const historico = [];
  for (let i = 0; i < esperas.length; i++) {
    if (esperas[i]) await new Promise(r => setTimeout(r, esperas[i]));
    const r = await fetch(alvo, { headers: { 'Authorization': 'Bearer ' + tok, 'Accept': 'application/json' } });
    const txt = await r.text();
    historico.push(r.status);
    if (r.status === 200) {
      let j = null; try { j = JSON.parse(txt); } catch (e) {}
      if (j && j.signed_url) return { link: j.signed_url, expira: j.expires_on || null, historico };
      throw new Error('a Magalu respondeu 200 mas sem signed_url: ' + txt.slice(0, 200));
    }
    // 408 = esta gerando | 429 = chamou rapido demais | 502/503/504 = timeout
    // ou instabilidade da borda da Magalu → insiste (todos transitorios).
    // O 504 (Gateway Timeout) aparece quando a Magalu demora a gerar o pacote
    // no horario de pico — mesma natureza do 408/503, entao tambem insistimos
    // em vez de abortar a rodada (era o que travava a GOOD em 17/08).
    if (r.status !== 408 && r.status !== 429 && r.status !== 502 && r.status !== 503 && r.status !== 504) {
      throw new Error('a Magalu respondeu ' + r.status + ': ' + txt.slice(0, 200));
    }
  }
  const minutos = Math.round(esperas.reduce((a, b) => a + b, 0) / 60000);
  const soGerando = historico.every(h => h === 408 || h === 502 || h === 503 || h === 504 || h === 429);
  throw new Error('a Magalu nao devolveu o link em ' + esperas.length + ' tentativas ao longo de ~' + minutos + ' min (status: ' + historico.join(', ') + ')' +
    (soGerando ? '. Ela ainda esta GERANDO o pacote — a geracao continua la mesmo depois de eu desistir; espere alguns minutos e rode de novo, ou deixe a proxima rodada automatica pegar' : ''));
}

// Pede o link e baixa o ZIP. Devolve o Buffer.
async function nfBaixarZip(empresa, dIni, dFim) {
  const info = await nfPedirLink(empresa, dIni, dFim);
  const rz = await fetch(info.link);
  if (!rz.ok) throw new Error('o link assinado devolveu HTTP ' + rz.status);
  const buf = Buffer.from(await rz.arrayBuffer());
  // ZIP comeca com PK — se nao comecar, veio outra coisa
  if (!(buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4B)) {
    throw new Error('o que voltou nao e um ZIP (' + buf.length + ' bytes): ' + buf.toString('utf8').slice(0, 150));
  }
  return buf;
}

// Guarda as chaves ja importadas por empresa. E isso que evita mandar de
// novo, 4x por dia, o mesmo lote pro Bling rejeitar tudo como repetido.
function nfArquivoImportadas(emp) { return path.join(NF_DIR, '_importado-' + emp + '.json'); }

// Duas listas separadas: saida e entrada. Sao importadas em lotes
// diferentes (muda o campo Tipo na tela do Bling), entao o controle
// tambem tem que ser separado.
function nfLerImportadas(emp) {
  try {
    const j = JSON.parse(fs.readFileSync(nfArquivoImportadas(emp), 'utf8'));
    // compatibilidade: o formato antigo tinha um "chaves" solto, que eram
    // as de saida (era o unico tipo que a gente importava ate 27/07)
    const antigas = Array.isArray(j.chaves) ? j.chaves : [];
    return {
      quando: j.quando || null, arquivo: j.arquivo || null, resumo: j.resumo || null,
      saida:   Array.isArray(j.saida)   ? j.saida   : antigas,
      entrada: Array.isArray(j.entrada) ? j.entrada : []
    };
  } catch (e) { return { quando: null, arquivo: null, resumo: null, saida: [], entrada: [] }; }
}

function nfGravarImportadas(emp, reg) {
  try {
    fs.mkdirSync(NF_DIR, { recursive: true });
    // guarda no maximo as 4000 ultimas de cada tipo
    if (reg.saida.length > 4000)   reg.saida   = reg.saida.slice(-4000);
    if (reg.entrada.length > 4000) reg.entrada = reg.entrada.slice(-4000);
    fs.writeFileSync(nfArquivoImportadas(emp), JSON.stringify(reg));
  } catch (e) {}
}

// Quais notas desse ZIP, do tipo pedido, ainda NAO foram importadas.
function nfNovasDoArquivo(emp, nomeArquivo, tipo) {
  const buf = fs.readFileSync(path.join(NF_DIR, nomeArquivo));
  const sep = nfSeparar(buf);
  const imp = nfLerImportadas(emp);
  const ehEntrada = (tipo === 'E' || tipo === 'entrada');
  const todas = ehEntrada ? sep.entrada : sep.saida;
  const ja = new Set(ehEntrada ? imp.entrada : imp.saida);
  return { todas, novas: todas.filter(it => it.chave && !ja.has(it.chave)) };
}

function nfListar(empresa) {
  nfGarantirDir();
  let nomes = [];
  try { nomes = fs.readdirSync(NF_DIR); } catch (e) { return []; }
  return nomes
    .filter(n => /^[a-z]+-\d{4}-\d{2}-\d{2}-\d{4}\.zip$/.test(n))
    .filter(n => !empresa || n.startsWith(empresa + '-'))
    .map(n => {
      let st = null; try { st = fs.statSync(path.join(NF_DIR, n)); } catch (e) {}
      let notas = null;
      try { notas = JSON.parse(fs.readFileSync(path.join(NF_DIR, n + '.json'), 'utf8')); } catch (e) {}
      return { nome: n, empresa: n.split('-')[0], bytes: st ? st.size : 0, em: st ? st.mtime.toISOString() : null, notas };
    })
    .sort((a, b) => (b.em || '').localeCompare(a.em || ''));
}

// Apaga os mais antigos, mantendo os NF_MANTER mais novos de cada empresa.
function nfLimpar(empresa) {
  const lista = nfListar(empresa);
  lista.slice(NF_MANTER).forEach(f => {
    try { fs.unlinkSync(path.join(NF_DIR, f.nome)); } catch (e) {}
    try { fs.unlinkSync(path.join(NF_DIR, f.nome + '.json')); } catch (e) {}
  });
}

// A rotina em si: para cada empresa, puxa os ultimos NF_DIAS e grava.
async function nfRotina(origem, quais) {
  nfGarantirDir();
  const agora = new Date();
  // ⚠ NAO usar toISOString(): ele devolve UTC. Depois das 21h de Brasilia o
  // "hoje" em UTC ja e amanha, entao a rodada das 23h pedia a Magalu um
  // periodo terminando numa data FUTURA e carimbava o arquivo errado.
  const ate = nfHojeSP(agora);
  // ── ANTI-CACHE ──────────────────────────────────────────────────────
  //  O caminho do ZIP no storage da Magalu inclui o periodo:
  //    invoices_fulfillment/{seller}/{de}-{ate}/invoices-{de}-{ate}.zip
  //  Pedir SEMPRE o mesmo intervalo = sempre a mesma chave, e ha indicios
  //  (27/07) de que eles devolvem o arquivo cacheado da primeira geracao
  //  do dia em vez de regerar. Variar o "de" por rodada muda a chave e
  //  forca um pacote novo: 6h pede 31 dias, 12h 30, 18h 29, 23h 28.
  //  Encolher a janela nao perde nada — o Bling deduplica por chave e a
  //  rodada seguinte volta a cobrir mais.
  const horaSP = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false }), 10) || 0;
  const ORDEM_RODADA = { 6: 0, 12: 1, 18: 2, 23: 3 };
  const varia = (ORDEM_RODADA[horaSP] !== undefined) ? ORDEM_RODADA[horaSP] : (horaSP % 4);
  const dias = Math.max(7, NF_DIAS - varia);
  const de  = nfHojeSP(new Date(agora.getTime() - (dias - 1) * 864e5));
  const carimbo = ate + '-' + String(agora.getHours()).padStart(2, '0') + String(agora.getMinutes()).padStart(2, '0');
  const resultado = [];

  const lista = (quais && quais.length) ? quais : NF_EMPRESAS;
  for (const emp of lista) {
    try {
      const buf = await nfBaixarZip(emp, de, ate);
      const nome = emp + '-' + carimbo + '.zip';
      fs.writeFileSync(path.join(NF_DIR, nome), buf);
      const cont = nfContar(buf);
      if (cont) { try { fs.writeFileSync(path.join(NF_DIR, nome + '.json'), JSON.stringify(cont)); } catch (e) {} }
      nfLimpar(emp);
      const linha = { empresa: emp, ok: true, arquivo: nome, bytes: buf.length, notas: cont };
      // So manda pro Bling sozinho se BLING_IMPORT_AUTO=1. Desligado por padrao
      // de proposito: primeiro ele testa na mao pelo painel e confere o retorno.
      if (process.env.BLING_IMPORT_AUTO === '1' && BLING_IMP[emp] && BLING_IMP[emp].cookie()) {
        try { linha.bling = await blingImportar(emp, buf, 'S'); }
        catch (e) { linha.bling = { erro: String(e.message || e) }; console.error('[magalu-nf] bling ' + emp + ':', e.message); }
      }
      resultado.push(linha);
      console.log('[magalu-nf] (' + origem + ') ' + emp + ': ' + nome + ' (' + buf.length + ' bytes, periodo ' + de + ' a ' + ate + ')');
    } catch (e) {
      resultado.push({ empresa: emp, ok: false, erro: String(e.message || e) });
      console.error('[magalu-nf] (' + origem + ') ' + emp + ' FALHOU:', e.message);
    }
    // espaco entre empresas: o endpoint devolve 429 se chamar em sequencia
    if (emp !== lista[lista.length - 1]) await new Promise(r => setTimeout(r, 120000));   // 2 min: as duas empresas disputam o mesmo orcamento de IP
  }
  return { periodo: { de, ate }, resultado };
}

// ── EXECUCAO EM SEGUNDO PLANO ─────────────────────────────────────────
//  A rotina agora leva minutos (as esperas do 429 sao longas de proposito).
//  Segurar a resposta do navegador esse tempo todo da tela branca e ainda
//  arrisca o proxy do Render cortar. Entao: dispara e responde na hora, e o
//  painel mostra o andamento.
let nfRodando = false;
let nfUltima = null;
const NF_ESTADO = () => path.join(NF_DIR, '_ultima-execucao.json');

function nfSalvarEstado() {
  try { fs.mkdirSync(NF_DIR, { recursive: true }); fs.writeFileSync(NF_ESTADO(), JSON.stringify(nfUltima)); } catch (e) {}
}
function nfLerEstado() {
  if (nfUltima) return nfUltima;
  try { return JSON.parse(fs.readFileSync(NF_ESTADO(), 'utf8')); } catch (e) { return null; }
}

function nfDisparar(origem, quais) {
  if (nfRodando) return { disparou: false, motivo: 'já tem uma execução em andamento' };
  nfRodando = true;
  nfUltima = { origem, empresas: (quais && quais.length) ? quais : NF_EMPRESAS, inicio: new Date().toISOString(), fim: null, resultado: null };
  nfSalvarEstado();
  nfRotina(origem, quais)
    .then(r => { nfUltima.periodo = r.periodo; nfUltima.resultado = r.resultado; })
    .catch(e => { nfUltima.erro = String(e.message || e); })
    .finally(() => { nfUltima.fim = new Date().toISOString(); nfRodando = false; nfSalvarEstado(); });
  return { disparou: true };
}

// Agenda no carregamento do modulo. Nao precisa mexer no index.js da RAIZ.
try {
  const cron = require('node-cron');
  cron.schedule(NF_CRON, () => {
    nfDisparar('cron');
  });
  console.log('[magalu-nf] cron agendado: ' + NF_CRON + ' | empresas: ' + NF_EMPRESAS.join(', ') + ' | pasta: ' + NF_DIR);
} catch (e) {
  console.error('[magalu-nf] nao consegui agendar o cron:', e.message);
}

module.exports = { tratar, getAccessToken, VERSAO, EMPRESAS_VALIDAS };
