/**
 * Lógica do Visualizador de Steps do Legis - Gravador de Fluxos.
 * Interface navegável para inspeção de gravações capturadas.
 */
(function () {
  'use strict';

  // =========================================================================
  // SVG Icons por tipo de ação (inline, sem emoji)
  // =========================================================================

  const ACTION_ICONS = {
    click: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l7.07 17 2.51-7.39L21 11.07z"/></svg>',
    input_text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>',
    select_option: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
    checkbox_toggle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>',
    radio_select: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4" fill="currentColor"/></svg>',
    file_upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
    navigation: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>',
    scroll: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 13 12 18 17 13"/><polyline points="7 6 12 11 17 6"/></svg>',
    key_press: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"/></svg>',
    drag_and_drop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg>',
    dialog_interaction: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>'
  };

  // Nomes amigáveis para tipos de ação
  const ACTION_LABELS = {
    click: 'Clique',
    input_text: 'Digitação',
    select_option: 'Seleção',
    checkbox_toggle: 'Checkbox',
    radio_select: 'Opção',
    file_upload: 'Upload',
    navigation: 'Navegação',
    scroll: 'Rolagem',
    key_press: 'Tecla',
    drag_and_drop: 'Arrastar',
    dialog_interaction: 'Diálogo',
    form_submit: 'Envio'
  };

  // =========================================================================
  // Elementos
  // =========================================================================

  const emptyScreen = document.getElementById('emptyScreen');
  const mainLayout = document.getElementById('mainLayout');
  const sidebarBadge = document.getElementById('sidebarBadge');
  const sidebarInfo = document.getElementById('sidebarInfo');
  const stepNav = document.getElementById('stepNav');
  const btnExportViewer = document.getElementById('btnExportViewer');

  const detailPlaceholder = document.getElementById('detailPlaceholder');
  const detailContent = document.getElementById('detailContent');
  const detailBadge = document.getElementById('detailBadge');
  const detailType = document.getElementById('detailType');
  const detailTime = document.getElementById('detailTime');
  const detailDescription = document.getElementById('detailDescription');
  const annotationEdit = document.getElementById('annotationEdit');
  const btnSaveAnnotation = document.getElementById('btnSaveAnnotation');
  const screenshotImg = document.getElementById('screenshotImg');
  const noScreenshot = document.getElementById('noScreenshot');
  const actionJson = document.getElementById('actionJson');
  const networkBadge = document.getElementById('networkBadge');
  const networkList = document.getElementById('networkList');
  const noNetwork = document.getElementById('noNetwork');
  const domSizeBadge = document.getElementById('domSizeBadge');
  const domHtml = document.getElementById('domHtml');
  const btnCopyDom = document.getElementById('btnCopyDom');
  const detailPanel = document.getElementById('detailPanel');

  // =========================================================================
  // Estado
  // =========================================================================

  let recording = null;
  let selectedIndex = -1;

  // =========================================================================
  // Init
  // =========================================================================

  async function init() {
    recording = await loadRecording();

    if (!recording || !recording.steps || recording.steps.length === 0) {
      emptyScreen.classList.remove('hidden');
      mainLayout.classList.add('hidden');
      return;
    }

    emptyScreen.classList.add('hidden');
    mainLayout.classList.remove('hidden');

    sidebarBadge.textContent = recording.steps.length;
    sidebarInfo.innerHTML = [
      `<strong>Duração:</strong> ${formatDuration(recording.metadata.total_duration_ms)}`,
      `<strong>Data:</strong> ${formatDate(recording.created_at)}`
    ].join('<br>');

    renderStepNav();
    setupCardToggles();
    selectStep(0);

    btnExportViewer.addEventListener('click', exportRecording);
  }

  function loadRecording() {
    return new Promise((resolve) => {
      // Suporte a ?id=xxx para carregar gravações do histórico
      const params = new URLSearchParams(window.location.search);
      const historyId = params.get('id');

      const msgType = historyId ? 'GET_RECORDING_BY_ID' : 'GET_RECORDING';
      const msg = historyId
        ? { type: msgType, recordingId: historyId }
        : { type: msgType };

      chrome.runtime.sendMessage(msg, (response) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(response);
      });
    });
  }

  // =========================================================================
  // Step list
  // =========================================================================

  function renderStepNav() {
    stepNav.innerHTML = '';
    const annotations = recording.annotations || [];

    // Construir timeline mesclada: steps + annotations, ordenados por elapsed_ms
    const timeline = [];
    recording.steps.forEach((step, i) => {
      timeline.push({ kind: 'step', step, index: i, elapsed: step.elapsed_ms_from_start || 0 });
    });
    annotations.forEach((ann, i) => {
      timeline.push({ kind: 'annotation', annotation: ann, index: i, elapsed: ann.elapsed_ms || 0 });
    });
    timeline.sort((a, b) => a.elapsed - b.elapsed);

    timeline.forEach(entry => {
      if (entry.kind === 'step') {
        const step = entry.step;
        const i = entry.index;
        const item = document.createElement('div');
        item.className = 'step-item';
        item.dataset.index = i;

        const actionType = step.action.type;
        const iconSvg = ACTION_ICONS[actionType] || ACTION_ICONS.click;
        const label = getStepLabel(step);
        const sublabel = getStepSublabel(step);

        item.innerHTML = `
          <div class="step-item-icon ${esc(actionType)}">${iconSvg}</div>
          <div class="step-item-info">
            <div class="step-item-label">${esc(label)}</div>
            <div class="step-item-sublabel">${esc(sublabel)}</div>
          </div>
          <span class="step-item-number">${i + 1}</span>
        `;

        item.addEventListener('click', () => selectStep(i));
        stepNav.appendChild(item);
      } else {
        // Annotation — render as note item
        const ann = entry.annotation;
        const note = document.createElement('div');
        note.className = 'annotation-timeline-item';
        note.innerHTML = `
          <svg class="annotation-timeline-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          <div class="annotation-timeline-body">
            <span class="annotation-timeline-text">${esc(ann.text)}</span>
            <span class="annotation-timeline-time">${formatDuration(ann.elapsed_ms)}</span>
          </div>
        `;
        stepNav.appendChild(note);
      }
    });
  }

  function getStepLabel(step) {
    const a = step.action;
    const friendly = ACTION_LABELS[a.type] || a.type;

    switch (a.type) {
      case 'click':
        return `${friendly} em "${trunc(a.target?.text_content || a.target?.id || 'elemento', 30)}"`;
      case 'input_text':
        return `${friendly}: "${trunc(a.value, 30)}"`;
      case 'select_option':
        return `${friendly}: "${a.selected?.label || ''}"`;
      case 'checkbox_toggle':
        return `${a.checked ? 'Marcou' : 'Desmarcou'} checkbox`;
      case 'radio_select':
        return `${friendly}: "${a.selected?.label || ''}"`;
      case 'file_upload':
        return `${friendly}: ${a.files?.map(f => f.name).join(', ') || 'arquivo'}`;
      case 'navigation':
        return `Navegou para nova página`;
      case 'scroll':
        return `Rolou a página para ${a.direction === 'down' ? 'baixo' : 'cima'}`;
      case 'key_press': {
        const mod = [a.modifiers?.ctrl && 'Ctrl', a.modifiers?.alt && 'Alt', a.modifiers?.shift && 'Shift'].filter(Boolean).join('+');
        return `Tecla: ${mod ? mod + '+' : ''}${a.key}`;
      }
      default:
        return friendly;
    }
  }

  function getStepSublabel(step) {
    const a = step.action;
    const tabPrefix = (step.tab_index != null) ? `Aba ${step.tab_index} · ` : '';
    switch (a.type) {
      case 'click':
        return tabPrefix + (a.target?.selector_css || '');
      case 'input_text':
        return tabPrefix + (a.target?.name || a.target?.id || '');
      case 'navigation':
        return tabPrefix + trunc(a.to_url || '', 50);
      default:
        return tabPrefix + (a.target?.id || a.target?.name || '');
    }
  }

  // =========================================================================
  // Detalhes do step
  // =========================================================================

  function selectStep(index) {
    if (!recording || index < 0 || index >= recording.steps.length) return;
    selectedIndex = index;
    const step = recording.steps[index];

    // Sidebar active state
    stepNav.querySelectorAll('.step-item').forEach(el => {
      el.classList.toggle('active', parseInt(el.dataset.index) === index);
    });

    detailPlaceholder.classList.add('hidden');
    detailContent.classList.remove('hidden');

    // Header
    detailBadge.textContent = index + 1;
    detailType.textContent = step.action.type;
    detailTime.textContent = `+${formatDuration(step.elapsed_ms_from_start)}`;

    // Description
    detailDescription.textContent = buildHumanDescription(step);

    // Annotations: mostrar as que caem no intervalo deste step
    renderStepAnnotations(step);

    // Screenshot
    if (step.screenshot_base64) {
      screenshotImg.src = step.screenshot_base64;
      screenshotImg.classList.remove('hidden');
      noScreenshot.classList.add('hidden');
    } else {
      screenshotImg.classList.add('hidden');
      noScreenshot.classList.remove('hidden');
    }

    // Action JSON
    actionJson.textContent = JSON.stringify(step.action, null, 2);

    // Network
    renderNetwork(step.network_activity || []);

    // DOM
    if (step.dom_snapshot) {
      const kb = Math.round(step.dom_snapshot.length / 1024);
      domSizeBadge.textContent = `${kb} KB`;
      const max = 100 * 1024;
      domHtml.textContent = step.dom_snapshot.length > max
        ? step.dom_snapshot.substring(0, max) + `\n\n... [truncado — ${kb}KB total]`
        : step.dom_snapshot;
    } else {
      domSizeBadge.textContent = '0 KB';
      domHtml.textContent = '(indisponível)';
    }

    detailPanel.scrollTop = 0;
  }

  function buildHumanDescription(step) {
    const a = step.action;
    const tabNote = (step.tab_index != null) ? ` [Aba ${step.tab_index}]` : '';
    switch (a.type) {
      case 'click':
        return `O usuário clicou no elemento "${a.target?.text_content || a.target?.id || 'desconhecido'}" (${a.target?.tag || ''}) na página.${tabNote}`;
      case 'input_text':
        return `O usuário digitou "${trunc(a.value, 60)}" no campo "${a.target?.placeholder || a.target?.name || a.target?.id || ''}" (método: ${a.input_method === 'pasted' ? 'colou' : 'digitou'}).`;
      case 'select_option':
        return `O usuário selecionou a opção "${a.selected?.label}" no campo "${a.target?.name || a.target?.id || 'select'}".`;
      case 'checkbox_toggle':
        return `O usuário ${a.checked ? 'marcou' : 'desmarcou'} o checkbox "${a.target?.label_text || a.target?.id || ''}".`;
      case 'radio_select':
        return `O usuário selecionou a opção "${a.selected?.label}" no grupo "${a.group_name || ''}".`;
      case 'file_upload':
        return `O usuário fez upload de ${a.files?.length || 0} arquivo(s): ${a.files?.map(f => f.name).join(', ')}.`;
      case 'navigation':
        return `O navegador foi para: ${trunc(a.to_url, 80)} (causa: ${a.trigger}).`;
      case 'scroll':
        return `O usuário rolou a página para ${a.direction === 'down' ? 'baixo' : 'cima'} (de ${a.scroll_top_before}px para ${a.scroll_top_after}px).`;
      case 'key_press': {
        const mod = [a.modifiers?.ctrl && 'Ctrl', a.modifiers?.alt && 'Alt', a.modifiers?.shift && 'Shift'].filter(Boolean).join('+');
        return `O usuário pressionou ${mod ? mod + '+' : ''}${a.key}.`;
      }
      default:
        return `Ação: ${a.type}`;
    }
  }

  // =========================================================================
  // Network
  // =========================================================================

  function renderNetwork(requests) {
    networkBadge.textContent = requests.length;
    networkList.innerHTML = '';

    if (requests.length === 0) {
      noNetwork.classList.remove('hidden');
      return;
    }
    noNetwork.classList.add('hidden');

    requests.forEach(req => {
      const item = document.createElement('div');
      item.className = 'net-item';

      const methodCls = (req.method || 'get').toLowerCase();
      const statusCls = getStatusClass(req.response_status);

      let shortUrl = req.url;
      try { shortUrl = new URL(req.url).pathname + new URL(req.url).search; } catch (e) {}

      const header = document.createElement('div');
      header.className = 'net-header';
      header.innerHTML = `
        <span class="net-method ${esc(methodCls)}">${esc(req.method || 'GET')}</span>
        <span class="net-status ${statusCls}">${req.response_status || '—'}</span>
        <span class="net-url" title="${esc(req.url)}">${esc(shortUrl)}</span>
        <span class="net-duration">${req.timing?.duration_ms ? req.timing.duration_ms + 'ms' : ''}</span>
      `;

      const body = document.createElement('div');
      body.className = 'net-body';
      let html = '';
      if (req.request_headers && Object.keys(req.request_headers).length)
        html += `<div class="net-sub-title">Request Headers</div><pre>${esc(JSON.stringify(req.request_headers, null, 2))}</pre>`;
      if (req.request_body)
        html += `<div class="net-sub-title">Request Body</div><pre>${esc(fmtBody(req.request_body))}</pre>`;
      if (req.response_headers && Object.keys(req.response_headers).length)
        html += `<div class="net-sub-title">Response Headers</div><pre>${esc(JSON.stringify(req.response_headers, null, 2))}</pre>`;
      if (req.response_body)
        html += `<div class="net-sub-title">Response Body${req.response_body_truncated ? ' (truncado)' : ''}</div><pre>${esc(fmtBody(req.response_body))}</pre>`;
      body.innerHTML = html;

      header.addEventListener('click', () => body.classList.toggle('open'));
      item.appendChild(header);
      item.appendChild(body);
      networkList.appendChild(item);
    });
  }

  function getStatusClass(s) {
    if (!s || s === 0) return 'err';
    if (s >= 200 && s < 300) return 'ok';
    if (s >= 300 && s < 400) return 'redir';
    return 'err';
  }

  function fmtBody(body) {
    try { return JSON.stringify(JSON.parse(body), null, 2); } catch (e) { return body; }
  }

  // =========================================================================
  // Card toggle
  // =========================================================================

  function setupCardToggles() {
    document.querySelectorAll('.card-header[data-toggle]').forEach(header => {
      header.addEventListener('click', () => {
        const bodyId = header.dataset.toggle;
        const body = document.getElementById(bodyId);
        if (body) {
          body.classList.toggle('open');
          header.classList.toggle('open');
        }
      });
    });
  }

  // =========================================================================
  // Annotations (timestamp-based)
  // =========================================================================

  /**
   * Renderiza as annotations que pertencem ao intervalo de tempo deste step.
   */
  function renderStepAnnotations(step) {
    const annotations = recording.annotations || [];
    const stepElapsed = step.elapsed_ms_from_start || 0;
    // Encontrar o próximo step para delimitar o intervalo
    const nextStep = (selectedIndex + 1 < recording.steps.length)
      ? recording.steps[selectedIndex + 1]
      : null;
    const nextElapsed = nextStep ? (nextStep.elapsed_ms_from_start || Infinity) : Infinity;

    // Annotations que caem nesse intervalo (inclusive início, exclusive fim)
    const relevant = annotations.filter(a =>
      a.elapsed_ms >= stepElapsed && a.elapsed_ms < nextElapsed
    );

    const block = document.getElementById('annotationBlock');
    // Limpar lista anterior de annotations exibidas
    block.querySelectorAll('.annotation-display-item').forEach(el => el.remove());

    if (relevant.length > 0) {
      const list = document.createElement('div');
      list.className = 'annotation-display-item';
      list.style.marginBottom = '10px';
      relevant.forEach(ann => {
        const item = document.createElement('div');
        item.className = 'annotation-display-row';
        item.innerHTML = `
          <svg class="icon-small" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--brand-gold);flex-shrink:0"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          <span class="annotation-display-text">${esc(ann.text)}</span>
          <span class="annotation-display-time">${formatDuration(ann.elapsed_ms)}</span>
        `;
        list.appendChild(item);
      });
      block.insertBefore(list, block.firstChild);
    }

    // Preencher o input com vazio (para novas observações)
    annotationEdit.value = '';
  }

  btnSaveAnnotation.addEventListener('click', () => saveAnnotation());
  annotationEdit.addEventListener('keydown', e => { if (e.key === 'Enter') saveAnnotation(); });

  function saveAnnotation() {
    if (selectedIndex < 0 || !recording) return;
    const text = annotationEdit.value.trim();
    if (!text) return;

    const step = recording.steps[selectedIndex];
    const elapsedMs = step.elapsed_ms_from_start || 0;

    chrome.runtime.sendMessage({
      type: 'ADD_ANNOTATION',
      text,
      elapsed_ms: elapsedMs
    }, resp => {
      if (resp && resp.ok) {
        // Atualizar no recording local
        if (!recording.annotations) recording.annotations = [];
        recording.annotations.push({
          text,
          timestamp: new Date().toISOString(),
          elapsed_ms: elapsedMs
        });
        // Re-render
        renderStepNav();
        stepNav.querySelectorAll('.step-item').forEach(el => {
          el.classList.toggle('active', parseInt(el.dataset.index) === selectedIndex);
        });
        renderStepAnnotations(step);
        annotationEdit.value = '';
        btnSaveAnnotation.textContent = 'Salvo!';
        setTimeout(() => { btnSaveAnnotation.textContent = 'Salvar'; }, 1500);
      }
    });
  }

  // =========================================================================
  // Copy DOM
  // =========================================================================

  btnCopyDom.addEventListener('click', () => {
    if (selectedIndex < 0 || !recording) return;
    const html = recording.steps[selectedIndex].dom_snapshot;
    if (html) {
      navigator.clipboard.writeText(html).then(() => {
        btnCopyDom.querySelector('.icon-small + *') || null;
        const original = btnCopyDom.innerHTML;
        btnCopyDom.textContent = 'Copiado!';
        setTimeout(() => { btnCopyDom.innerHTML = original; }, 1500);
      });
    }
  });

  // =========================================================================
  // Export
  // =========================================================================

  function exportRecording() {
    if (!recording) return;
    const json = JSON.stringify(recording, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const a = document.createElement('a');
    a.href = url;
    a.download = `gravacao_${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // =========================================================================
  // Keyboard navigation
  // =========================================================================

  document.addEventListener('keydown', e => {
    if (!recording || recording.steps.length === 0) return;
    if (e.target === annotationEdit) return;

    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      selectStep(Math.min(selectedIndex + 1, recording.steps.length - 1));
      scrollItemIntoView(selectedIndex);
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      selectStep(Math.max(selectedIndex - 1, 0));
      scrollItemIntoView(selectedIndex);
    }
  });

  function scrollItemIntoView(i) {
    const el = stepNav.querySelector(`[data-index="${i}"]`);
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // =========================================================================
  // Utils
  // =========================================================================

  function trunc(s, max) { return (!s || s.length <= max) ? (s || '') : s.substring(0, max) + '...'; }
  function formatDuration(ms) {
    if (!ms && ms !== 0) return '—';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms/1000).toFixed(1)}s`;
    const m = Math.floor(ms/60000), s = Math.floor((ms%60000)/1000);
    return `${m}m ${s}s`;
  }
  function formatDate(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('pt-BR'); } catch (e) { return iso; }
  }
  function esc(s) {
    if (!s) return '';
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // =========================================================================
  // Start
  // =========================================================================

  init();
})();
