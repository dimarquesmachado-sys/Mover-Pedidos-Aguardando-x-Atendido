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
//  Esta regra pega em 20 segundos, antes de abrir o PR.
//
//  Rodar na mão:  npx eslint --no-config-lookup -c .github/eslint-orfaos.mjs .
// ════════════════════════════════════════════════════════════════════════════════

const NODE = {
  require:"readonly", module:"writable", exports:"writable", process:"readonly",
  console:"readonly", Buffer:"readonly", __dirname:"readonly", __filename:"readonly",
  setTimeout:"readonly", clearTimeout:"readonly", setInterval:"readonly", clearInterval:"readonly",
  setImmediate:"readonly", fetch:"readonly", URL:"readonly", URLSearchParams:"readonly",
  AbortController:"readonly", AbortSignal:"readonly", TextEncoder:"readonly", TextDecoder:"readonly",
  globalThis:"readonly", structuredClone:"readonly", queueMicrotask:"readonly", crypto:"readonly"
};

// os arquivos de tela rodam no NAVEGADOR — ali document/window/alert são legítimos
const NAVEGADOR = {
  ...NODE,
  window:"readonly", document:"readonly", location:"readonly", navigator:"readonly",
  alert:"readonly", confirm:"readonly", prompt:"readonly", history:"readonly", screen:"readonly",
  localStorage:"readonly", sessionStorage:"readonly", FileReader:"readonly", Blob:"readonly",
  FormData:"readonly", Image:"readonly", DOMParser:"readonly", WebSocket:"readonly",
  btoa:"readonly", atob:"readonly", getComputedStyle:"readonly", performance:"readonly",
  requestAnimationFrame:"readonly", MutationObserver:"readonly", CustomEvent:"readonly",
  Event:"readonly", Node:"readonly", HTMLElement:"readonly", chrome:"readonly",
  SpeechSynthesisUtterance:"readonly", speechSynthesis:"readonly",
  XLSX:"readonly"   // vem por <script> do CDN
};

export default [
  { ignores: ["node_modules/**", "**/node_modules/**"] },
  {
    files: ["**/*.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "commonjs", globals: NODE },
    rules: { "no-undef": "error" }
  },
  {
    files: ["public/**/*.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "script", globals: NAVEGADOR },
    rules: { "no-undef": "error" }
  }
];
