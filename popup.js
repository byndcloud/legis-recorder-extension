/**
 * Lógica do Popup (UI de controle) do Legis - Gravador de Fluxos.
 * Gerencia 4 telas distintas: Welcome, Recording, Paused, Done.
 */
(function () {
  'use strict';

  // =========================================================================
  // Telas e elementos
  // =========================================================================

  const screens = {
    loading: document.getElementById('screenLoading'),
    welcome: document.getElementById('screenWelcome'),
    recording: document.getElementById('screenRecording'),
    paused: document.getElementById('screenPaused'),
    done: document.getElementById('screenDone')
  };

  const els = {
    // Welcome
    btnStartWelcome: document.getElementById('btnStartWelcome'),
    // Recording
    recTimer: document.getElementById('recTimer'),
    counterRecording: document.getElementById('counterRecording'),
    btnPause: document.getElementById('btnPause'),
    btnStop: document.getElementById('btnStop'),
    annotationInputRec: document.getElementById('annotationInputRec'),
    btnAnnotationRec: document.getElementById('btnAnnotationRec'),
    // Paused
    pauseTimer: document.getElementById('pauseTimer'),
    counterPaused: document.getElementById('counterPaused'),
    btnResume: document.getElementById('btnResume'),
    btnStopPaused: document.getElementById('btnStopPaused'),
    annotationInputPaused: document.getElementById('annotationInputPaused'),
    btnAnnotationPaused: document.getElementById('btnAnnotationPaused'),
    // Done
    doneSteps: document.getElementById('doneSteps'),
    doneDuration: document.getElementById('doneDuration'),
    btnExport: document.getElementById('btnExport'),
    btnView: document.getElementById('btnView'),
    btnNewRecording: document.getElementById('btnNewRecording'),
    btnShowHistory: document.getElementById('btnShowHistory'),
    // History
    historySection: document.getElementById('historySection'),
    historyList: document.getElementById('historyList'),
    // Loading
    loadingText: document.getElementById('loadingText'),
    // Toast
    toast: document.getElementById('toast')
  };

  function setLoadingText(msg) {
    if (els.loadingText) els.loadingText.textContent = msg;
  }

  // =========================================================================
  // Estado
  // =========================================================================

  let currentScreen = 'loading';
  let stepCount = 0;
  let startTime = null;
  let timerInterval = null;
  let pausedElapsed = null;
  let pendingAction = null; // lock síncrono contra double-click

  // =========================================================================
  // Comunicação com o Service Worker
  // =========================================================================

  function sendMessage(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { ok: true });
        }
      });
    });
  }

  // =========================================================================
  // Navegação entre telas
  // =========================================================================

  function showScreen(name) {
    Object.values(screens).forEach(s => s.classList.add('hidden'));
    if (screens[name]) {
      screens[name].classList.remove('hidden');
      currentScreen = name;
    }
  }

  // =========================================================================
  // Timer
  // =========================================================================

  function startTimer(fromTime) {
    stopTimer();
    startTime = fromTime || Date.now();

    function tick() {
      const elapsed = Date.now() - startTime;
      const formatted = formatTimer(elapsed);
      els.recTimer.textContent = formatted;
    }

    tick();
    timerInterval = setInterval(tick, 1000);
  }

  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function formatTimer(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function formatDuration(ms) {
    if (!ms || ms === 0) return '0s';
    if (ms < 60000) return `${Math.round(ms / 1000)}s`;
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  // =========================================================================
  // Toast (notificação)
  // =========================================================================

  function showToast(message, type = 'success') {
    els.toast.textContent = message;
    els.toast.className = `toast ${type}`;
    setTimeout(() => {
      els.toast.classList.add('hidden');
    }, 3000);
  }

  // =========================================================================
  // Anotação
  // =========================================================================

  async function saveAnnotation(inputEl) {
    const text = inputEl.value.trim();
    if (!text) return;

    // Calcular elapsed_ms a partir do startTime persistido
    const elapsedMs = startTime ? Math.max(0, Date.now() - startTime) : 0;
    const response = await sendMessage({
      type: 'ADD_ANNOTATION',
      text,
      elapsed_ms: elapsedMs
    });

    if (response.ok) {
      inputEl.value = '';
      showToast('Observação salva em ' + formatTimer(elapsedMs));
    }
  }

  // =========================================================================
  // Handlers de ação
  // =========================================================================

  // Iniciar gravação
  async function handleStart() {
    if (pendingAction) return;
    pendingAction = 'start';
    els.btnStartWelcome.disabled = true;
    const previousScreen = currentScreen;
    setLoadingText('Iniciando gravação...');
    showScreen('loading');
    try {
      const response = await sendMessage({ type: 'START_RECORDING' });
      if (response.ok) {
        stepCount = 0;
        els.counterRecording.textContent = '0';
        startTimer(Date.now());
        showScreen('recording');
      } else {
        showToast('Erro ao iniciar: ' + (response.error || ''), 'error');
        showScreen(previousScreen);
      }
    } finally {
      pendingAction = null;
      els.btnStartWelcome.disabled = false;
    }
  }

  // Pausar
  async function handlePause() {
    if (pendingAction) return;
    pendingAction = 'pause';
    els.btnPause.disabled = true;
    try {
      const response = await sendMessage({ type: 'PAUSE_RECORDING' });
      if (response.ok) {
        stopTimer();
        pausedElapsed = startTime ? Date.now() - startTime : 0;
        els.pauseTimer.textContent = formatTimer(pausedElapsed);
        els.counterPaused.textContent = String(stepCount);
        showScreen('paused');
      } else if (response.error) {
        showToast('Erro ao pausar: ' + response.error, 'error');
      }
    } finally {
      pendingAction = null;
      els.btnPause.disabled = false;
    }
  }

  // Retomar
  async function handleResume() {
    if (pendingAction) return;
    pendingAction = 'resume';
    els.btnResume.disabled = true;
    try {
      const response = await sendMessage({ type: 'RESUME_RECORDING' });
      if (response.ok) {
        // Ajustar startTime para manter o timer contínuo
        startTime = Date.now() - (pausedElapsed || 0);
        startTimer(startTime);
        els.counterRecording.textContent = String(stepCount);
        showScreen('recording');
      } else if (response.error) {
        showToast('Erro ao retomar: ' + response.error, 'error');
      }
    } finally {
      pendingAction = null;
      els.btnResume.disabled = false;
    }
  }

  // Parar
  async function handleStop() {
    if (pendingAction) return;
    pendingAction = 'stop';
    els.btnStop.disabled = true;
    els.btnStopPaused.disabled = true;
    const previousScreen = currentScreen;
    const elapsedBeforeStop = startTime ? Date.now() - startTime : (pausedElapsed || 0);
    stopTimer();
    setLoadingText('Finalizando gravação...');
    showScreen('loading');
    try {
      const response = await sendMessage({ type: 'STOP_RECORDING' });
      if (response.ok) {
        els.doneSteps.textContent = String(stepCount);
        els.doneDuration.textContent = formatDuration(elapsedBeforeStop);
        showScreen('done');
      } else if (response.error) {
        showToast('Erro ao parar: ' + response.error, 'error');
        showScreen(previousScreen);
      }
    } finally {
      pendingAction = null;
      els.btnStop.disabled = false;
      els.btnStopPaused.disabled = false;
    }
  }

  // Exportar JSON
  async function handleExport() {
    const response = await sendMessage({ type: 'EXPORT_RECORDING' });
    if (response && response.recording) {
      const json = JSON.stringify(response.recording, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);

      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const filename = `gravacao_${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}.json`;

      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      showToast('Arquivo exportado');
    } else {
      showToast('Nenhuma gravação disponível', 'error');
    }
  }

  // Ver detalhes
  function handleView() {
    const viewerUrl = chrome.runtime.getURL('viewer.html');
    chrome.tabs.create({ url: viewerUrl });
  }

  // Nova gravação — arquiva o recording finalizado em histórico
  // e limpa o slot ativo pra que próximas aberturas do popup
  // mostrem a tela welcome (não a done).
  async function handleNew() {
    showScreen('welcome');
    await sendMessage({ type: 'DISMISS_CURRENT_RECORDING' });
    loadHistory();
  }

  // =========================================================================
  // Bind de eventos
  // =========================================================================

  els.btnStartWelcome.addEventListener('click', handleStart);
  els.btnPause.addEventListener('click', handlePause);
  els.btnStop.addEventListener('click', handleStop);
  els.btnResume.addEventListener('click', handleResume);
  els.btnStopPaused.addEventListener('click', handleStop);
  els.btnExport.addEventListener('click', handleExport);
  els.btnView.addEventListener('click', handleView);
  els.btnNewRecording.addEventListener('click', handleNew);
  els.btnShowHistory.addEventListener('click', () => { showScreen('welcome'); loadHistory(); });

  // Anotações
  els.btnAnnotationRec.addEventListener('click', () => saveAnnotation(els.annotationInputRec));
  els.btnAnnotationPaused.addEventListener('click', () => saveAnnotation(els.annotationInputPaused));
  els.annotationInputRec.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveAnnotation(els.annotationInputRec);
  });
  els.annotationInputPaused.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveAnnotation(els.annotationInputPaused);
  });

  // =========================================================================
  // Histórico de gravações
  // =========================================================================

  // Ícones SVG reutilizáveis para os botões do histórico
  const SVG_EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  const SVG_DOWNLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  const SVG_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>';

  async function loadHistory() {
    const index = await sendMessage({ type: 'GET_HISTORY' });
    if (!Array.isArray(index) || index.length === 0) {
      els.historySection.classList.add('hidden');
      return;
    }
    els.historySection.classList.remove('hidden');
    renderHistory(index);
  }

  function renderHistory(index) {
    els.historyList.innerHTML = '';
    index.forEach(entry => {
      const item = document.createElement('div');
      item.className = 'history-item';

      const meta = entry.metadata || {};
      const date = formatDateShort(entry.created_at);
      const steps = meta.total_steps || 0;
      const dur = formatDuration(meta.total_duration_ms || 0);
      let url = meta.initial_url || '';
      try { url = new URL(url).hostname + new URL(url).pathname; } catch (_) {}
      if (url.length > 40) url = url.substring(0, 40) + '...';

      item.innerHTML = `
        <div class="history-item-info">
          <span class="history-item-date">${date}</span>
          <span class="history-item-stats">${steps} ações &middot; ${dur}</span>
          <span class="history-item-url">${escapeHtml(url)}</span>
        </div>
        <div class="history-item-actions">
          <button class="btn-hist view" title="Ver detalhes">${SVG_EYE}</button>
          <button class="btn-hist export" title="Exportar">${SVG_DOWNLOAD}</button>
          <button class="btn-hist delete" title="Excluir">${SVG_TRASH}</button>
        </div>
      `;

      // Ver
      item.querySelector('.view').addEventListener('click', (e) => {
        e.stopPropagation();
        const viewerUrl = chrome.runtime.getURL(`viewer.html?id=${entry.recording_id}`);
        chrome.tabs.create({ url: viewerUrl });
      });

      // Exportar
      item.querySelector('.export').addEventListener('click', async (e) => {
        e.stopPropagation();
        const rec = await sendMessage({ type: 'GET_RECORDING_BY_ID', recordingId: entry.recording_id });
        if (rec) {
          downloadJson(rec, entry.created_at);
          showToast('Arquivo exportado');
        }
      });

      // Excluir (duplo clique para confirmar)
      const delBtn = item.querySelector('.delete');
      let confirmPending = false;
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirmPending) {
          confirmPending = true;
          delBtn.innerHTML = '<span style="font-size:9px;font-weight:700">OK?</span>';
          delBtn.style.background = '#FEE2E2';
          delBtn.style.color = '#DC2626';
          setTimeout(() => {
            if (confirmPending) {
              confirmPending = false;
              delBtn.innerHTML = SVG_TRASH;
              delBtn.style.background = '';
              delBtn.style.color = '';
            }
          }, 3000);
        } else {
          await sendMessage({ type: 'DELETE_FROM_HISTORY', recordingId: entry.recording_id });
          showToast('Gravação excluída');
          loadHistory();
        }
      });

      els.historyList.appendChild(item);
    });
  }

  function downloadJson(recording, createdAt) {
    const json = JSON.stringify(recording, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const d = new Date(createdAt || Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    const filename = `gravacao_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}.json`;
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function formatDateShort(isoStr) {
    if (!isoStr) return '';
    try {
      const d = new Date(isoStr);
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch (_) { return isoStr; }
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  // =========================================================================
  // Inicialização: sincronizar com estado atual do background
  // =========================================================================

  /**
   * Renderiza tela conforme snapshot de estado vindo de cache ou SW.
   * Idempotente — pode ser chamado múltiplas vezes (cache + reconciliação).
   */
  function applyState(s) {
    if (!s) {
      showScreen('welcome');
      loadHistory();
      return;
    }

    stepCount = s.stepCount || 0;

    // 'starting'/'stopping'/'pausing'/'resuming' são transitórios; mapear pra
    // tela mais próxima pra evitar flash de loading.
    const effectiveState =
      s.state === 'starting' || s.state === 'resuming' ? 'recording' :
      s.state === 'pausing' ? 'recording' :
      s.state === 'stopping' ? 'recording' :
      s.state;

    switch (effectiveState) {
      case 'recording':
        els.counterRecording.textContent = String(stepCount);
        startTimer(s.startTime || Date.now());
        showScreen('recording');
        break;

      case 'paused':
        els.counterPaused.textContent = String(stepCount);
        if (s.startTime) {
          pausedElapsed = Date.now() - s.startTime;
          els.pauseTimer.textContent = formatTimer(pausedElapsed);
        }
        showScreen('paused');
        break;

      case 'idle':
      default:
        if (s.hasRecording) {
          els.doneSteps.textContent = String(stepCount);
          els.doneDuration.textContent = formatDuration(
            s.recordingMeta?.total_duration_ms || 0
          );
          showScreen('done');
        } else {
          showScreen('welcome');
        }
        loadHistory();
        break;
    }
  }

  async function init() {
    // 1. Hidratação rápida via chrome.storage.session (sem acordar SW)
    let hadSnapshot = false;
    try {
      const cached = await chrome.storage.session.get('flow_recorder_snapshot');
      const snap = cached.flow_recorder_snapshot || null;
      if (snap) {
        applyState(snap);
        hadSnapshot = true;
      }
    } catch (_) {}

    // 2. Reconciliar com SW (fonte de verdade)
    const fresh = await sendMessage({ type: 'GET_RECORDING_STATE' });
    if (fresh && typeof fresh.state === 'string') {
      applyState(fresh);
    } else if (!hadSnapshot) {
      showScreen('welcome');
      loadHistory();
    }
  }

  // Polling para atualizar contagem durante gravação
  setInterval(async () => {
    if (currentScreen !== 'recording') return;
    const response = await sendMessage({ type: 'GET_RECORDING_STATE' });
    if (response && response.state === 'recording') {
      stepCount = response.stepCount || 0;
      els.counterRecording.textContent = String(stepCount);
    }
  }, 800);

  init();
})();
