/* GOOD Toolbox — service worker raiz: os 3 backgrounds originais entram BYTE A BYTE
   (colisões de nomes verificadas: zero) e cada onMessage já filtra pelo seu tipo
   (SYNC_AGORA / MM_* / BLING_DEVOLUCAO_*), então coexistem sem se atrapalhar. */
importScripts('bg-fragil.js', 'bg-mm.js', 'bg-devolucoes.js');
