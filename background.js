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

/** @type {'idle'|'recording'|'paused'} */
let state = 'idle';

/** @type {number|null} ID da tab sendo gravada */
let recordingTabId = null;

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

    console.log('[FlowRecorder] Gravação iniciada na tab', tabId, '-', tab.url);
    return { ok: true };
  } catch (e) {
    console.error('[FlowRecorder] Erro ao iniciar gravação:', e);
    state = 'idle';
    await storage.saveState('idle');
    return { ok: false, error: e.message };
  }
}

/**
 * Para a gravação atual e finaliza o recording.
 */
async function stopRecording() {
  try {
    if (recordingTabId) {
      // Parar content scripts
      await notifyContentScripts(recordingTabId, { type: 'STOP_RECORDING' });
      // Detach debugger
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
    recordingStartTime = null;
    lastStepTime = null;
    lastKnownUrl = null;

    updateBadge();

    console.log('[FlowRecorder] Gravação parada. Total de steps:', stepCount);
    return { ok: true };
  } catch (e) {
    console.error('[FlowRecorder] Erro ao parar gravação:', e);
    state = 'idle';
    await storage.saveState('idle');
    return { ok: false, error: e.message };
  }
}

/**
 * Pausa a gravação (mantém o debugger attached).
 */
async function pauseRecording() {
  try {
    if (recordingTabId) {
      await notifyContentScripts(recordingTabId, { type: 'PAUSE_RECORDING' });
    }

    state = 'paused';
    await storage.saveState(state);
    updateBadge();

    console.log('[FlowRecorder] Gravação pausada');
    return { ok: true };
  } catch (e) {
    console.error('[FlowRecorder] Erro ao pausar gravação:', e);
    return { ok: false, error: e.message };
  }
}

/**
 * Retoma a gravação após pausa.
 */
async function resumeRecording() {
  try {
    if (recordingTabId) {
      await notifyContentScripts(recordingTabId, { type: 'RESUME_RECORDING' });
    }

    state = 'recording';
    await storage.saveState(state);
    updateBadge();

    console.log('[FlowRecorder] Gravação retomada');
    return { ok: true };
  } catch (e) {
    console.error('[FlowRecorder] Erro ao retomar gravação:', e);
    return { ok: false, error: e.message };
  }
}

// =========================================================================
// Processamento de Ações (montagem de Steps)
// =========================================================================

/**
 * Processa uma ação capturada pelo content script e monta o step completo.
 * Captura screenshot e coleta network requests pendentes.
 */
async function processAction(payload) {
  if (state !== 'recording') return;

  const now = Date.now();

  try {
    // 1. Capturar screenshot da tab visível
    let screenshotBase64 = null;
    try {
      screenshotBase64 = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
    } catch (e) {
      console.warn('[FlowRecorder] Screenshot indisponível:', e.message);
    }

    // 2. Coletar network requests do buffer
    const networkActivity = networkCapture.flushBuffer();

    // 3. Capturar índice da aba atual
    let tabIndex = null;
    try {
      if (recordingTabId) {
        const tab = await chrome.tabs.get(recordingTabId);
        tabIndex = tab.index;
      }
    } catch (e) {
      // Tab pode ter sido fechada ou não estar acessível
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
        chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => {
          if (tabs[0]) {
            startRecording(tabs[0].id).then(sendResponse);
          } else {
            sendResponse({ ok: false, error: 'Nenhuma tab ativa encontrada' });
          }
        });
        return true; // Resposta assíncrona
      }

      case 'STOP_RECORDING':
        stopRecording().then(sendResponse);
        return true;

      case 'PAUSE_RECORDING':
        pauseRecording().then(sendResponse);
        return true;

      case 'RESUME_RECORDING':
        resumeRecording().then(sendResponse);
        return true;

      case 'GET_RECORDING_STATE': {
        // Verificar se existe recording salvo (para estado pós-gravação)
        storage.getRecording().then(rec => {
          // Derivar startTime: preferir memória, senão metadata persistido
          let effectiveStartTime = recordingStartTime;
          if (!effectiveStartTime && rec && rec.metadata) {
            effectiveStartTime = rec.metadata.start_time_ms ||
              (rec.created_at ? new Date(rec.created_at).getTime() : null);
          }
          sendResponse({
            state,
            stepCount,
            tabId: recordingTabId,
            startTime: effectiveStartTime,
            hasRecording: !!(rec && rec.steps && rec.steps.length > 0),
            recordingMeta: rec ? rec.metadata : null
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

      case 'ACTION_CAPTURED':
        processAction(message.payload).then(() => sendResponse({ ok: true }));
        return true;

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
  if (state !== 'recording' || details.tabId !== recordingTabId) return;
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

  lastKnownUrl = details.url;
  processAction(payload);
});

/**
 * Detecta navegações via History API (SPAs).
 * Comum em sistemas de tribunais modernos.
 */
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (state !== 'recording' || details.tabId !== recordingTabId) return;
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

  lastKnownUrl = details.url;
  processAction(payload);
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
      // mas podemos restaurar a contagem de steps e o estado visual
      const recording = await storage.getRecording();
      if (recording) {
        stepCount = recording.steps.length;
        // Restaurar recordingStartTime a partir dos metadados persistidos
        if (recording.metadata.start_time_ms) {
          recordingStartTime = recording.metadata.start_time_ms;
        } else if (recording.created_at) {
          recordingStartTime = new Date(recording.created_at).getTime();
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
  } catch (e) {
    console.error('[FlowRecorder] Erro ao restaurar estado:', e);
  }
}

restoreState();
console.log('[FlowRecorder] Service Worker inicializado');
