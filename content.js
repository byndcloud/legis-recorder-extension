/**
 * Content Script principal do Legis - Gravador de Fluxos.
 * Ponto de entrada injetado em todas as páginas e iframes.
 * Coordena a captura de eventos, enriquecimento e comunicação com o Service Worker.
 *
 * Depende de: SelectorGenerator, DOMSnapshot, EventCapture, Enrichment
 * (carregados antes deste arquivo via manifest.json content_scripts)
 */
(function () {
  'use strict';

  // Evitar inicialização duplicada (pode acontecer com hot-reload)
  if (window.__FlowRecorderInitialized) return;
  window.__FlowRecorderInitialized = true;

  const { EventCapture, Enrichment } = window.__FlowRecorder;

  // =========================================================================
  // Estado local
  // =========================================================================

  let isRecording = false;
  let capture = null;
  let enrichment = null;

  // Identificação do frame (principal ou iframe)
  const isMainFrame = window === window.top;
  const frameId = isMainFrame ? 'main' : window.location.href;

  // =========================================================================
  // Callback de ação capturada
  // =========================================================================

  /**
   * Chamado pelo EventCapture a cada ação do usuário.
   * Coleta dados de enriquecimento e envia tudo para o Service Worker.
   *
   * @param {Object} action - Ação semântica capturada
   * @param {string} domSnapshot - HTML do document
   * @param {Object} extras - Dados extras do EventCapture (viewport, focus_info)
   */
  function onActionCaptured(action, domSnapshot, extras) {
    try {
      // Coletar dados de enriquecimento do módulo Enrichment
      const enrichmentData = enrichment ? {
        // #2 — Tempo desde última mutação no DOM (implicit wait)
        implicit_wait_ms: enrichment.getImplicitWaitMs(),
        // #4 — Resumo de mutações no DOM desde o último step
        dom_mutations_since_last_step: enrichment.flushMutationSummary(),
        // #10 — Loaders/spinners ativos no momento da ação
        active_loaders: enrichment.detectActiveLoaders(),
        // #13 — Diálogos que aconteceram desde o último step
        dialogs: enrichment.flushDialogBuffer()
      } : {};

      chrome.runtime.sendMessage({
        type: 'ACTION_CAPTURED',
        payload: {
          action,
          dom_snapshot: domSnapshot,
          url: window.location.href,
          page_title: document.title,
          frame_id: frameId,
          timestamp: new Date().toISOString(),
          // Dados extras do EventCapture (#7 viewport, #11 focus)
          viewport: extras?.viewport || null,
          focus_info: extras?.focus_info || null,
          // Dados do módulo Enrichment (#2, #4, #10, #13)
          enrichment: enrichmentData
        }
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[FlowRecorder] Erro ao enviar ação:', chrome.runtime.lastError.message);
        }
      });
    } catch (e) {
      console.error('[FlowRecorder] Erro ao enviar ação para background:', e);
    }
  }

  /**
   * Chamado pelo Enrichment quando um diálogo nativo é interceptado.
   * Emite como um step separado (dialog_interaction).
   */
  function onDialogCaptured(dialogAction) {
    onActionCaptured(dialogAction, '', {});
  }

  // =========================================================================
  // Inicialização dos módulos
  // =========================================================================

  capture = new EventCapture(onActionCaptured);
  enrichment = new Enrichment();

  // =========================================================================
  // Controle de gravação (start/stop/pause/resume)
  // =========================================================================

  function startCapture() {
    capture.start();
    enrichment.start(onDialogCaptured);
  }

  function stopCapture() {
    capture.stop();
    enrichment.stop();
  }

  // =========================================================================
  // Listener de mensagens do Service Worker
  // =========================================================================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
      switch (message.type) {
        case 'START_RECORDING':
          if (!isRecording) {
            isRecording = true;
            startCapture();
            console.log('[FlowRecorder] Gravação iniciada neste frame');
          }
          sendResponse({ ok: true });
          break;

        case 'STOP_RECORDING':
          if (isRecording) {
            isRecording = false;
            stopCapture();
            console.log('[FlowRecorder] Gravação parada neste frame');
          }
          sendResponse({ ok: true });
          break;

        case 'PAUSE_RECORDING':
          if (isRecording) {
            stopCapture();
            console.log('[FlowRecorder] Gravação pausada neste frame');
          }
          sendResponse({ ok: true });
          break;

        case 'RESUME_RECORDING':
          if (isRecording) {
            startCapture();
            console.log('[FlowRecorder] Gravação retomada neste frame');
          }
          sendResponse({ ok: true });
          break;

        case 'GET_STATUS':
          sendResponse({ recording: isRecording, frameId });
          break;

        default:
          sendResponse({ ok: true });
      }
    } catch (e) {
      console.error('[FlowRecorder] Erro ao processar mensagem:', e);
      sendResponse({ ok: false, error: e.message });
    }

    return true;
  });

  // =========================================================================
  // Verificar se já existe gravação ativa (após navegação de página)
  // =========================================================================

  try {
    chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATE' }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response && response.state === 'recording') {
        isRecording = true;
        startCapture();
        console.log('[FlowRecorder] Gravação ativa detectada — captura iniciada automaticamente');
      }
    });
  } catch (e) {
    // Contexto da extensão pode ser inválido (ex: durante atualização)
  }

  // =========================================================================
  // Log de inicialização
  // =========================================================================

  console.log(
    `[FlowRecorder] Content script carregado (frame: ${isMainFrame ? 'principal' : 'iframe'})`
  );
})();
