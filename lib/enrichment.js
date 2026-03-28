/**
 * Módulo de enriquecimento de contexto para gravações.
 * Captura dados adicionais que ajudam a LLM a gerar scripts mais robustos:
 * - Observação de mutações no DOM (para DOM diff e detecção de loaders)
 * - Tracking de waits implícitos (tempo desde última mudança no DOM)
 * - Interceptação de diálogos nativos (alert, confirm, prompt)
 *
 * Injetado como content script, compartilha namespace via window.__FlowRecorder.
 */
(function () {
  'use strict';

  window.__FlowRecorder = window.__FlowRecorder || {};

  // =========================================================================
  // Constantes
  // =========================================================================

  // Classes comuns de loaders/spinners em sites de tribunais
  const LOADER_SELECTORS = [
    '.loading', '.spinner', '.loader', '.overlay',
    '.progress', '.aguarde', '.carregando', '.wait',
    '[aria-busy="true"]', '.blockUI', '.ui-loading',
    '.modal-loading', '.loading-overlay', '.splash',
    '.preloader', '[class*="spinner"]', '[class*="loading"]'
  ];

  // Máximo de mutações armazenadas por intervalo entre steps
  const MAX_MUTATION_ENTRIES = 50;

  // =========================================================================
  // Classe Enrichment
  // =========================================================================

  class Enrichment {
    constructor() {
      this._observer = null;
      this._active = false;

      // #2 — Implicit waits: timestamp da última mutação significativa
      this._lastDomChangeTime = Date.now();

      // #4 — DOM diff: resumo de mutações desde o último flush
      this._mutationSummary = { added: 0, removed: 0, modified: 0, entries: [] };

      // #10 — Loaders: estado atual de loaders visíveis
      this._activeLoaders = [];

      // #13 — Dialog interception: buffer de diálogos capturados
      this._dialogBuffer = [];
      this._originalAlert = null;
      this._originalConfirm = null;
      this._originalPrompt = null;

      // Callback para emitir dialog_interaction como step
      this._onDialogAction = null;
    }

    /**
     * Inicia o enriquecimento: MutationObserver + dialog interception.
     * @param {Function} onDialogAction - Callback para emitir ações de diálogo
     */
    start(onDialogAction) {
      if (this._active) return;
      this._active = true;
      this._onDialogAction = onDialogAction;

      this._startDomObserver();
      this._interceptDialogs();

      console.log('[FlowRecorder] Enrichment iniciado');
    }

    /**
     * Para o enriquecimento e restaura funções originais.
     */
    stop() {
      if (!this._active) return;
      this._active = false;

      this._stopDomObserver();
      this._restoreDialogs();

      console.log('[FlowRecorder] Enrichment parado');
    }

    // =======================================================================
    // #2 — Implicit Wait: tempo desde última mudança no DOM
    // =======================================================================

    /**
     * Retorna há quantos ms o DOM está "parado" (sem mutações significativas).
     */
    getImplicitWaitMs() {
      return Math.max(0, Date.now() - this._lastDomChangeTime);
    }

    // =======================================================================
    // #4 — DOM Diff: resumo de mutações entre steps
    // =======================================================================

    /**
     * Retorna e reseta o resumo de mutações acumuladas.
     */
    flushMutationSummary() {
      const summary = { ...this._mutationSummary };
      summary.entries = [...summary.entries];
      this._mutationSummary = { added: 0, removed: 0, modified: 0, entries: [] };
      return summary;
    }

    // =======================================================================
    // #10 — Loader Detection
    // =======================================================================

    /**
     * Verifica quais loaders/spinners estão visíveis no momento.
     */
    detectActiveLoaders() {
      const loaders = [];
      try {
        for (const selector of LOADER_SELECTORS) {
          const elements = document.querySelectorAll(selector);
          for (const el of elements) {
            if (_isVisible(el)) {
              loaders.push({
                selector: selector,
                tag: el.tagName.toLowerCase(),
                classes: el.className && typeof el.className === 'string'
                  ? el.className.trim().split(/\s+/).slice(0, 5)
                  : [],
                text: (el.textContent || '').trim().substring(0, 100) || null
              });
            }
          }
        }
      } catch (e) {
        // Silenciar erros
      }
      this._activeLoaders = loaders;
      return loaders;
    }

    // =======================================================================
    // #13 — Dialog Interception (alert, confirm, prompt)
    // =======================================================================

    /**
     * Retorna e limpa o buffer de diálogos capturados.
     */
    flushDialogBuffer() {
      const buffer = [...this._dialogBuffer];
      this._dialogBuffer = [];
      return buffer;
    }

    _interceptDialogs() {
      try {
        // Salvar referências originais
        this._originalAlert = window.alert;
        this._originalConfirm = window.confirm;
        this._originalPrompt = window.prompt;

        const self = this;

        window.alert = function (message) {
          const startTime = Date.now();
          self._originalAlert.call(window, message);
          const duration = Date.now() - startTime;

          const dialog = {
            type: 'dialog_interaction',
            dialog_type: 'alert',
            dialog_text: String(message || ''),
            user_response: 'accepted',
            input_value: null,
            dialog_timing_ms: duration
          };
          self._dialogBuffer.push(dialog);
          if (self._onDialogAction) {
            self._onDialogAction(dialog);
          }
        };

        window.confirm = function (message) {
          const startTime = Date.now();
          const result = self._originalConfirm.call(window, message);
          const duration = Date.now() - startTime;

          const dialog = {
            type: 'dialog_interaction',
            dialog_type: 'confirm',
            dialog_text: String(message || ''),
            user_response: result ? 'accepted' : 'dismissed',
            input_value: null,
            dialog_timing_ms: duration
          };
          self._dialogBuffer.push(dialog);
          if (self._onDialogAction) {
            self._onDialogAction(dialog);
          }
          return result;
        };

        window.prompt = function (message, defaultValue) {
          const startTime = Date.now();
          const result = self._originalPrompt.call(window, message, defaultValue);
          const duration = Date.now() - startTime;

          const dialog = {
            type: 'dialog_interaction',
            dialog_type: 'prompt',
            dialog_text: String(message || ''),
            user_response: result !== null ? 'accepted' : 'dismissed',
            input_value: result,
            dialog_timing_ms: duration
          };
          self._dialogBuffer.push(dialog);
          if (self._onDialogAction) {
            self._onDialogAction(dialog);
          }
          return result;
        };
      } catch (e) {
        console.warn('[FlowRecorder] Não foi possível interceptar diálogos:', e.message);
      }
    }

    _restoreDialogs() {
      try {
        if (this._originalAlert) window.alert = this._originalAlert;
        if (this._originalConfirm) window.confirm = this._originalConfirm;
        if (this._originalPrompt) window.prompt = this._originalPrompt;
      } catch (e) {
        // Pode falhar se o contexto foi destruído
      }
    }

    // =======================================================================
    // MutationObserver (usado por #2, #4 e #10)
    // =======================================================================

    _startDomObserver() {
      try {
        this._observer = new MutationObserver((mutations) => {
          this._processMutations(mutations);
        });

        this._observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'disabled', 'aria-busy']
        });
      } catch (e) {
        console.warn('[FlowRecorder] MutationObserver não disponível:', e.message);
      }
    }

    _stopDomObserver() {
      if (this._observer) {
        this._observer.disconnect();
        this._observer = null;
      }
    }

    _processMutations(mutations) {
      let addedCount = 0;
      let removedCount = 0;
      let modifiedCount = 0;

      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          addedCount += mutation.addedNodes.length;
          removedCount += mutation.removedNodes.length;

          // Registrar mudanças significativas (elementos com tags, não texto)
          if (this._mutationSummary.entries.length < MAX_MUTATION_ENTRIES) {
            for (const node of mutation.addedNodes) {
              if (node.nodeType === Node.ELEMENT_NODE) {
                this._mutationSummary.entries.push({
                  operation: 'added',
                  tag: node.tagName.toLowerCase(),
                  id: node.id || null,
                  classes: node.className && typeof node.className === 'string'
                    ? node.className.trim().split(/\s+/).slice(0, 3) : []
                });
              }
            }
            for (const node of mutation.removedNodes) {
              if (node.nodeType === Node.ELEMENT_NODE) {
                this._mutationSummary.entries.push({
                  operation: 'removed',
                  tag: node.tagName.toLowerCase(),
                  id: node.id || null,
                  classes: node.className && typeof node.className === 'string'
                    ? node.className.trim().split(/\s+/).slice(0, 3) : []
                });
              }
            }
          }
        } else if (mutation.type === 'attributes') {
          modifiedCount++;
        }
      }

      this._mutationSummary.added += addedCount;
      this._mutationSummary.removed += removedCount;
      this._mutationSummary.modified += modifiedCount;

      // Atualizar timestamp da última mudança significativa
      if (addedCount > 0 || removedCount > 0) {
        this._lastDomChangeTime = Date.now();
      }
    }
  }

  // =========================================================================
  // Utilitários
  // =========================================================================

  function _isVisible(el) {
    if (!el.offsetWidth && !el.offsetHeight) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) > 0;
  }

  // =========================================================================
  // Exportação
  // =========================================================================

  window.__FlowRecorder.Enrichment = Enrichment;
})();
