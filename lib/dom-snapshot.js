/**
 * Módulo de captura de DOM Snapshot.
 * Responsável por capturar o HTML completo do documento,
 * incluindo o conteúdo de iframes same-origin quando possível.
 */
(function () {
  'use strict';

  window.__FlowRecorder = window.__FlowRecorder || {};

  /**
   * Captura um snapshot completo do DOM atual.
   * Tenta incluir o conteúdo de iframes same-origin como comentários inline
   * para preservar a estrutura completa da página.
   *
   * @returns {string} HTML completo do document, com conteúdo de iframes anotado
   */
  function captureDOMSnapshot() {
    try {
      let html = document.documentElement.outerHTML;

      // Tentar incluir conteúdo de iframes same-origin
      const iframes = document.querySelectorAll('iframe');
      iframes.forEach((iframe, index) => {
        try {
          const iframeDoc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
          if (iframeDoc) {
            const iframeHTML = iframeDoc.documentElement.outerHTML;
            const marker = `<!-- [FlowRecorder] iframe[${index}] src="${_escapeHtmlComment(iframe.src || 'about:blank')}" -->`;
            const endMarker = `<!-- [FlowRecorder] /iframe[${index}] -->`;

            // Inserir conteúdo do iframe como comentário logo após a tag do iframe
            const iframeOuterHTML = iframe.outerHTML;
            const insertionPoint = html.indexOf(iframeOuterHTML);
            if (insertionPoint !== -1) {
              const insertAfter = insertionPoint + iframeOuterHTML.length;
              html =
                html.substring(0, insertAfter) +
                '\n' + marker + '\n' + iframeHTML + '\n' + endMarker + '\n' +
                html.substring(insertAfter);
            }
          }
        } catch (e) {
          // Iframe cross-origin — não é possível acessar o conteúdo
          console.log(`[FlowRecorder] Iframe cross-origin ignorado: ${iframe.src || '(sem src)'}`);
        }
      });

      return html;
    } catch (e) {
      console.error('[FlowRecorder] Erro ao capturar DOM snapshot:', e);
      // Fallback: retornar pelo menos o outerHTML básico
      try {
        return document.documentElement.outerHTML;
      } catch (fallbackError) {
        return '<html><body>[FlowRecorder: erro ao capturar DOM]</body></html>';
      }
    }
  }

  /**
   * Escapa conteúdo para uso seguro dentro de comentários HTML.
   */
  function _escapeHtmlComment(str) {
    return str.replace(/--/g, '\\-\\-');
  }

  // =========================================================================
  // Exportação do módulo
  // =========================================================================

  window.__FlowRecorder.DOMSnapshot = {
    capture: captureDOMSnapshot
  };
})();
