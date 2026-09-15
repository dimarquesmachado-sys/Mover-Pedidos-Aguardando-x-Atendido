'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   PÁGINA DE EMBARQUE — uma tela com o que falta autorizar (15/09/2026).

   O objetivo declarado pelo dono: "clicar em menos coisas". Hoje, pra ligar uma
   empresa, ele precisa abrir TRÊS URLs diferentes e lembrar de cada uma — e não
   tem como saber o que já autorizou sem tentar. O padrão que funciona já existe
   no repositório: o `tiktok-oauth` virou uma página de botões depois de ele
   reclamar de "4 URLs na mão", e é esse desenho que esta página repete.

   O que ela mostra, por empresa: cada conta (Bling, Bling NF, Mercado Livre) com
   ✅ se o token já existe, e o botão de autorizar quando não existe.

   Duas decisões que valem explicar:

   · A presença do token é vista pelo ARQUIVO em disco, não tentando usá-lo. Uma
     tela de diagnóstico não pode gastar chamada de API nem, pior, disparar uma
     renovação de refresh de uso único só porque alguém abriu a página.

   · Nenhum valor de token aparece — nem parcial. A tela diz "existe" ou "falta".
     Quem precisa do valor tem o Render; quem abre isto quer saber o que falta.
   ──────────────────────────────────────────────────────────────────────────── */

const fs = require('fs');

function criar(cfg) {
  for (const n of ['empresas', 'html', 'base']) {
    if (!cfg || cfg[n] == null) throw new Error('lib/fiscal/painel-embarque: falta ' + n);
  }
  const { empresas, html, base } = cfg;

  function _existe(arq) {
    try {
      const d = JSON.parse(fs.readFileSync(arq, 'utf8'));
      /* arquivo vazio ou sem refresh não é token: seria dizer "autorizado" pra quem
         ainda precisa autorizar, que é o pior erro possível nesta tela. */
      return !!(d && (d.refresh_token || d.access_token));
    } catch (e) { return false; }
  }

  function estado() {
    return empresas.map(e => ({
      id: e.id,
      nome: e.nome,
      contas: [
        { conta: 'Bling (pedidos)', ok: _existe(e.arquivoBling), autorizar: base + e.slug + '/callback' },
        { conta: 'Bling (NF-e)', ok: _existe(e.arquivoBlingNF), autorizar: base + e.slug + '/callback-nf' },
        { conta: 'Mercado Livre', ok: _existe(e.arquivoML), autorizar: base + e.slug + '/callback-ml' },
      ],
    }));
  }

  function pagina() {
    const linhas = estado().map(e => {
      const contas = e.contas.map(c => c.ok
        ? '<li class="ok">✅ ' + c.conta + ' <span class="obs">já autorizado</span></li>'
        : '<li class="falta">⬜ ' + c.conta + ' <a href="' + c.autorizar + '">autorizar agora</a></li>').join('');
      const faltam = e.contas.filter(c => !c.ok).length;
      return '<section><h2>' + e.nome + ' <small>' + (faltam ? faltam + ' pendente(s)' : 'tudo autorizado') +
             '</small></h2><ul>' + contas + '</ul></section>';
    }).join('');
    return '<!doctype html><meta charset="utf-8"><title>Embarque</title>' +
      '<style>body{font:15px system-ui;max-width:720px;margin:32px auto;padding:0 16px;color:#1a1a1a}' +
      'h1{font-size:20px} h2{font-size:16px;margin:24px 0 8px} small{font-weight:400;color:#666}' +
      'ul{list-style:none;padding:0} li{padding:7px 0;border-bottom:1px solid #eee}' +
      '.obs{color:#888;font-size:13px} a{color:#0b5ed7}</style>' +
      '<h1>Embarque — o que falta autorizar</h1>' +
      '<p style="color:#666">Cada autorização é um clique e vale uma vez. ' +
      'A tela olha o token em disco: não gasta chamada de API nem dispara renovação.</p>' + linhas;
  }

  return { estado, pagina };
}

module.exports = { criar };
