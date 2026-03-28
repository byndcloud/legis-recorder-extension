/**
 * Módulo de persistência do recording via chrome.storage.local.
 * Responsável por salvar/recuperar o recording de forma incremental,
 * garantindo resiliência contra crashes do service worker.
 *
 * Este módulo é um ES Module usado exclusivamente pelo Service Worker (background.js).
 */

const RECORDING_KEY = 'flow_recorder_current';
const STATE_KEY = 'flow_recorder_state';
const HISTORY_INDEX_KEY = 'flow_recorder_history_index';
const MAX_HISTORY = 10;

export class RecordingStorage {
  // =========================================================================
  // Gerenciamento de Estado
  // =========================================================================

  /**
   * Salva o estado atual da gravação (idle, recording, paused).
   * @param {string} state - Estado atual
   */
  async saveState(state) {
    try {
      await chrome.storage.local.set({ [STATE_KEY]: state });
    } catch (e) {
      console.error('[FlowRecorder] Erro ao salvar estado:', e);
    }
  }

  /**
   * Recupera o estado salvo da gravação.
   * @returns {string} Estado atual ('idle' se não houver estado salvo)
   */
  async getState() {
    try {
      const result = await chrome.storage.local.get(STATE_KEY);
      return result[STATE_KEY] || 'idle';
    } catch (e) {
      console.error('[FlowRecorder] Erro ao recuperar estado:', e);
      return 'idle';
    }
  }

  // =========================================================================
  // Gerenciamento do Recording
  // =========================================================================

  /**
   * Inicializa um novo recording no storage.
   * @param {Object} recording - Objeto recording inicial (sem steps)
   */
  async initRecording(recording) {
    try {
      await chrome.storage.local.set({ [RECORDING_KEY]: recording });
      console.log('[FlowRecorder] Recording inicializado no storage');
    } catch (e) {
      console.error('[FlowRecorder] Erro ao inicializar recording:', e);
    }
  }

  /**
   * Adiciona um step ao recording existente de forma incremental.
   * Atualiza também o total_steps nos metadados.
   * @param {Object} step - Objeto Step completo
   */
  async addStep(step) {
    try {
      const result = await chrome.storage.local.get(RECORDING_KEY);
      const recording = result[RECORDING_KEY];
      if (!recording) {
        console.warn('[FlowRecorder] Tentativa de adicionar step sem recording ativo');
        return;
      }

      recording.steps.push(step);
      recording.metadata.total_steps = recording.steps.length;

      await chrome.storage.local.set({ [RECORDING_KEY]: recording });
    } catch (e) {
      console.error('[FlowRecorder] Erro ao adicionar step:', e);
    }
  }

  /**
   * Atualiza campos dos metadados do recording.
   * @param {Object} updates - Campos a atualizar (merge parcial)
   */
  async updateMetadata(updates) {
    try {
      const result = await chrome.storage.local.get(RECORDING_KEY);
      const recording = result[RECORDING_KEY];
      if (!recording) return;

      Object.assign(recording.metadata, updates);
      await chrome.storage.local.set({ [RECORDING_KEY]: recording });
    } catch (e) {
      console.error('[FlowRecorder] Erro ao atualizar metadata:', e);
    }
  }

  /**
   * Recupera o recording completo do storage.
   * @returns {Object|null} Recording completo ou null se não houver
   */
  async getRecording() {
    try {
      const result = await chrome.storage.local.get(RECORDING_KEY);
      return result[RECORDING_KEY] || null;
    } catch (e) {
      console.error('[FlowRecorder] Erro ao recuperar recording:', e);
      return null;
    }
  }

  /**
   * Adiciona uma anotação timestamped ao recording.
   * As anotações ficam no array recording.annotations, cada uma com
   * o texto, timestamp ISO e elapsed_ms relativo ao início da gravação.
   * @param {Object} annotation - { text, timestamp, elapsed_ms }
   */
  async addAnnotation(annotation) {
    try {
      const result = await chrome.storage.local.get(RECORDING_KEY);
      const recording = result[RECORDING_KEY];
      if (!recording) return;

      // Garantir que o array existe (retrocompatível)
      if (!recording.annotations) recording.annotations = [];

      recording.annotations.push(annotation);
      await chrome.storage.local.set({ [RECORDING_KEY]: recording });
    } catch (e) {
      console.error('[FlowRecorder] Erro ao adicionar anotação:', e);
    }
  }

  /**
   * Limpa o recording e estado do storage.
   * Usado ao iniciar uma nova gravação.
   */
  async clearRecording() {
    try {
      await chrome.storage.local.remove([RECORDING_KEY, STATE_KEY]);
      console.log('[FlowRecorder] Recording limpo do storage');
    } catch (e) {
      console.error('[FlowRecorder] Erro ao limpar recording:', e);
    }
  }

  // =========================================================================
  // Histórico de gravações
  // =========================================================================

  /**
   * Arquiva o recording atual no histórico antes de descartá-lo.
   * Salva o recording completo em chave própria e atualiza o índice leve.
   * Mantém no máximo MAX_HISTORY gravações, removendo as mais antigas.
   */
  async archiveCurrentRecording() {
    try {
      const recording = await this.getRecording();
      if (!recording || !recording.steps || recording.steps.length === 0) return;

      const id = recording.recording_id;
      const recKey = `flow_recorder_rec_${id}`;

      // Salvar recording completo com chave individual
      await chrome.storage.local.set({ [recKey]: recording });

      // Atualizar índice leve
      const index = await this.getHistoryIndex();
      index.unshift({
        recording_id: id,
        created_at: recording.created_at,
        metadata: recording.metadata,
        annotations_count: (recording.annotations || []).length
      });

      // Remover excedentes
      if (index.length > MAX_HISTORY) {
        const removed = index.splice(MAX_HISTORY);
        for (const item of removed) {
          try {
            await chrome.storage.local.remove(`flow_recorder_rec_${item.recording_id}`);
          } catch (_) { /* ignora se chave já não existe */ }
        }
      }

      await chrome.storage.local.set({ [HISTORY_INDEX_KEY]: index });
      console.log('[FlowRecorder] Recording arquivado no histórico:', id);
    } catch (e) {
      console.error('[FlowRecorder] Erro ao arquivar recording:', e);
    }
  }

  /**
   * Retorna o índice leve do histórico (sem dados pesados).
   * @returns {Array} Lista de {recording_id, created_at, metadata}
   */
  async getHistoryIndex() {
    try {
      const result = await chrome.storage.local.get(HISTORY_INDEX_KEY);
      return result[HISTORY_INDEX_KEY] || [];
    } catch (e) {
      console.error('[FlowRecorder] Erro ao ler índice do histórico:', e);
      return [];
    }
  }

  /**
   * Carrega um recording completo do histórico por ID.
   * @param {string} recordingId
   * @returns {Object|null}
   */
  async loadRecordingById(recordingId) {
    try {
      const recKey = `flow_recorder_rec_${recordingId}`;
      const result = await chrome.storage.local.get(recKey);
      return result[recKey] || null;
    } catch (e) {
      console.error('[FlowRecorder] Erro ao carregar recording do histórico:', e);
      return null;
    }
  }

  /**
   * Remove um recording do histórico (índice + dados).
   * @param {string} recordingId
   */
  async deleteRecordingById(recordingId) {
    try {
      await chrome.storage.local.remove(`flow_recorder_rec_${recordingId}`);
      const index = await this.getHistoryIndex();
      const filtered = index.filter(i => i.recording_id !== recordingId);
      await chrome.storage.local.set({ [HISTORY_INDEX_KEY]: filtered });
      console.log('[FlowRecorder] Recording removido do histórico:', recordingId);
    } catch (e) {
      console.error('[FlowRecorder] Erro ao remover recording do histórico:', e);
    }
  }
}
