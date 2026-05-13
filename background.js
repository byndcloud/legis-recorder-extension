/**
 * Service Worker (Background Script) do Flow Recorder.
 * Coordena toda a gravação: gerencia estado, captura screenshots,
 * intercepta network requests, e monta os steps completos do Semantic HAR.
 */

import { NetworkCapture } from './lib/network-capture.js';
import { RecordingStorage } from './lib/storage.js';

// =========================================================================
// Instâncias dos módulos
// =========================================================================

const networkCapture = new NetworkCapture();
const storage = new RecordingStorage();

// =========================================================================
// Estado global da gravação
// =========================================================================

/** @type {'idle'|'starting'|'recording'|'pausing'|'paused'|'resuming'|'stopping'} */
let state = 'idle';

const SESSION_SNAPSHOT_KEY = 'flow_recorder_snapshot';
let _snapshotPending = false;

/** @type {number|null} ID da tab principal (onde gravação iniciou) */
let recordingTabId = null;

/** @type {Set<number>} IDs de TODAS as tabs sendo gravadas (principal + abas abertas durante a gravação) */
const recordingTabIds = new Set();

/** @type {Map<number, {index: number, url: string, title: string}>} Cache de info das tabs gravadas pra emitir steps mesmo após onRemoved */
const tabInfoCache = new Map();

/** @type {number|null} Timestamp de início da gravação */
let recordingStartTime = null;

/** @type {number|null} Timestamp do último step */
let lastStepTime = null;

/** @type {number} Contador de steps gravados */
let stepCount = 0;

/** @type {string|null} URL anterior conhecida (para navigation steps) */
let lastKnownUrl = null;

// =========================================================================
// Utilitários
// =========================================================================

/**
 * Grava snapshot leve em chrome.storage.session pro popup hidratar rápido
 * sem precisar acordar o Service Worker.
 */
async function writeSessionCache() {
  try {
    const meta = await storage.getMetaOnly();
    await chrome.storage.session.set({
      [SESSION_SNAPSHOT_KEY]: {
        state,
        stepCount,
        startTime: recordingStartTime,
        hasRecording: !!(meta && meta.metadata && (meta.metadata.total_steps || 0) > 0),
        recordingMeta: meta ? meta.metadata : null,
        updatedAt: Date.now()
      }
    });
  } catch (e) {
    // session storage indisponível em contextos raros — ignorar
  }
}

/**
 * Throttle pra evitar gravar snapshot a cada step durante gravações rápidas.
 * Agenda 1 write futuro se ainda não houver agendado.
 */
function scheduleSnapshotWrite() {
  if (_snapshotPending) return;
  _snapshotPending = true;
  setTimeout(() => {
    _snapshotPending = false;
    writeSessionCache();
  }, 500);
}

/**
 * Gera um UUID v4 simples.
 */
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

/**
 * Detecta informações do navegador via User-Agent.
 */
function getBrowserInfo() {
  const ua = navigator.userAgent;
  const chromeMatch = ua.match(/Chrome\/(\d+\.\d+\.\d+\.\d+)/);
  const osMatch = ua.match(/\(([^)]+)\)/);
  return {
    browser: chromeMatch ? `Chrome ${chromeMatch[1]}` : 'Chrome',
    os: osMatch ? osMatch[1] : 'Unknown'
  };
}

// =========================================================================
// #3 — Extração de contexto de autenticação
// =========================================================================

/**
 * Analisa os network requests para extrair informações de autenticação:
 * tokens JWT, cookies de sessão, CSRF tokens, etc.
 */
function _extractAuthContext(networkActivity) {
  const context = {
    auth_headers: [],
    session_cookies: [],
    csrf_tokens: []
  };

  try {
    const seenHeaders = new Set();
    const seenCookies = new Set();

    for (const req of networkActivity) {
      const headers = req.request_headers || {};

      // Detectar headers de autenticação
      for (const [key, value] of Object.entries(headers)) {
        const lk = key.toLowerCase();
        if ((lk === 'authorization' || lk === 'x-auth-token' || lk === 'x-api-key') && !seenHeaders.has(lk)) {
          seenHeaders.add(lk);
          // Truncar tokens longos mas manter o tipo (Bearer, Basic, etc.)
          const truncated = String(value).length > 50
            ? String(value).substring(0, 50) + '...'
            : String(value);
          context.auth_headers.push({ header: key, value_preview: truncated });
        }

        // Detectar CSRF tokens
        if ((lk === 'x-csrf-token' || lk === 'x-xsrf-token' || lk === 'csrf-token') && !seenHeaders.has(lk)) {
          seenHeaders.add(lk);
          context.csrf_tokens.push({ header: key, value: String(value).substring(0, 100) });
        }

        // Extrair cookies de sessão
        if (lk === 'cookie' && !seenCookies.has('req')) {
          seenCookies.add('req');
          const cookies = String(value).split(';').map(c => c.trim());
          for (const cookie of cookies) {
            const [name] = cookie.split('=');
            const ln = (name || '').toLowerCase().trim();
            if (ln.includes('session') || ln.includes('jsessionid') || ln.includes('sid') ||
                ln.includes('token') || ln.includes('auth') || ln === 'connect.sid') {
              context.session_cookies.push(cookie.substring(0, 100));
            }
          }
        }
      }
    }
  } catch (e) {
    // Silenciar erros na extração
  }

  // Retornar null se nada encontrado (economiza espaço no JSON)
  if (context.auth_headers.length === 0 && context.session_cookies.length === 0 && context.csrf_tokens.length === 0) {
    return null;
  }
  return context;
}

// =========================================================================
// Controle da Gravação
// =========================================================================

/**
 * Inicia uma nova gravação na tab ativa.
 */
async function startRecording(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const browserInfo = getBrowserInfo();

    // Arquivar gravação anterior no histórico antes de limpar
    await storage.archiveCurrentRecording();
    await storage.clearRecording();

    recordingTabId = tabId;
    recordingTabIds.clear();
    recordingTabIds.add(tabId);
    tabInfoCache.clear();
    tabInfoCache.set(tabId, { index: tab.index, url: tab.url, title: tab.title || '' });
    recordingStartTime = Date.now();
    lastStepTime = recordingStartTime;
    stepCount = 0;
    lastKnownUrl = tab.url;

    // Criar estrutura inicial do recording
    const recording = {
      recording_id: generateUUID(),
      created_at: new Date().toISOString(),
      metadata: {
        browser: browserInfo.browser,
        os: browserInfo.os,
        extension_version: '0.1.0',
        initial_url: tab.url,
        total_duration_ms: 0,
        total_steps: 0,
        start_time_ms: recordingStartTime
      },
      steps: [],
      annotations: []
    };

    await storage.initRecording(recording);

    // Attach debugger para captura de network
    try {
      await networkCapture.attach(tabId);
    } catch (e) {
      console.warn('[FlowRecorder] Network capture indisponível:', e.message);
      // Continuar sem network capture — ainda é útil
    }

    // Atualizar estado
    state = 'recording';
    await storage.saveState(state);

    // Notificar content scripts para iniciar captura
    await notifyContentScripts(tabId, { type: 'START_RECORDING' });

    // Atualizar badge visual
    updateBadge();
    await writeSessionCache();

    console.log('[FlowRecorder] Gravação iniciada na tab', tabId, '-', tab.url);
    return { ok: true };
  } catch (e) {
    console.error('[FlowRecorder] Erro ao iniciar gravação:', e);
    state = 'idle';
    await storage.saveState('idle');
    await writeSessionCache();
    return { ok: false, error: e.message };
  }
}

/**
 * Para a gravação atual e finaliza o recording.
 */
async function stopRecording() {
  try {
    if (recordingTabIds.size > 0) {
      // Parar content scripts em todas tabs gravadas
      await notifyAllRecordingTabs({ type: 'STOP_RECORDING' });
    }
    if (recordingTabId) {
      // Detach debugger da tab principal
      await networkCapture.detach();
    }

    // Atualizar duração total
    if (recordingStartTime) {
      const duration = Date.now() - recordingStartTime;
      await storage.updateMetadata({ total_duration_ms: duration });
    }

    state = 'idle';
    await storage.saveState(state);
    recordingTabId = null;
    recordingTabIds.clear();
    tabInfoCache.clear();
    recordingStartTime = null;
    lastStepTime = null;
    lastKnownUrl = null;

    updateBadge();
    await writeSessionCache();

    console.log('[FlowRecorder] Gravação parada. Total de steps:', stepCount);
    return { ok: true };
  } catch (e) {
    console.error('[FlowRecorder] Erro ao parar gravação:', e);
    state = 'idle';
    await storage.saveState('idle');
    await writeSessionCache();
    return { ok: false, error: e.message };
  }
}

/**
 * Pausa a gravação (mantém o debugger attached).
 */
async function pauseRecording() {
  try {
    if (recordingTabIds.size > 0) {
      await notifyAllRecordingTabs({ type: 'PAUSE_RECORDING' });
    }

    state = 'paused';
    await storage.saveState(state);
    updateBadge();
    await writeSessionCache();

    console.log('[FlowRecorder] Gravação pausada');
    return { ok: true };
  } catch (e) {
    console.error('[FlowRecorder] Erro ao pausar gravação:', e);
    state = 'recording'; // reverter lock 'pausing'
    await writeSessionCache();
    return { ok: false, error: e.message };
  }
}

/**
 * Retoma a gravação após pausa.
 */
async function resumeRecording() {
  try {
    if (recordingTabIds.size > 0) {
      await notifyAllRecordingTabs({ type: 'RESUME_RECORDING' });
    }

    state = 'recording';
    await storage.saveState(state);
    updateBadge();
    await writeSessionCache();

    console.log('[FlowRecorder] Gravação retomada');
    return { ok: true };
  } catch (e) {
    console.error('[FlowRecorder] Erro ao retomar gravação:', e);
    state = 'paused'; // reverter lock 'resuming'
    await writeSessionCache();
    return { ok: false, error: e.message };
  }
}

// =========================================================================
// Processamento de Ações (montagem de Steps)
// =========================================================================

/**
 * Processa uma ação capturada e monta o step completo.
 * Captura screenshot e coleta network requests pendentes.
 * @param {Object} payload - dados da ação
 * @param {number|null} sourceTabId - tab que originou a ação (null = sintético, ex: tab lifecycle)
 */
async function processAction(payload, sourceTabId = null) {
  if (state !== 'recording') return;

  const now = Date.now();

  try {
    // 1. Capturar screenshot da tab que originou a ação.
    // Se a tab origem é a principal e debugger está attached, usa CDP
    // (funciona mesmo se a tab não está visível). Caso contrário, fallback
    // pra captureVisibleTab (pega a tab visível da window — geralmente é
    // a mesma da ação, já que o usuário acabou de interagir com ela).
    let screenshotBase64 = null;
    try {
      if (sourceTabId === recordingTabId && networkCapture.attached) {
        screenshotBase64 = await networkCapture.captureScreenshot();
      }
      if (!screenshotBase64) {
        const winId = sourceTabId
          ? (await chrome.tabs.get(sourceTabId).catch(() => null))?.windowId
          : undefined;
        screenshotBase64 = await chrome.tabs.captureVisibleTab(
          winId ?? null,
          { format: 'jpeg', quality: 80 }
        );
      }
    } catch (e) {
      console.warn('[FlowRecorder] Screenshot indisponível:', e.message);
    }

    // 2. Coletar network requests do buffer
    const networkActivity = networkCapture.flushBuffer();

    // 3. Capturar índice da aba que originou a ação
    let tabIndex = null;
    const tabIdForIndex = sourceTabId ?? recordingTabId;
    try {
      if (tabIdForIndex) {
        const tab = await chrome.tabs.get(tabIdForIndex);
        tabIndex = tab.index;
      }
    } catch (e) {
      // Tab pode ter sido fechada ou não estar acessível —
      // tentar do cache (caso de tab_closed que já saiu do navegador)
      const cached = tabIdForIndex ? tabInfoCache.get(tabIdForIndex) : null;
      if (cached) tabIndex = cached.index;
    }

    // 4. #6 — Coletar mensagens de console (errors/warnings)
    const consoleMessages = networkCapture.flushConsoleBuffer();

    // 5. #3 — Extrair contexto de autenticação dos requests
    const authContext = _extractAuthContext(networkActivity);

    // 6. #8 — Performance timing (tempo entre recebimento da ação e captura do screenshot)
    const actionProcessingMs = Date.now() - now;

    // 7. Montar step completo com todos os dados de enriquecimento
    const step = {
      step_index: stepCount,
      timestamp: payload.timestamp || new Date().toISOString(),
      elapsed_ms_from_start: now - recordingStartTime,
      elapsed_ms_from_previous_step: now - (lastStepTime || now),
      url: payload.url || lastKnownUrl || '',
      page_title: payload.page_title || '',
      tab_index: tabIndex,
      action: payload.action,
      dom_snapshot: payload.dom_snapshot || '',
      screenshot_base64: screenshotBase64,
      network_activity: networkActivity,
      // Dados de enriquecimento coletados pelo content script e background
      context: {
        // #7 — Viewport no momento da ação
        viewport: payload.viewport || null,
        // #11 — Estado de foco antes/depois da ação
        focus: payload.focus_info || null,
        // #2 — Tempo que o DOM ficou parado antes da ação (implicit wait)
        implicit_wait_ms: payload.enrichment?.implicit_wait_ms ?? null,
        // #4 — Mudanças no DOM desde o step anterior
        dom_mutations_since_last_step: payload.enrichment?.dom_mutations_since_last_step || null,
        // #10 — Loaders/spinners ativos no momento da ação
        active_loaders: payload.enrichment?.active_loaders || [],
        // #13 — Diálogos nativos que ocorreram desde o step anterior
        dialogs: payload.enrichment?.dialogs || [],
        // #6 — Mensagens de console (errors/warnings) desde o step anterior
        console_messages: consoleMessages,
        // #3 — Contexto de autenticação detectado nos requests
        auth_context: authContext,
        // #8 — Tempo de processamento da ação (action → screenshot)
        performance: { action_to_screenshot_ms: actionProcessingMs }
      }
    };

    // 8. Salvar incrementalmente no storage
    await storage.addStep(step);

    // 9. Atualizar contadores
    stepCount++;
    lastStepTime = now;

    // Atualizar URL conhecida
    if (payload.url) {
      lastKnownUrl = payload.url;
    }

    // 10. Atualizar badge
    updateBadge();
    scheduleSnapshotWrite();

    console.log(`[FlowRecorder] Step ${step.step_index} registrado: ${payload.action.type}`);
  } catch (e) {
    console.error('[FlowRecorder] Erro ao processar ação:', e);
  }
}

// =========================================================================
// Comunicação com Content Scripts
// =========================================================================

/**
 * Envia mensagem para todos os frames da tab especificada.
 */
async function notifyContentScripts(tabId, message) {
  try {
    // Enviar para o frame principal
    await chrome.tabs.sendMessage(tabId, message).catch(() => {});

    // Enviar para todos os sub-frames (iframes)
    const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
    if (frames) {
      for (const frame of frames) {
        if (frame.frameId === 0) continue; // Já enviamos para o principal
        try {
          await chrome.tabs.sendMessage(tabId, message, { frameId: frame.frameId });
        } catch (e) {
          // Frame pode não ter o content script ainda
        }
      }
    }
  } catch (e) {
    console.warn('[FlowRecorder] Erro ao notificar content scripts:', e.message);
  }
}

/**
 * Envia mensagem pra TODAS as tabs gravadas (principal + abas abertas durante).
 */
async function notifyAllRecordingTabs(message) {
  const ids = [...recordingTabIds];
  await Promise.all(ids.map(id => notifyContentScripts(id, message)));
}

// =========================================================================
// Badge da Extensão
// =========================================================================

/**
 * Atualiza o badge (ícone pequeno) da extensão conforme o estado.
 */
function updateBadge() {
  try {
    if (state === 'recording') {
      chrome.action.setBadgeText({ text: String(stepCount) });
      chrome.action.setBadgeBackgroundColor({ color: '#2A4DDD' });
    } else if (state === 'paused') {
      chrome.action.setBadgeText({ text: '||' });
      chrome.action.setBadgeBackgroundColor({ color: '#f39c12' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  } catch (e) {
    // Badge pode não estar disponível em todos os contextos
  }
}

// =========================================================================
// Message Handler Principal
// =========================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    switch (message.type) {
      // --- Comandos do Popup ---

      case 'START_RECORDING': {
        if (state !== 'idle') {
          sendResponse({ ok: false, error: `Já existe ação em andamento (${state})` });
          return false;
        }
        state = 'starting'; // lock síncrono — bloqueia segunda entrada
        chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => {
          if (tabs[0]) {
            startRecording(tabs[0].id).then(sendResponse);
          } else {
            state = 'idle';
            writeSessionCache();
            sendResponse({ ok: false, error: 'Nenhuma tab ativa encontrada' });
          }
        });
        return true; // Resposta assíncrona
      }

      case 'STOP_RECORDING': {
        if (state !== 'recording' && state !== 'paused') {
          sendResponse({ ok: false, error: `Não é possível parar no estado ${state}` });
          return false;
        }
        state = 'stopping';
        stopRecording().then(sendResponse);
        return true;
      }

      case 'PAUSE_RECORDING': {
        if (state !== 'recording') {
          sendResponse({ ok: false, error: `Não é possível pausar no estado ${state}` });
          return false;
        }
        state = 'pausing';
        pauseRecording().then(sendResponse);
        return true;
      }

      case 'RESUME_RECORDING': {
        if (state !== 'paused') {
          sendResponse({ ok: false, error: `Não é possível retomar no estado ${state}` });
          return false;
        }
        state = 'resuming';
        resumeRecording().then(sendResponse);
        return true;
      }

      case 'DISMISS_CURRENT_RECORDING': {
        if (state !== 'idle') {
          sendResponse({ ok: false, error: `Não é possível descartar no estado ${state}` });
          return false;
        }
        (async () => {
          try {
            await storage.archiveCurrentRecording();
            await storage.clearRecording();
            stepCount = 0;
            await writeSessionCache();
            sendResponse({ ok: true });
          } catch (e) {
            console.error('[FlowRecorder] Erro ao descartar recording:', e);
            sendResponse({ ok: false, error: e.message });
          }
        })();
        return true;
      }

      case 'GET_RECORDING_STATE': {
        // Verificar se existe recording salvo (para estado pós-gravação).
        // Usa getMetaOnly — não carrega steps (pode ser MB de screenshots).
        storage.getMetaOnly().then(meta => {
          let effectiveStartTime = recordingStartTime;
          if (!effectiveStartTime && meta && meta.metadata) {
            effectiveStartTime = meta.metadata.start_time_ms ||
              (meta.created_at ? new Date(meta.created_at).getTime() : null);
          }
          sendResponse({
            state,
            stepCount,
            tabId: recordingTabId,
            startTime: effectiveStartTime,
            hasRecording: !!(meta && meta.metadata && (meta.metadata.total_steps || 0) > 0),
            recordingMeta: meta ? meta.metadata : null
          });
        });
        return true; // Resposta assíncrona
      }

      case 'GET_RECORDING':
        storage.getRecording().then(sendResponse);
        return true;

      case 'EXPORT_RECORDING':
        storage.getRecording().then(recording => {
          sendResponse({ recording });
        });
        return true;

      // --- Ações do Content Script ---

      case 'ACTION_CAPTURED': {
        // Aceita ações de qualquer tab pertencente ao set de tabs gravadas
        // (principal + abas abertas durante a gravação).
        if (!sender.tab || !recordingTabIds.has(sender.tab.id)) {
          sendResponse({ ok: false, error: 'tab não está sendo gravada' });
          return false;
        }
        processAction(message.payload, sender.tab.id).then(() => sendResponse({ ok: true }));
        return true;
      }

      case 'AM_I_RECORDING_TAB': {
        // Content script pergunta se a própria tab está sendo gravada.
        // SW resolve via sender.tab.id (fonte de verdade).
        const isRecordingTab = !!(sender.tab && recordingTabIds.has(sender.tab.id));
        sendResponse({ isRecordingTab, state });
        return false;
      }

      // --- Anotações (timestamped) ---

      case 'ADD_ANNOTATION': {
        const now = Date.now();
        const effectiveStart = recordingStartTime ||
          (message.fallbackStartTime ? message.fallbackStartTime : now);
        const elapsed = message.elapsed_ms != null
          ? message.elapsed_ms
          : Math.max(0, now - effectiveStart);
        const annotation = {
          text: message.text,
          timestamp: new Date().toISOString(),
          elapsed_ms: elapsed
        };
        storage.addAnnotation(annotation).then(() => {
          sendResponse({ ok: true });
        });
        return true;
      }

      // --- Histórico ---

      case 'GET_HISTORY':
        storage.getHistoryIndex().then(sendResponse);
        return true;

      case 'GET_RECORDING_BY_ID':
        storage.loadRecordingById(message.recordingId).then(sendResponse);
        return true;

      case 'DELETE_FROM_HISTORY':
        storage.deleteRecordingById(message.recordingId).then(() => {
          sendResponse({ ok: true });
        });
        return true;

      default:
        sendResponse({ ok: false, error: 'Tipo de mensagem desconhecido' });
    }
  } catch (e) {
    console.error('[FlowRecorder] Erro no message handler:', e);
    sendResponse({ ok: false, error: e.message });
  }
});

// =========================================================================
// Listeners de Navegação
// =========================================================================

/**
 * Detecta navegações completas na tab sendo gravada.
 * Gera steps de navigation automaticamente.
 */
chrome.webNavigation.onCommitted.addListener((details) => {
  if (state !== 'recording' || !recordingTabIds.has(details.tabId)) return;
  if (details.frameId !== 0) return; // Apenas frame principal

  // Determinar o que causou a navegação
  let trigger = 'manual_url_change';
  switch (details.transitionType) {
    case 'link': trigger = 'link_click'; break;
    case 'typed': trigger = 'manual_url_change'; break;
    case 'auto_bookmark': trigger = 'manual_url_change'; break;
    case 'auto_subframe': trigger = 'redirect'; break;
    case 'form_submit': trigger = 'form_submit'; break;
    case 'reload': trigger = 'manual_url_change'; break;
  }

  // Verificar se houve redirect
  if (details.transitionQualifiers &&
      (details.transitionQualifiers.includes('server_redirect') ||
       details.transitionQualifiers.includes('client_redirect'))) {
    trigger = 'redirect';
  }

  const previousUrl = lastKnownUrl || '';

  // Evitar duplicata se a URL não mudou
  if (details.url === previousUrl && trigger !== 'reload') return;

  const payload = {
    action: {
      type: 'navigation',
      from_url: previousUrl,
      to_url: details.url,
      trigger
    },
    dom_snapshot: '', // DOM ainda não está pronto neste ponto
    url: details.url,
    page_title: '',
    timestamp: new Date().toISOString()
  };

  if (details.tabId === recordingTabId) {
    lastKnownUrl = details.url;
  }
  processAction(payload, details.tabId);
});

/**
 * Detecta navegações via History API (SPAs).
 * Comum em sistemas de tribunais modernos.
 */
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (state !== 'recording' || !recordingTabIds.has(details.tabId)) return;
  if (details.frameId !== 0) return;

  const previousUrl = lastKnownUrl || '';

  // Evitar duplicata se a URL não mudou
  if (details.url === previousUrl) return;

  const payload = {
    action: {
      type: 'navigation',
      from_url: previousUrl,
      to_url: details.url,
      trigger: 'history_state_update'
    },
    dom_snapshot: '',
    url: details.url,
    page_title: '',
    timestamp: new Date().toISOString()
  };

  if (details.tabId === recordingTabId) {
    lastKnownUrl = details.url;
  }
  processAction(payload, details.tabId);
});

// =========================================================================
// Listeners de Lifecycle de Abas
// =========================================================================

/**
 * Constrói e processa um step sintético gerado pelo background
 * (eventos de tab que não vêm de content scripts).
 */
function emitSyntheticAction(action, sourceTabId = null, urlOverride = null) {
  const url = urlOverride
    || (sourceTabId ? tabInfoCache.get(sourceTabId)?.url : null)
    || lastKnownUrl
    || '';
  const pageTitle = sourceTabId ? tabInfoCache.get(sourceTabId)?.title || '' : '';
  processAction({
    action,
    dom_snapshot: '',
    url,
    page_title: pageTitle,
    timestamp: new Date().toISOString()
  }, sourceTabId);
}

/**
 * Nova aba aberta durante gravação.
 * Adiciona ao set de tabs gravadas e emite step `tab_opened`.
 */
chrome.tabs.onCreated.addListener((tab) => {
  if (state !== 'recording') return;
  // Tab pode ser de outra janela não relacionada — Chrome não fornece
  // forma direta de saber. Política: incluir TODA nova aba criada durante
  // a gravação, pois o usuário pode usá-la como parte do fluxo.
  if (tab.id == null) return;

  recordingTabIds.add(tab.id);
  tabInfoCache.set(tab.id, { index: tab.index, url: tab.url || tab.pendingUrl || '', title: tab.title || '' });

  emitSyntheticAction({
    type: 'tab_opened',
    new_tab_id: tab.id,
    new_tab_index: tab.index,
    opener_tab_id: tab.openerTabId ?? null,
    initial_url: tab.url || tab.pendingUrl || ''
  }, tab.id);
});

/**
 * Foco trocou pra outra aba.
 */
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (state !== 'recording') return;
  // Só registra se a tab focada está no set (caso contrário usuário foi
  // pra uma aba não relacionada — ruído, ignorar).
  if (!recordingTabIds.has(activeInfo.tabId)) return;

  let toUrl = tabInfoCache.get(activeInfo.tabId)?.url || '';
  let toIndex = tabInfoCache.get(activeInfo.tabId)?.index ?? null;
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    toUrl = tab.url || toUrl;
    toIndex = tab.index;
    tabInfoCache.set(tab.id, { index: tab.index, url: tab.url || '', title: tab.title || '' });
  } catch (_) {}

  emitSyntheticAction({
    type: 'tab_switched',
    to_tab_id: activeInfo.tabId,
    to_tab_index: toIndex,
    to_url: toUrl,
    window_id: activeInfo.windowId
  }, activeInfo.tabId);
});

/**
 * Aba fechada.
 */
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (state !== 'recording') return;
  if (!recordingTabIds.has(tabId)) return;

  const info = tabInfoCache.get(tabId);
  recordingTabIds.delete(tabId);

  emitSyntheticAction({
    type: 'tab_closed',
    closed_tab_id: tabId,
    closed_tab_index: info?.index ?? null,
    last_url: info?.url || '',
    window_closing: !!removeInfo.isWindowClosing
  }, null, info?.url || '');

  tabInfoCache.delete(tabId);
});

/**
 * Aba reordenada.
 */
chrome.tabs.onMoved.addListener((tabId, moveInfo) => {
  if (state !== 'recording') return;
  if (!recordingTabIds.has(tabId)) return;

  const info = tabInfoCache.get(tabId);
  if (info) info.index = moveInfo.toIndex;

  emitSyntheticAction({
    type: 'tab_moved',
    tab_id: tabId,
    from_index: moveInfo.fromIndex,
    to_index: moveInfo.toIndex,
    window_id: moveInfo.windowId
  }, tabId);
});

/**
 * Aba mudou de janela (detach/reattach).
 */
chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
  if (state !== 'recording') return;
  if (!recordingTabIds.has(tabId)) return;

  emitSyntheticAction({
    type: 'tab_attached',
    tab_id: tabId,
    new_window_id: attachInfo.newWindowId,
    new_position: attachInfo.newPosition
  }, tabId);
});

/**
 * Quando uma tab nova termina de carregar, garantir que o content script
 * tenha sido inicializado (auto-init via AM_I_RECORDING_TAB já cobre isso).
 * Atualiza o cache de info quando URL muda.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (state !== 'recording') return;
  if (!recordingTabIds.has(tabId)) return;

  if (changeInfo.url || changeInfo.title || changeInfo.status === 'complete') {
    tabInfoCache.set(tabId, {
      index: tab.index,
      url: tab.url || tabInfoCache.get(tabId)?.url || '',
      title: tab.title || tabInfoCache.get(tabId)?.title || ''
    });
  }
});

// =========================================================================
// Handler de Debugger Desconectado
// =========================================================================

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === recordingTabId && state === 'recording') {
    console.warn('[FlowRecorder] Debugger desconectado:', reason);
    // Continuar gravação sem network capture
    networkCapture.attached = false;
  }
});

// =========================================================================
// Restauração de Estado (resiliência contra crash do Service Worker)
// =========================================================================

async function restoreState() {
  try {
    const savedState = await storage.getState();
    if (savedState === 'recording' || savedState === 'paused') {
      // Não podemos restaurar completamente (debugger, tabId, etc.)
      // mas podemos restaurar a contagem de steps e o estado visual.
      // Usa getMetaOnly — não carrega steps inteiros do storage.
      const meta = await storage.getMetaOnly();
      if (meta) {
        stepCount = meta.metadata.total_steps || 0;
        if (meta.metadata.start_time_ms) {
          recordingStartTime = meta.metadata.start_time_ms;
        } else if (meta.created_at) {
          recordingStartTime = new Date(meta.created_at).getTime();
        }
        state = 'paused'; // Forçar pausa — o usuário precisa retomar manualmente
        await storage.saveState(state);
        console.log('[FlowRecorder] Estado restaurado após restart do Service Worker.',
          'Steps:', stepCount, '— gravação pausada automaticamente.');
      } else {
        state = 'idle';
        await storage.saveState('idle');
      }
      updateBadge();
    }
    await writeSessionCache();
  } catch (e) {
    console.error('[FlowRecorder] Erro ao restaurar estado:', e);
  }
}

restoreState();
console.log('[FlowRecorder] Service Worker inicializado');
