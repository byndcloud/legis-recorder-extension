/**
 * Módulo de captura de requisições de rede via chrome.debugger API.
 * Utiliza o Chrome DevTools Protocol para interceptar todas as requisições
 * HTTP/HTTPS, incluindo headers completos e response bodies.
 *
 * Este módulo é um ES Module usado exclusivamente pelo Service Worker (background.js).
 */

// Tamanho máximo de response body armazenado (500KB)
const MAX_BODY_SIZE = 500 * 1024;

export class NetworkCapture {
  constructor() {
    /** @type {number|null} ID da tab sendo monitorada */
    this.tabId = null;

    /** @type {boolean} Indica se o debugger está attached */
    this.attached = false;

    /** @type {Array} Buffer de requests completados entre steps */
    this.requestBuffer = [];

    /** @type {Map} Requests em andamento (requestId -> dados parciais) */
    this._pendingRequests = new Map();

    /** @type {Function} Handler de eventos bound para poder remover depois */
    this._onEvent = this._handleEvent.bind(this);

    /** @type {Array} #6 — Buffer de mensagens de console (errors/warnings) */
    this.consoleBuffer = [];
  }

  // =========================================================================
  // Controle do Debugger
  // =========================================================================

  /**
   * Attach o debugger na tab e habilita interceptação de rede.
   * @param {number} tabId - ID da tab a monitorar
   */
  async attach(tabId) {
    if (this.attached) {
      throw new Error(`NetworkCapture já attached à tab ${this.tabId}`);
    }
    this.tabId = tabId;

    try {
      await chrome.debugger.attach({ tabId }, '1.3');
      this.attached = true;

      // Registrar listener de eventos do debugger
      chrome.debugger.onEvent.addListener(this._onEvent);

      // Habilitar domínios do DevTools Protocol
      await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {
        maxTotalBufferSize: 10000000,   // 10MB buffer total
        maxResourceBufferSize: 5000000  // 5MB por recurso
      });

      await chrome.debugger.sendCommand({ tabId }, 'Page.enable');

      // #6 — Habilitar captura de mensagens de console
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');

      console.log('[FlowRecorder] Debugger attached na tab', tabId);
    } catch (e) {
      console.error('[FlowRecorder] Erro ao attach debugger:', e);
      this.attached = false;
      throw e;
    }
  }

  /**
   * Captura screenshot da tab attached via CDP Page.captureScreenshot.
   * Diferente de chrome.tabs.captureVisibleTab, funciona mesmo se a tab
   * não estiver visível (usuário trocou de aba).
   * @returns {Promise<string|null>} data URL base64 PNG ou null se falhar
   */
  async captureScreenshot() {
    if (!this.attached || !this.tabId) return null;
    try {
      const result = await chrome.debugger.sendCommand(
        { tabId: this.tabId },
        'Page.captureScreenshot',
        { format: 'jpeg', quality: 80 }
      );
      if (result && result.data) {
        return 'data:image/jpeg;base64,' + result.data;
      }
    } catch (e) {
      console.warn('[FlowRecorder] CDP captureScreenshot falhou:', e.message);
    }
    return null;
  }

  /**
   * Detach o debugger da tab.
   */
  async detach() {
    if (!this.attached || !this.tabId) return;

    try {
      chrome.debugger.onEvent.removeListener(this._onEvent);
      await chrome.debugger.detach({ tabId: this.tabId });
      console.log('[FlowRecorder] Debugger detached da tab', this.tabId);
    } catch (e) {
      // Pode falhar se a tab já foi fechada
      console.warn('[FlowRecorder] Erro ao detach debugger:', e.message);
    }

    this.attached = false;
    this._pendingRequests.clear();
  }

  // =========================================================================
  // Buffer de Requests
  // =========================================================================

  /**
   * Retorna todos os requests acumulados desde o último flush e limpa o buffer.
   * Chamado pelo background.js a cada step para associar requests ao step.
   * @returns {Array} Array de NetworkRequest objects
   */
  flushBuffer() {
    const requests = [...this.requestBuffer];
    this.requestBuffer = [];
    return requests;
  }

  /**
   * #6 — Retorna e limpa o buffer de mensagens de console.
   */
  flushConsoleBuffer() {
    const messages = [...this.consoleBuffer];
    this.consoleBuffer = [];
    return messages;
  }

  // =========================================================================
  // Handlers de Eventos do DevTools Protocol
  // =========================================================================

  /**
   * Router principal de eventos do debugger.
   */
  _handleEvent(source, method, params) {
    // Ignorar eventos de outras tabs
    if (source.tabId !== this.tabId) return;

    try {
      switch (method) {
        case 'Network.requestWillBeSent':
          this._onRequestWillBeSent(params);
          break;
        case 'Network.responseReceived':
          this._onResponseReceived(params);
          break;
        // #6 — Console messages
        case 'Runtime.consoleAPICalled':
          this._onConsoleCalled(params);
          break;
        case 'Runtime.exceptionThrown':
          this._onExceptionThrown(params);
          break;
        case 'Network.loadingFinished':
          this._onLoadingFinished(params);
          break;
        case 'Network.loadingFailed':
          this._onLoadingFailed(params);
          break;
      }
    } catch (e) {
      console.error('[FlowRecorder] Erro ao processar evento de network:', e);
    }
  }

  /**
   * Request iniciado — registrar metadados do request.
   */
  _onRequestWillBeSent(params) {
    const { requestId, request, timestamp, type, initiator } = params;

    this._pendingRequests.set(requestId, {
      request_id: requestId,
      type: this._normalizeResourceType(type),
      method: request.method,
      url: request.url,
      request_headers: request.headers || {},
      request_body: request.postData || null,
      response_status: null,
      response_status_text: null,
      response_headers: {},
      response_body: null,
      response_body_truncated: false,
      timing: {
        started_at: new Date(timestamp * 1000).toISOString(),
        duration_ms: null,
        ttfb_ms: null
      },
      initiator: {
        type: initiator?.type || 'other',
        url: initiator?.url || null,
        line_number: initiator?.lineNumber || null
      }
    });
  }

  /**
   * Response recebida — registrar status e headers da resposta.
   */
  _onResponseReceived(params) {
    const { requestId, response } = params;
    const entry = this._pendingRequests.get(requestId);
    if (!entry) return;

    entry.response_status = response.status;
    entry.response_status_text = response.statusText;
    entry.response_headers = response.headers || {};

    // Calcular TTFB (Time To First Byte) quando disponível
    if (response.timing && response.timing.receiveHeadersEnd) {
      entry.timing.ttfb_ms = Math.round(response.timing.receiveHeadersEnd);
    }
  }

  /**
   * Loading completo — buscar response body e mover para o buffer.
   */
  async _onLoadingFinished(params) {
    const { requestId, timestamp } = params;
    const entry = this._pendingRequests.get(requestId);
    if (!entry) return;

    // Calcular duração total
    const startTime = new Date(entry.timing.started_at).getTime();
    entry.timing.duration_ms = Math.round(timestamp * 1000 - startTime);

    // Buscar response body via debugger
    try {
      const response = await chrome.debugger.sendCommand(
        { tabId: this.tabId },
        'Network.getResponseBody',
        { requestId }
      );

      if (response) {
        if (response.base64Encoded) {
          // Response binária — registrar apenas metadados
          this._handleBinaryBody(response.body, entry);
        } else {
          // Response textual — armazenar com truncamento se necessário
          if (response.body && response.body.length > MAX_BODY_SIZE) {
            entry.response_body = response.body.substring(0, MAX_BODY_SIZE);
            entry.response_body_truncated = true;
          } else {
            entry.response_body = response.body || null;
          }
        }
      }
    } catch (e) {
      // Alguns requests não têm body acessível (ex: redirects, cancelled)
      entry.response_body = null;
    }

    this._pendingRequests.delete(requestId);
    this.requestBuffer.push(entry);
  }

  /**
   * Loading falhou — registrar erro e mover para o buffer.
   */
  _onLoadingFailed(params) {
    const { requestId, errorText, timestamp } = params;
    const entry = this._pendingRequests.get(requestId);
    if (!entry) return;

    entry.response_status = 0;
    entry.response_status_text = errorText || 'Failed';

    const startTime = new Date(entry.timing.started_at).getTime();
    entry.timing.duration_ms = Math.round(timestamp * 1000 - startTime);

    this._pendingRequests.delete(requestId);
    this.requestBuffer.push(entry);
  }

  // =========================================================================
  // #6 — Console Messages
  // =========================================================================

  /**
   * Captura chamadas a console.error, console.warn, console.log via Runtime API.
   */
  _onConsoleCalled(params) {
    const { type, args, timestamp } = params;
    // Capturar apenas errors e warnings (logs são muito verbosos)
    if (type !== 'error' && type !== 'warning' && type !== 'warn') return;

    const message = (args || []).map(arg => {
      if (arg.value !== undefined) return String(arg.value);
      if (arg.description) return arg.description;
      if (arg.type === 'object') return '[Object]';
      return String(arg.type || '');
    }).join(' ');

    this.consoleBuffer.push({
      level: type === 'warning' ? 'warn' : type,
      message: message.substring(0, 500),
      timestamp: new Date(timestamp).toISOString()
    });
  }

  /**
   * Captura exceções não tratadas via Runtime API.
   */
  _onExceptionThrown(params) {
    const { exceptionDetails, timestamp } = params;
    const text = exceptionDetails?.exception?.description
      || exceptionDetails?.text
      || 'Unknown exception';

    this.consoleBuffer.push({
      level: 'exception',
      message: text.substring(0, 500),
      timestamp: new Date(timestamp).toISOString(),
      line: exceptionDetails?.lineNumber || null,
      url: exceptionDetails?.url || null
    });
  }

  // =========================================================================
  // Utilitários
  // =========================================================================

  /**
   * Trata response body binária — registra apenas tipo e tamanho.
   */
  _handleBinaryBody(base64Body, entry) {
    const contentType =
      entry.response_headers['Content-Type'] ||
      entry.response_headers['content-type'] ||
      'application/octet-stream';
    const sizeKB = Math.round((base64Body.length * 3 / 4) / 1024);
    entry.response_body = `[binary: ${contentType}, ${sizeKB}KB]`;
  }

  /**
   * Normaliza o tipo de recurso para o formato do Semantic HAR.
   */
  _normalizeResourceType(type) {
    const typeMap = {
      'XHR': 'xhr',
      'Fetch': 'fetch',
      'Document': 'document',
      'Stylesheet': 'stylesheet',
      'Script': 'script',
      'Image': 'image',
      'Font': 'font',
      'WebSocket': 'websocket',
      'Media': 'media',
      'Manifest': 'other',
      'Other': 'other'
    };
    return typeMap[type] || (type ? type.toLowerCase() : 'other');
  }
}
