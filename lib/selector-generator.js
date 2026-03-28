/**
 * Módulo de geração de seletores CSS e XPath robustos.
 * Responsável por criar identificadores únicos para elementos do DOM,
 * priorizando estabilidade e unicidade dos seletores gerados.
 */
(function () {
  'use strict';

  window.__FlowRecorder = window.__FlowRecorder || {};

  // =========================================================================
  // Geração de CSS Selector
  // =========================================================================

  /**
   * Gera um seletor CSS único para o elemento.
   * Prioridade: #id > [name] > caminho hierárquico com classes.
   */
  function generateCSSSelector(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;

    try {
      // Prioridade 1: ID único
      if (element.id) {
        const escapedId = CSS.escape(element.id);
        const selector = `#${escapedId}`;
        if (document.querySelectorAll(selector).length === 1) {
          return selector;
        }
      }

      // Prioridade 2: atributo name (muito comum em formulários de tribunais)
      if (element.getAttribute('name')) {
        const name = element.getAttribute('name');
        const tag = element.tagName.toLowerCase();
        const selector = `${tag}[name="${CSS.escape(name)}"]`;
        if (document.querySelectorAll(selector).length === 1) {
          return selector;
        }
      }

      // Prioridade 3: data-testid ou data-id (atributos de teste)
      const testId = element.getAttribute('data-testid') || element.getAttribute('data-id');
      if (testId) {
        const selector = `[data-testid="${CSS.escape(testId)}"]`;
        if (document.querySelectorAll(selector).length === 1) {
          return selector;
        }
      }

      // Prioridade 4: construir caminho hierárquico
      return _buildPathSelector(element);
    } catch (e) {
      console.error('[FlowRecorder] Erro ao gerar CSS selector:', e);
      return element.tagName.toLowerCase();
    }
  }

  /**
   * Constrói um seletor CSS hierárquico do elemento até um ancestral com ID
   * ou até o document.
   */
  function _buildPathSelector(element) {
    const path = [];
    let current = element;

    while (current && current !== document.documentElement && current !== document) {
      let selector = current.tagName.toLowerCase();

      // Se o ancestral tem ID, parar aqui
      if (current.id && current !== element) {
        path.unshift(`#${CSS.escape(current.id)}`);
        break;
      }

      // Adicionar classes relevantes (excluindo classes dinâmicas comuns)
      if (current.className && typeof current.className === 'string') {
        const classes = current.className
          .trim()
          .split(/\s+/)
          .filter(c => c.length > 0 && !_isDynamicClass(c));
        if (classes.length > 0) {
          selector += '.' + classes.map(c => CSS.escape(c)).join('.');
        }
      }

      // Adicionar nth-of-type se necessário para desambiguar entre irmãos
      const parent = current.parentElement;
      if (parent) {
        const sameTagSiblings = Array.from(parent.children).filter(
          s => s.tagName === current.tagName
        );
        if (sameTagSiblings.length > 1) {
          const index = sameTagSiblings.indexOf(current) + 1;
          selector += `:nth-of-type(${index})`;
        }
      }

      path.unshift(selector);
      current = current.parentElement;
    }

    return path.join(' > ');
  }

  /**
   * Identifica classes CSS dinâmicas que mudam entre renderizações
   * (ex: classes geradas por frameworks CSS-in-JS).
   */
  function _isDynamicClass(className) {
    // Classes com hashes (CSS modules, styled-components, etc.)
    if (/^[a-zA-Z]+-[a-zA-Z0-9]{5,}$/.test(className)) return true;
    // Classes com prefixos de estado transitório
    if (/^(ng-|is-|has-|js-|u-|active|hover|focus|selected|disabled)/.test(className)) return false;
    return false;
  }

  // =========================================================================
  // Geração de XPath
  // =========================================================================

  /**
   * Gera um XPath absoluto para o elemento.
   * Usado como fallback quando o CSS selector não é suficiente.
   */
  function generateXPath(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;

    try {
      // Atalho: se tem ID, usar XPath direto por ID
      if (element.id) {
        return `//*[@id='${element.id}']`;
      }

      const parts = [];
      let current = element;

      while (current && current.nodeType === Node.ELEMENT_NODE) {
        let index = 1;
        let sibling = current.previousElementSibling;

        while (sibling) {
          if (sibling.tagName === current.tagName) {
            index++;
          }
          sibling = sibling.previousElementSibling;
        }

        const tagName = current.tagName.toLowerCase();
        parts.unshift(`${tagName}[${index}]`);
        current = current.parentElement;
      }

      return '/' + parts.join('/');
    } catch (e) {
      console.error('[FlowRecorder] Erro ao gerar XPath:', e);
      return null;
    }
  }

  // =========================================================================
  // Extração de informações do Target
  // =========================================================================

  /**
   * Extrai todas as informações relevantes de um elemento alvo de interação.
   * Retorna o objeto Target completo conforme a especificação do Semantic HAR.
   */
  function extractTargetInfo(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return { tag: 'unknown', selector_css: null, selector_xpath: null };
    }

    try {
      const rect = element.getBoundingClientRect();
      const isInIframe = window !== window.top;

      // Buscar label associado ao elemento
      let labelText = null;
      if (element.id) {
        const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
        if (label) labelText = label.textContent.trim();
      }
      if (!labelText) {
        const parentLabel = element.closest('label');
        if (parentLabel) labelText = parentLabel.textContent.trim();
      }

      const target = {
        tag: element.tagName.toLowerCase(),
        id: element.id || null,
        classes: _getClasses(element),
        text_content: _truncate((element.textContent || '').trim(), 200) || null,
        aria_label: element.getAttribute('aria-label') || null,
        name: element.getAttribute('name') || null,
        type: element.getAttribute('type') || null,
        placeholder: element.getAttribute('placeholder') || null,
        selector_css: generateCSSSelector(element),
        selector_xpath: generateXPath(element),
        bounding_rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        in_iframe: isInIframe,
        iframe_src: isInIframe ? window.location.href : null,
        // #1 — Estado de visibilidade do elemento
        visibility_state: _extractVisibilityState(element),
        // #9 — Elementos vizinhos/irmãos
        siblings: _extractSiblings(element),
        // #14 — Contexto de landmarks e headings
        landmark_context: _findLandmarkContext(element)
      };

      // Adicionar label se encontrado
      if (labelText) {
        target.label_text = _truncate(labelText, 200);
      }

      return target;
    } catch (e) {
      console.error('[FlowRecorder] Erro ao extrair info do target:', e);
      return {
        tag: element.tagName ? element.tagName.toLowerCase() : 'unknown',
        selector_css: null,
        selector_xpath: null,
        in_iframe: false,
        iframe_src: null
      };
    }
  }

  /**
   * Extrai classes do elemento como array de strings.
   */
  function _getClasses(element) {
    if (!element.className || typeof element.className !== 'string') return [];
    return element.className.trim().split(/\s+/).filter(c => c.length > 0);
  }

  /**
   * Trunca string para o tamanho máximo especificado.
   */
  function _truncate(str, maxLength) {
    if (!str || str.length <= maxLength) return str;
    return str.substring(0, maxLength) + '…';
  }

  // =========================================================================
  // #1 — Estado de visibilidade do elemento
  // =========================================================================

  function _extractVisibilityState(element) {
    try {
      const computed = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const inViewport = rect.top >= 0 && rect.left >= 0 &&
                         rect.bottom <= window.innerHeight && rect.right <= window.innerWidth;
      return {
        visible: !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length),
        display: computed.display,
        visibility: computed.visibility,
        opacity: parseFloat(computed.opacity),
        enabled: !element.disabled,
        readonly: !!element.readOnly,
        in_viewport: inViewport
      };
    } catch (e) {
      return { visible: true, enabled: true, in_viewport: true };
    }
  }

  // =========================================================================
  // #9 — Elementos vizinhos/irmãos do target
  // =========================================================================

  function _extractSiblings(element) {
    try {
      const parent = element.parentElement;
      if (!parent) return { previous: [], next: [] };

      const children = Array.from(parent.children);
      const idx = children.indexOf(element);

      const mapSibling = (el) => ({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        classes: el.className && typeof el.className === 'string'
          ? el.className.trim().split(/\s+/).filter(c => c).slice(0, 5) : [],
        text_content: _truncate((el.textContent || '').trim(), 100) || null
      });

      return {
        previous: children.slice(Math.max(0, idx - 2), idx).map(mapSibling),
        next: children.slice(idx + 1, idx + 3).map(mapSibling)
      };
    } catch (e) {
      return { previous: [], next: [] };
    }
  }

  // =========================================================================
  // #14 — Contexto de landmarks e headings
  // =========================================================================

  function _findLandmarkContext(element) {
    try {
      let current = element.parentElement;
      let heading = null;
      let landmark = null;

      const landmarkTags = new Set(['main', 'nav', 'header', 'footer', 'aside', 'section', 'form']);
      const landmarkRoles = new Set([
        'main', 'navigation', 'banner', 'contentinfo', 'form',
        'search', 'region', 'complementary'
      ]);

      while (current && current !== document.body) {
        // Procurar heading mais próximo dentro do ancestral
        if (!heading) {
          const h = current.querySelector('h1, h2, h3, h4, h5, h6');
          if (h) {
            heading = {
              tag: h.tagName.toLowerCase(),
              text: _truncate((h.textContent || '').trim(), 100)
            };
          }
        }

        // Procurar landmark mais próximo
        if (!landmark) {
          const role = current.getAttribute('role');
          const tag = current.tagName.toLowerCase();
          if (role && landmarkRoles.has(role)) {
            landmark = { tag, role, label: current.getAttribute('aria-label') || null };
          } else if (landmarkTags.has(tag)) {
            landmark = { tag, role: null, label: current.getAttribute('aria-label') || null };
          }
        }

        if (heading && landmark) break;
        current = current.parentElement;
      }

      return { nearest_heading: heading, nearest_landmark: landmark };
    } catch (e) {
      return { nearest_heading: null, nearest_landmark: null };
    }
  }

  // =========================================================================
  // Exportação do módulo
  // =========================================================================

  window.__FlowRecorder.SelectorGenerator = {
    generateCSSSelector,
    generateXPath,
    extractTargetInfo
  };
})();
