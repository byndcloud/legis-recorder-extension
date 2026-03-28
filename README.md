# Legis - Gravador de Fluxos (Extensao Chrome)

Extensao Chrome (Manifest V3) que grava interacoes do usuario em sites de tribunais brasileiros e exporta um JSON rico ("Semantic HAR") para geracao automatizada de scripts de automacao.

## Instalacao

```
1. Abra chrome://extensions/
2. Ative "Modo do desenvolvedor"
3. Clique "Carregar sem compactacao"
4. Selecione esta pasta (legis-recorder-extension/)
```

Na primeira vez, gere os icones:

```bash
node scripts/generate-icons.js
```

## Como usar

1. Clique no icone da extensao na barra do Chrome
2. Clique **Iniciar Gravacao** e use o site normalmente
3. Adicione observacoes a qualquer momento pelo campo de texto no popup
4. Clique **Parar** quando terminar
5. Exporte o JSON ou abra o visualizador de steps

## Estrutura de arquivos

```
legis-recorder-extension/
├── manifest.json               Manifest V3 — permissions, content scripts, service worker
├── background.js               Service Worker (ES module) — coordena toda a gravacao
├── content.js                  Content Script — injetado em todas as paginas/iframes
├── popup.html / .js / .css     UI de controle (4 telas: welcome, recording, paused, done)
├── viewer.html / .js / .css    Visualizador navegavel de steps em aba dedicada
├── lib/
│   ├── selector-generator.js   Gera CSS selectors e XPaths unicos para cada elemento
│   ├── dom-snapshot.js         Captura HTML completo do document + iframes same-origin
│   ├── event-capture.js        Escuta eventos do usuario e monta acoes semanticas
│   ├── enrichment.js           MutationObserver, deteccao de loaders, interceptacao de dialogos
│   ├── network-capture.js      Intercepta requests via chrome.debugger + console errors
│   └── storage.js              Persistencia incremental + historico via chrome.storage.local
├── icons/
│   ├── logo.svg                Logo da marca Legis
│   ├── icon16.png              Icone 16x16
│   ├── icon48.png              Icone 48x48
│   └── icon128.png             Icone 128x128
└── scripts/
    └── generate-icons.js       Gera os PNGs de icone a partir de codigo (Node.js)
```

## Arquitetura

```
┌──────────────────────────────────────────────────────────┐
│  Content Script (todas as paginas + iframes)             │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐ │
│  │ EventCapture │ │ SelectorGen  │ │   Enrichment     │ │
│  │  (eventos)   │ │ (seletores)  │ │ (DOM obs/dialog) │ │
│  └──────┬───────┘ └──────────────┘ └────────┬─────────┘ │
│         │  acao + DOM snapshot + extras      │           │
│         └──────────────┬────────────────────-┘           │
└────────────────────────┼─────────────────────────────────┘
                         │ chrome.runtime.sendMessage
                         v
┌──────────────────────────────────────────────────────────┐
│  Service Worker (background.js)                          │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐ │
│  │  Screenshot  │ │NetworkCapture│ │    Storage        │ │
│  │ captureTab() │ │  (debugger)  │ │ chrome.storage    │ │
│  └──────┬───────┘ └──────┬───────┘ └────────┬─────────┘ │
│         │                │                   │           │
│         └────── step completo ───────────────┘           │
│                   (Semantic HAR)                          │
└──────────────────────────────────────────────────────────┘
                         │
                         v
              ┌─────────────────────┐
              │   chrome.storage    │
              │   (incrementally)   │
              └─────────┬───────────┘
                        │
            ┌───────────┼──────────┐
            v           v          v
         Popup       Viewer     Export
       (controle)  (inspecao)   (.json)
```

## Permissions


| Permission           | Uso                                                        |
| -------------------- | ---------------------------------------------------------- |
| `activeTab` + `tabs` | Captura de screenshot e indice da aba ativa                |
| `debugger`           | Chrome DevTools Protocol — network requests + console      |
| `storage`            | Persistencia de gravacoes                                  |
| `unlimitedStorage`   | Sem limite de 10MB (gravacoes com screenshots sao grandes) |
| `webNavigation`      | Detectar navegacoes e mudancas de URL via History API      |
| `<all_urls>` (host)  | Injetar content script em qualquer site                    |


## O que cada step captura

### Acao semantica


| Tipo                 | Descricao                                | Campos notaveis                         |
| -------------------- | ---------------------------------------- | --------------------------------------- |
| `click`              | Clique em elemento                       | target, coordenadas, modificadores      |
| `input_text`         | Digitacao ou paste em campo              | valor, metodo (typed/pasted), clipboard |
| `select_option`      | Selecao em dropdown                      | opcao selecionada + todas disponiveis   |
| `checkbox_toggle`    | Marcar/desmarcar checkbox                | checked (boolean)                       |
| `radio_select`       | Selecao de radio                         | valor, grupo, opcoes disponiveis        |
| `file_upload`        | Upload de arquivo(s)                     | nomes, tamanhos, MIME types             |
| `key_press`          | Tecla significativa                      | key, code, modificadores                |
| `scroll`             | Rolagem (debounced 300ms)                | direcao, posicoes antes/depois          |
| `navigation`         | Mudanca de URL                           | URLs, trigger, form_state no submit     |
| `drag_and_drop`      | Arrastar e soltar                        | source + destination targets            |
| `dialog_interaction` | Alert/confirm/prompt nativo interceptado | texto, resposta, tempo de exibicao      |


### Target (elemento DOM)

Cada target contem:

- **Identificacao:** tag, id, classes, name, type, aria-label, placeholder, label associado
- **Seletores:** CSS selector (priorizando #id > [name] > hierarquico) + XPath absoluto
- **Posicao:** bounding rect, se esta em iframe, src do iframe
- **Visibilidade:** visible, display, visibility, opacity, enabled, readonly, in_viewport
- **Vizinhos:** 2 irmaos anteriores + 2 posteriores (tag, id, classes, texto)
- **Contexto semantico:** heading e landmark ARIA mais proximos acima do elemento

### Contexto enriquecido (campo `context` do step)


| Campo                           | Descricao                                                 |
| ------------------------------- | --------------------------------------------------------- |
| `viewport`                      | Dimensoes da janela, device pixel ratio, posicao scroll   |
| `implicit_wait_ms`              | Tempo sem mutacoes no DOM antes da acao do usuario        |
| `dom_mutations_since_last_step` | Contagem e lista de elementos adicionados/removidos       |
| `active_loaders`                | Spinners/loaders visiveis (16 patterns CSS detectados)    |
| `console_messages`              | Errors e warnings do console JS capturados via Runtime    |
| `auth_context`                  | Tokens JWT, cookies de sessao, CSRF tokens dos requests   |
| `focus`                         | Elemento focado antes e depois da acao                    |
| `performance`                   | Tempo de processamento da acao ate captura do screenshot  |
| `dialogs`                       | Dialogos nativos (alert/confirm/prompt) desde ultimo step |


### Outros dados por step

- `dom_snapshot` — HTML completo do document (com conteudo de iframes same-origin anotado)
- `screenshot_base64` — PNG em data URI (capturado via `chrome.tabs.captureVisibleTab`)
- `network_activity` — Todas as requests HTTP/HTTPS com headers, body, status, timing e initiator
- `tab_index` — Indice da aba no momento da acao

## Formato de exportacao (Semantic HAR)

O JSON exportado segue esta estrutura:

```json
{
  "recording_id": "uuid-v4",
  "created_at": "2026-03-28T14:30:00.000Z",
  "metadata": {
    "browser": "Chrome 130.0.6723.91",
    "os": "Macintosh; Intel Mac OS X 10_15_7",
    "extension_version": "0.1.0",
    "initial_url": "https://pje.tjsp.jus.br/1g/login.seam",
    "total_duration_ms": 45000,
    "total_steps": 12,
    "start_time_ms": 1711546200000
  },
  "steps": [ ... ],
  "annotations": [
    { "text": "Observacao do usuario", "timestamp": "ISO", "elapsed_ms": 15000 }
  ]
}
```

## Historico de gravacoes

A extensao mantem ate 10 gravacoes anteriores no `chrome.storage.local`:

- Um indice leve (`flow_recorder_history_index`) com metadados de cada gravacao
- Cada gravacao completa salva em chave individual (`flow_recorder_rec_<id>`)
- Ao iniciar nova gravacao, a anterior e arquivada automaticamente
- O popup mostra o historico na tela inicial com opcoes de ver, exportar e excluir

## Notas tecnicas

- **Vanilla JS** — sem bundler, sem framework, sem dependencias externas
- **ES modules** no Service Worker (`"type": "module"` no manifest)
- **Content scripts** compartilham escopo via `window.__FlowRecorder` (carregados em ordem pelo manifest)
- **Debounce** de input (500ms) e scroll (300ms) para evitar steps excessivos
- **Salvamento incremental** — cada step e persistido imediatamente em `chrome.storage.local`
- **Resiliencia** — se o Service Worker reiniciar, o estado e restaurado dos metadados persistidos
- Todos os logs usam prefixo `[FlowRecorder]` para facilitar debug
- Todos os handlers usam `try/catch` para nunca quebrar o site do tribunal

## Limitacoes conhecidas

- Screenshots falham durante transicoes de navegacao (campo fica null)
- Iframes cross-origin nao tem DOM capturado (limitacao do browser)
- O `chrome.debugger` mostra barra de aviso "Extensions are debugging this browser"
- JSONs podem ficar grandes (screenshots em base64 ocupam 500KB-2MB cada)

