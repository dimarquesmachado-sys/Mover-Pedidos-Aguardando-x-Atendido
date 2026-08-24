// ════════════════════════════════════════════════════════════════════════════════
//  DETECTOR DE IDENTIFICADOR ÓRFÃO (24/08/2026)
// ════════════════════════════════════════════════════════════════════════════════
//  Nasceu do PR #189: ao extrair 3 funções para lib/vendas-ops.js, QUATRO estados
//  ficaram órfãos (_reapC, supaCfg, _varFor, _histCache) — o código usava nomes que
//  só existiam no arquivo de origem. Dois derrubavam a rota na hora; o do _histCache
//  estava dentro de um catch vazio, então falhava EM SILÊNCIO: nada quebrava, a
//  invalidação do cache só deixava de acontecer.
//
//  `node --check` não pega isso (a sintaxe está perfeita) e o Codex gasta uma rodada.
//  Esta regra pega em ~20s, antes de abrir o PR.
//
//  Rodar na mão (na raiz do repo):
//     npm install --no-save eslint@9 eslint-plugin-html globals
//     npx eslint --no-config-lookup -c .github/eslint-orfaos.mjs .
// ════════════════════════════════════════════════════════════════════════════════

import globals from "globals";
import html from "eslint-plugin-html";

/* Lista OFICIAL do pacote `globals`, não escrita na mão: a minha versão anterior
   esquecia global/Response/Headers/EventTarget e os acusaria como órfãos (Codex #190). */
const SERVIDOR = globals.node;

/* Tela: SÓ os globais de navegador. Antes eu espalhava os de Node aqui dentro, o que
   deixava passar `process`/`require`/`Buffer` num arquivo de tela — que quebram no
   navegador e são justamente o que este detector existe pra pegar (Codex #190). */
/* Bibliotecas que entram por <script src> de CDN — existem em tempo de execução, mas o
   eslint não tem como saber. Cada uma conferida no HTML antes de entrar nesta lista;
   se uma sair do HTML, TIRE daqui também, senão o detector para de proteger aquele nome. */
const CDN = {
  XLSX: "readonly",                        // cdnjs xlsx 0.18.5 — planilhas
  qz: "readonly",                          // jsdelivr qz-tray 2.2.6 — impressão nos painel.html
  Chart: "readonly",                        // cdnjs Chart.js 4.4.1 — gráficos dos dashboard.html
  sha256: "readonly",                      // jsdelivr js-sha256 0.11.0
  Html5Qrcode: "readonly",                 // unpkg html5-qrcode 2.3.8 — leitor nos celular.html
  Html5QrcodeSupportedFormats: "readonly"  // idem
};

const TELA = { ...globals.browser, ...CDN };

export default [
  { ignores: ["node_modules/**", "**/node_modules/**"] },

  /* servidor. O `ignores` aqui é OBRIGATÓRIO: no eslint os blocos se SOMAM, não se
     substituem. Sem ele, um arquivo de public/ casaria com este bloco também e receberia
     os globais de Node de volta — que é justamente o furo do Codex #190. Testado: sem o
     ignores, um process/require/Buffer em public/*.js passa batido. */
  {
    files: ["**/*.js"],
    ignores: ["public/**/*.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "commonjs", globals: SERVIDOR },
    rules: { "no-undef": "error" }
  },

  // arquivos de tela servidos direto
  {
    files: ["public/**/*.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "script", globals: TELA },
    rules: { "no-undef": "error" }
  },

  /* Script DENTRO do HTML. É onde mora a maior parte do código de tela — os painel.html
     e os dashboard.html passam de 2.000 linhas cada. Sem isto, o comando acima diria
     "repo inteiro" cobrindo só metade dele (Codex #190). */
  {
    files: ["**/*.html"],
    plugins: { html },
    languageOptions: { ecmaVersion: 2022, sourceType: "script", globals: TELA },
    rules: { "no-undef": "error" }
  }
];
