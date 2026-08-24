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
//  O QUE ELE COBRE: os .js do servidor, os .js de tela e o miolo dos <script> dentro dos
//  .html. Inclui nome usado só em `typeof x === 'function'` — o repo tem 96 guardas dessas,
//  várias na rotina noturna, onde um erro de digitação desliga uma etapa EM SILÊNCIO.
//
//  O QUE ELE NÃO COBRE (não confie como se cobrisse): código dentro de atributo de evento
//  no HTML — onclick, onchange e afins. São 671 no repo. O eslint-plugin-html lê o corpo
//  dos <script>, não os atributos. Um extrator ingênuo de `on*="..."` não resolve porque
//  164 desses casam DENTRO de <script>, em HTML montado por concatenação de string
//  (ex.: onclick="histIrPagina('+(pgAtual-1)+')" na linha 688 do amb-dashboard.html, dentro
//  do <script> que abre na 394) — tentar interpretar isso como JS dá falso positivo, e
//  detector que grita à toa é detector que todo mundo passa a ignorar. Cobrir isso direito
//  pede outro mecanismo: separar os <script> do resto, pegar só os atributos literais e
//  cruzar os nomes chamados com as funções declaradas no arquivo. Fica pra depois.
//
//  Rodar na mão (na raiz do repo):
//     npm install --no-save eslint@9 eslint-plugin-html globals
//     npx eslint --no-config-lookup -c .github/eslint-orfaos.mjs .
// ════════════════════════════════════════════════════════════════════════════════

import globals from "globals";
import html from "eslint-plugin-html";

/* Lista OFICIAL do pacote `globals`, não escrita na mão: a minha versão anterior
   esquecia global/Response/Headers/EventTarget e os acusaria como órfãos (Codex #190).

   Mas `globals.node` não tem versão: traz nomes que só existem do Node 20/22 em diante,
   e o package.json declara `"node": ">=18"`. Se algum dia isto rodar num 18, um `File` ou
   `CustomEvent` no servidor passaria no detector e quebraria em produção. Então os que
   não existem no 18 saem daqui — nenhum é usado no repo hoje (conferido: os 2 `File` que
   aparecem são o cabeçalho HTTP `X-File-Name`, não o global) (Codex #190).

   ⚠️ Se o piso do package.json subir para 20+, dá pra apagar esta subtração inteira. */
/* Os 22 nomes que `globals.node` traz mas que NÃO existem no Node 18. Esta lista não foi
   escrita de cabeça: foi MEDIDA rodando o Node 18.20.8 de verdade e filtrando
   `globals.node` por `typeof globalThis[nome] === 'undefined'` (descontando require,
   module, exports, __dirname, __filename e arguments, que são escopo de módulo e não
   aparecem em globalThis). Eu tinha escrito na mão antes e errei nos dois sentidos:
   faltavam Crypto e a família Performance, e MessageEvent estava aqui indevidamente —
   ele EXISTE no 18 e virava falso positivo (Codex #190).

   Pra refazer se o piso mudar:
     node -e "const g=require('globals');const m=new Set(['require','module','exports','__dirname','__filename','arguments']);console.log(JSON.stringify(Object.keys(g.node).filter(n=>!m.has(n)&&typeof globalThis[n]==='undefined')))"
   rodado NA VERSÃO do piso. Se o package.json subir pra 20+, dá pra apagar tudo isto. */
const NAO_EXISTEM_NO_NODE_18 = [
  'CloseEvent', 'Crypto', 'CryptoKey', 'CustomEvent', 'ErrorEvent', 'File',
  'localStorage', 'navigator', 'Navigator', 'PerformanceEntry', 'PerformanceMark',
  'PerformanceMeasure', 'PerformanceObserver', 'PerformanceObserverEntryList',
  'PerformanceResourceTiming', 'QuotaExceededError', 'sessionStorage', 'Storage',
  'SubtleCrypto', 'Temporal', 'URLPattern', 'WebSocket'
];
const SERVIDOR = Object.fromEntries(
  Object.entries(globals.node).filter(([nome]) => !NAO_EXISTEM_NO_NODE_18.includes(nome))
);

/* Tela: SÓ os globais de navegador. Antes eu espalhava os de Node aqui dentro, o que
   deixava passar `process`/`require`/`Buffer` num arquivo de tela — que quebram no
   navegador e são justamente o que este detector existe pra pegar (Codex #190). */
/* Tela: SÓ os globais de navegador. As bibliotecas de CDN NÃO entram aqui — vão em blocos
   por página, mais abaixo. Se `qz` valesse pro repo todo, um `qz` esquecido no admin.html
   do ponto passaria batido e quebraria só no navegador do usuário (Codex #190). */
const TELA = { ...globals.browser };

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
    rules: { "no-undef": ["error", { typeof: true }] }
  },

  // arquivos de tela servidos direto
  {
    files: ["public/**/*.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "script", globals: TELA },
    rules: { "no-undef": ["error", { typeof: true }] }
  },

  /* Script DENTRO do HTML. É onde mora a maior parte do código de tela — os painel.html
     e os dashboard.html passam de 2.000 linhas cada. Sem isto, o comando lá em cima diria
     "repo inteiro" cobrindo só metade dele (Codex #190). */
  {
    files: ["**/*.html"],
    plugins: { html },
    languageOptions: { ecmaVersion: 2022, sourceType: "script", globals: TELA },
    rules: { "no-undef": ["error", { typeof: true }] }
  },

  /* ─── Bibliotecas de CDN, liberadas SÓ na página que carrega cada uma ───────────────
     Cada bloco abaixo foi conferido contra o <script src> real do arquivo. Liberar pro
     repo todo criaria falso negativo: um `qz` esquecido em public/ponto/admin.html
     passaria no detector e quebraria no navegador (Codex #190).
     Se a biblioteca sair do HTML, TIRE o bloco — senão o nome fica desprotegido calado. */
  { // qz-tray 2.2.6 (impressão) + js-sha256 0.11.0
    files: ["amb-checkout-offline/painel.html", "girassol-backup-offline/painel.html",
            "good-checkout-offline/painel.html"],
    plugins: { html },
    languageOptions: { globals: { qz: "readonly", sha256: "readonly" } }
  },
  { // Chart.js 4.4.1 (gráficos)
    files: ["amb-checkout-offline/amb-dashboard.html", "girassol-backup-offline/dashboard.html"],
    plugins: { html },
    languageOptions: { globals: { Chart: "readonly" } }
  },
  { // html5-qrcode 2.3.8 (leitor de código no celular)
    files: ["public/estoque/celular.html", "public/estoque-girassol/celular.html"],
    plugins: { html },
    languageOptions: { globals: { Html5Qrcode: "readonly", Html5QrcodeSupportedFormats: "readonly" } }
  },
  { // xlsx 0.18.5 — o <script src> está no index.html, o uso está no app.js da mesma pasta
    files: ["public/fragil/**"],
    plugins: { html },
    languageOptions: { globals: { XLSX: "readonly" } }
  }
];
