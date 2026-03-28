/**
 * Módulo de captura de eventos do usuário.
 * Escuta interações no DOM e gera objetos de ação semântica
 * conforme a especificação do Semantic HAR.
 *
 * Depende de: SelectorGenerator, DOMSnapshot (definidos em módulos anteriores)
 */
(function () {
  'use strict';

  window.__FlowRecorder = window.__FlowRecorder || {};

  const { SelectorGenerator, DOMSnapshot } = window.__FlowRecorder;

  // =========================================================================
  // Constantes
  // =========================================================================

  const INPUT_DEBOUNCE_MS = 500;
  const SCROLL_DEBOUNCE_MS = 300;

  // Teclas consideradas "significativas" (capturadas como key_press)
  const SIGNIFICANT_KEYS = new Set(['Enter', 'Tab', 'Escape']);

  // Tags de elementos que recebem click mas são tratados por outros handlers
  const CLICK_SKIP_TYPES = new Set(['checkbox', 'radio']);
  const CLICK_SKIP_INPUT_TYPES = new Set([
    'text', 'email', 'password', 'search', 'tel', 'url', 'number', 'date',
    'datetime-local', 'month', 'week', 'time', 'color'
  ]);

  // =========================================================================
  // Classe EventCapture
  // =========================================================================

  class EventCapture {
    /**
     * @param {Function} onAction - Callback chamado com (action, domSnapshot) a cada ação
     */
    constructor(onAction) {
      this.onAction = onAction;
      this.active = false;

      // Estado do debounce de input
      this._inputDebounceTimer = null;
      this._currentInputElement = null;
      this._currentInputValue = '';
      this._lastInputWasPaste = false;

      // #12 — Conteúdo do clipboard capturado no último paste
      this._clipboardContent = null;

      // Estado do debounce de scroll
      this._scrollDebounceTimer = null;
      this._scrollStartTop = 0;

      // Estado do drag and drop
      this._dragSource = null;
      this._dragSourceInfo = null;

      // #11 — Focus tracking: elemento focado antes da ação
      this._lastFocusedElement = null;

      // Handlers com bind para poder remover depois
      this._handlers = {
        click: this._handleClick.bind(this),
        input: this._handleInput.bind(this),
        change: this._handleChange.bind(this),
        keydown: this._handleKeyDown.bind(this),
        scroll: this._handleScroll.bind(this),
        paste: this._handlePaste.bind(this),
        submit: this._handleSubmit.bind(this),
        dragstart: this._handleDragStart.bind(this),
        drop: this._handleDrop.bind(this)
      };
    }

    /**
     * Inicia a captura de eventos no documento.
     */
    start() {
      if (this.active) return;
      this.active = true;

      // Registrar todos os listeners em modo capture para interceptar antes do site
      Object.entries(this._handlers).forEach(([event, handler]) => {
        document.addEventListener(event, handler, true);
      });

      console.log('[FlowRecorder] Captura de eventos iniciada');
    }

    /**
     * Para a captura de eventos e faz flush de ações pendentes.
     */
    stop() {
      if (!this.active) return;
      this.active = false;

      // Flush de ações pendentes (input e scroll debounced)
      this._flushInputDebounce();
      this._flushScrollDebounce();

      // Remover todos os listeners
      Object.entries(this._handlers).forEach(([event, handler]) => {
        document.removeEventListener(event, handler, true);
      });

      console.log('[FlowRecorder] Captura de eventos parada');
    }

    // =======================================================================
    // Emissão de ações
    // =======================================================================

    /**
     * Emite uma ação capturada para o callback, junto com o DOM snapshot
     * e dados de enriquecimento (viewport, focus).
     */
    _emit(action) {
      if (!this.active) return;
      try {
        const domSnapshot = DOMSnapshot.capture();

        // #7 — Viewport e posição de scroll no momento da ação
        const viewport = {
          width: window.innerWidth,
          height: window.innerHeight,
          device_pixel_ratio: window.devicePixelRatio || 1,
          scroll_x: Math.round(window.scrollX || 0),
          scroll_y: Math.round(window.scrollY || 0)
        };

        // #11 — Focus tracking: quem estava focado antes e quem ficou depois
        const focusedNow = document.activeElement;
        const focusInfo = {
          before: this._lastFocusedElement ? _briefElementInfo(this._lastFocusedElement) : null,
          after: focusedNow ? _briefElementInfo(focusedNow) : null
        };
        this._lastFocusedElement = focusedNow;

        // Extras: dados de enriquecimento capturados pelo EventCapture
        const extras = { viewport, focus_info: focusInfo };

        this.onAction(action, domSnapshot, extras);
      } catch (e) {
        console.error('[FlowRecorder] Erro ao emitir ação:', e);
      }
    }

    // =======================================================================
    // Handler: CLICK
    // =======================================================================

    _handleClick(event) {
      try {
        const el = event.target;
        const tag = el.tagName ? el.tagName.toLowerCase() : '';
        const type = (el.type || '').toLowerCase();

        // Pular checkboxes e radios (tratados pelo change handler)
        if (tag === 'input' && CLICK_SKIP_TYPES.has(type)) return;

        // Pular campos de texto (tratados pelo input handler)
        if (tag === 'input' && CLICK_SKIP_INPUT_TYPES.has(type)) return;
        if (tag === 'textarea') return;

        // Pular selects (tratados pelo change handler)
        if (tag === 'select') return;

        // Flush de input pendente antes de registrar o click
        this._flushInputDebounce();

        const action = {
          type: 'click',
          target: SelectorGenerator.extractTargetInfo(el),
          coordinates: {
            x: Math.round(event.clientX),
            y: Math.round(event.clientY)
          },
          modifiers: {
            ctrl: event.ctrlKey,
            shift: event.shiftKey,
            alt: event.altKey
          }
        };

        this._emit(action);
      } catch (e) {
        console.error('[FlowRecorder] Erro no handler de click:', e);
      }
    }

    // =======================================================================
    // Handler: PASTE (detecta método de input)
    // =======================================================================

    _handlePaste(event) {
      this._lastInputWasPaste = true;
      // #12 — Capturar conteúdo do clipboard
      try {
        if (event.clipboardData) {
          this._clipboardContent = event.clipboardData.getData('text/plain') || null;
        }
      } catch (e) {
        this._clipboardContent = null;
      }
    }

    // =======================================================================
    // Handler: INPUT (texto, com debounce)
    // =======================================================================

    _handleInput(event) {
      try {
        const el = event.target;
        const tag = el.tagName ? el.tagName.toLowerCase() : '';

        // Apenas campos de texto
        if (tag !== 'input' && tag !== 'textarea') return;
        const type = (el.type || 'text').toLowerCase();
        if (['checkbox', 'radio', 'file', 'submit', 'button', 'reset', 'image'].includes(type)) return;

        // Se mudou de elemento, flush o anterior
        if (this._currentInputElement !== el) {
          this._flushInputDebounce();
          this._currentInputElement = el;
          this._currentInputValue = '';
        }

        this._currentInputValue = el.value;

        // Resetar timer de debounce
        clearTimeout(this._inputDebounceTimer);
        this._inputDebounceTimer = setTimeout(() => {
          this._flushInputDebounce();
        }, INPUT_DEBOUNCE_MS);
      } catch (e) {
        console.error('[FlowRecorder] Erro no handler de input:', e);
      }
    }

    /**
     * Flush do debounce de input — emite a ação de input_text pendente.
     */
    _flushInputDebounce() {
      clearTimeout(this._inputDebounceTimer);
      this._inputDebounceTimer = null;

      if (!this._currentInputElement || this._currentInputValue === '') {
        this._currentInputElement = null;
        this._currentInputValue = '';
        this._lastInputWasPaste = false;
        return;
      }

      const el = this._currentInputElement;
      const value = this._currentInputValue;
      const wasPaste = this._lastInputWasPaste;
      const clipContent = this._clipboardContent;

      const action = {
        type: 'input_text',
        value: value,
        target: SelectorGenerator.extractTargetInfo(el),
        input_method: wasPaste ? 'pasted' : 'typed',
        // #12 — Conteúdo colado (apenas quando o método foi paste)
        clipboard_content: wasPaste ? clipContent : null
      };

      // Limpar estado
      this._currentInputElement = null;
      this._currentInputValue = '';
      this._lastInputWasPaste = false;
      this._clipboardContent = null;

      this._emit(action);
    }

    // =======================================================================
    // Handler: CHANGE (selects, checkboxes, radios, file inputs)
    // =======================================================================

    _handleChange(event) {
      try {
        const el = event.target;
        const tag = el.tagName ? el.tagName.toLowerCase() : '';
        const type = (el.type || '').toLowerCase();

        if (tag === 'select') {
          this._handleSelectChange(el);
        } else if (type === 'checkbox') {
          this._handleCheckboxChange(el);
        } else if (type === 'radio') {
          this._handleRadioChange(el);
        } else if (type === 'file') {
          this._handleFileChange(el);
        }
      } catch (e) {
        console.error('[FlowRecorder] Erro no handler de change:', e);
      }
    }

    _handleSelectChange(el) {
      const selectedOption = el.options[el.selectedIndex];
      if (!selectedOption) return;

      const availableOptions = Array.from(el.options).map(opt => ({
        value: opt.value,
        label: opt.textContent.trim()
      }));

      const action = {
        type: 'select_option',
        selected: {
          value: selectedOption.value,
          label: selectedOption.textContent.trim(),
          index: el.selectedIndex
        },
        available_options: availableOptions,
        target: SelectorGenerator.extractTargetInfo(el)
      };

      this._emit(action);
    }

    _handleCheckboxChange(el) {
      const action = {
        type: 'checkbox_toggle',
        checked: el.checked,
        target: SelectorGenerator.extractTargetInfo(el)
      };

      this._emit(action);
    }

    _handleRadioChange(el) {
      const groupName = el.name;

      // Buscar todos os radios do mesmo grupo
      const radios = groupName
        ? document.querySelectorAll(`input[type="radio"][name="${CSS.escape(groupName)}"]`)
        : [el];

      const availableOptions = Array.from(radios).map(r => ({
        value: r.value,
        label: this._findLabelFor(r) || r.value
      }));

      const action = {
        type: 'radio_select',
        selected: {
          value: el.value,
          label: this._findLabelFor(el) || el.value
        },
        group_name: groupName || null,
        available_options: availableOptions,
        target: SelectorGenerator.extractTargetInfo(el)
      };

      this._emit(action);
    }

    _handleFileChange(el) {
      const files = Array.from(el.files).map(f => ({
        name: f.name,
        size_bytes: f.size,
        mime_type: f.type || 'application/octet-stream'
      }));

      const target = SelectorGenerator.extractTargetInfo(el);
      target.accept = el.accept || null;
      target.multiple = el.multiple;

      const action = {
        type: 'file_upload',
        files: files,
        target: target
      };

      this._emit(action);
    }

    // =======================================================================
    // Handler: KEYDOWN (teclas significativas)
    // =======================================================================

    _handleKeyDown(event) {
      try {
        const hasModifier = event.ctrlKey || event.altKey || event.metaKey;

        // Capturar apenas teclas significativas ou combinações com modificadores
        if (!SIGNIFICANT_KEYS.has(event.key) && !hasModifier) return;

        // Ignorar teclas comuns com Ctrl (Ctrl+A, Ctrl+C, etc.) que não precisam de step
        // Mas capturar Ctrl+Enter, Ctrl+S, etc.
        if (hasModifier && event.key.length === 1 && !['s', 'S'].includes(event.key)) return;

        const action = {
          type: 'key_press',
          key: event.key,
          code: event.code,
          modifiers: {
            ctrl: event.ctrlKey,
            shift: event.shiftKey,
            alt: event.altKey
          },
          target: SelectorGenerator.extractTargetInfo(event.target)
        };

        this._emit(action);
      } catch (e) {
        console.error('[FlowRecorder] Erro no handler de keydown:', e);
      }
    }

    // =======================================================================
    // Handler: SCROLL (com debounce)
    // =======================================================================

    _handleScroll(_event) {
      try {
        // No primeiro evento de scroll, registrar posição inicial
        if (!this._scrollDebounceTimer) {
          this._scrollStartTop = window.scrollY || document.documentElement.scrollTop;
        }

        // Resetar timer de debounce
        clearTimeout(this._scrollDebounceTimer);
        this._scrollDebounceTimer = setTimeout(() => {
          this._flushScrollDebounce();
        }, SCROLL_DEBOUNCE_MS);
      } catch (e) {
        console.error('[FlowRecorder] Erro no handler de scroll:', e);
      }
    }

    /**
     * Flush do debounce de scroll — emite a ação de scroll com posição final.
     */
    _flushScrollDebounce() {
      clearTimeout(this._scrollDebounceTimer);
      this._scrollDebounceTimer = null;

      const scrollTopAfter = window.scrollY || document.documentElement.scrollTop;
      const scrollTopBefore = this._scrollStartTop;

      // Ignorar se não houve mudança efetiva
      if (Math.abs(scrollTopAfter - scrollTopBefore) < 10) return;

      const action = {
        type: 'scroll',
        direction: scrollTopAfter > scrollTopBefore ? 'down' : 'up',
        scroll_top_before: Math.round(scrollTopBefore),
        scroll_top_after: Math.round(scrollTopAfter),
        viewport_height: window.innerHeight,
        page_height: document.documentElement.scrollHeight
      };

      this._scrollStartTop = scrollTopAfter;
      this._emit(action);
    }

    // =======================================================================
    // Handler: SUBMIT
    // =======================================================================

    _handleSubmit(event) {
      try {
        const form = event.target;

        // #5 — Capturar estado completo do formulário no momento do submit
        const formState = _captureFormState(form);

        const action = {
          type: 'navigation',
          from_url: window.location.href,
          to_url: form.action || window.location.href,
          trigger: 'form_submit',
          form_state: formState
        };

        this._emit(action);
      } catch (e) {
        console.error('[FlowRecorder] Erro no handler de submit:', e);
      }
    }

    // =======================================================================
    // Handlers: DRAG AND DROP (nice-to-have)
    // =======================================================================

    _handleDragStart(event) {
      try {
        this._dragSource = event.target;
        this._dragSourceInfo = SelectorGenerator.extractTargetInfo(event.target);
      } catch (e) {
        console.error('[FlowRecorder] Erro no handler de dragstart:', e);
      }
    }

    _handleDrop(event) {
      try {
        if (!this._dragSource || !this._dragSourceInfo) return;

        const action = {
          type: 'drag_and_drop',
          source: this._dragSourceInfo,
          destination: SelectorGenerator.extractTargetInfo(event.target)
        };

        this._dragSource = null;
        this._dragSourceInfo = null;

        this._emit(action);
      } catch (e) {
        console.error('[FlowRecorder] Erro no handler de drop:', e);
      }
    }

    // =======================================================================
    // Utilitários
    // =======================================================================

    /**
     * Busca o texto do label associado a um elemento de formulário.
     */
    _findLabelFor(element) {
      if (element.id) {
        const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
        if (label) return label.textContent.trim();
      }
      const parentLabel = element.closest('label');
      if (parentLabel) return parentLabel.textContent.trim();
      return null;
    }
  }

  // =========================================================================
  // Funções auxiliares (fora da classe, escopo do módulo)
  // =========================================================================

  /**
   * #11 — Resumo breve de um elemento (para focus tracking).
   */
  function _briefElementInfo(el) {
    if (!el || !el.tagName) return null;
    try {
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        name: el.getAttribute ? (el.getAttribute('name') || null) : null,
        type: el.getAttribute ? (el.getAttribute('type') || null) : null
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * #5 — Captura o estado completo de todos os campos de um formulário.
   */
  function _captureFormState(form) {
    try {
      const fields = [];
      const elements = form.elements;
      for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        if (!el.name && !el.id) continue;
        // Não capturar senhas em texto plano
        const value = el.type === 'password' ? '[REDACTED]' : (el.value || '');
        fields.push({
          tag: el.tagName.toLowerCase(),
          name: el.name || null,
          id: el.id || null,
          type: el.type || null,
          value: value,
          checked: el.checked !== undefined ? el.checked : null,
          selected_index: el.selectedIndex !== undefined ? el.selectedIndex : null
        });
      }
      return fields;
    } catch (e) {
      return [];
    }
  }

  // =========================================================================
  // Exportação do módulo
  // =========================================================================

  window.__FlowRecorder.EventCapture = EventCapture;
})();
