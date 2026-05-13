/**
 * Módulo de persistência do recording via chrome.storage.local.
 *
 * Storage layout (split storage para evitar O(N²) writes):
 *  - `flow_recorder_current_meta` — metadata + annotations do recording ativo
 *    (NÃO contém steps; só contadores). Pequeno e regravado a cada step.
 *  - `flow_recorder_step_<recording_id>_<index>` — cada step em chave própria.
 *    Escrito UMA vez quando criado, nunca re-escrito.
 *  - `flow_recorder_rec_<recording_id>` — recording completo arquivado em
 *    histórico (steps inline, leitura única no viewer).
 *
 * Compatibilidade retro: se existir chave antiga `flow_recorder_current`
 * com steps embutidos, é migrada pra novo layout no primeiro `_getCurrentMeta`.
 */

const RECORDING_KEY = 'flow_recorder_current'; // legado (migração)
const CURRENT_META_KEY = 'flow_recorder_current_meta';
const STATE_KEY = 'flow_recorder_state';
const HISTORY_INDEX_KEY = 'flow_recorder_history_index';
const MAX_HISTORY = 10;

function _stepKey(recordingId, index) {
  return `flow_recorder_step_${recordingId}_${index}`;
}

export class RecordingStorage {
  // =========================================================================
  // Gerenciamento de Estado
  // =========================================================================

  async saveState(state) {
    try {
      await chrome.storage.local.set({ [STATE_KEY]: state });
    } catch (e) {
      console.error('[FlowRecorder] Erro ao salvar estado:', e);
    }
  }

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
  // Meta do recording ativo (lightweight)
  // =========================================================================

  /**
   * Lê o meta do recording ativo. Migra legado se necessário.
   * @returns {Promise<Object|null>}
   */
  async _getCurrentMeta() {
    try {
      const result = await chrome.storage.local.get([CURRENT_META_KEY, RECORDING_KEY]);
      const meta = result[CURRENT_META_KEY];
      if (meta) return meta;

      // Migração: chave antiga existe com steps embutidos
      const legacy = result[RECORDING_KEY];
      if (legacy && legacy.recording_id) {
        return await this._migrateLegacy(legacy);
      }
      return null;
    } catch (e) {
      console.error('[FlowRecorder] Erro ao ler meta:', e);
      return null;
    }
  }

  /**
   * Migra recording em formato antigo (steps inline) pro novo layout split.
   */
  async _migrateLegacy(legacy) {
    try {
      const steps = Array.isArray(legacy.steps) ? legacy.steps : [];
      const writes = {};
      for (let i = 0; i < steps.length; i++) {
        writes[_stepKey(legacy.recording_id, i)] = steps[i];
      }
      const meta = {
        recording_id: legacy.recording_id,
        created_at: legacy.created_at,
        metadata: {
          ...legacy.metadata,
          total_steps: steps.length
        },
        annotations: legacy.annotations || []
      };
      writes[CURRENT_META_KEY] = meta;
      await chrome.storage.local.set(writes);
      await chrome.storage.local.remove(RECORDING_KEY);
      console.log('[FlowRecorder] Recording legado migrado pro novo layout:', steps.length, 'steps');
      return meta;
    } catch (e) {
      console.error('[FlowRecorder] Erro na migração legado:', e);
      return null;
    }
  }

  // =========================================================================
  // Gerenciamento do Recording
  // =========================================================================

  /**
   * Inicializa um novo recording (escreve só o meta).
   * @param {Object} recording - {recording_id, created_at, metadata, annotations}
   */
  async initRecording(recording) {
    try {
      const meta = {
        recording_id: recording.recording_id,
        created_at: recording.created_at,
        metadata: { ...recording.metadata, total_steps: 0 },
        annotations: recording.annotations || []
      };
      await chrome.storage.local.set({ [CURRENT_META_KEY]: meta });
      console.log('[FlowRecorder] Recording inicializado (split storage)');
    } catch (e) {
      console.error('[FlowRecorder] Erro ao inicializar recording:', e);
    }
  }

  /**
   * Adiciona um step em chave própria. O(1) — não re-escreve steps anteriores.
   * @param {Object} step - Step completo
   */
  async addStep(step) {
    try {
      const meta = await this._getCurrentMeta();
      if (!meta) {
        console.warn('[FlowRecorder] Tentativa de adicionar step sem recording ativo');
        return;
      }

      // Usar step_index do próprio step (já vem do background com stepCount atual)
      const index = step.step_index != null ? step.step_index : (meta.metadata.total_steps || 0);
      meta.metadata.total_steps = Math.max(meta.metadata.total_steps || 0, index + 1);

      // Escrita única: o step novo + meta atualizado (sem steps anteriores)
      await chrome.storage.local.set({
        [_stepKey(meta.recording_id, index)]: step,
        [CURRENT_META_KEY]: meta
      });
    } catch (e) {
      console.error('[FlowRecorder] Erro ao adicionar step:', e);
    }
  }

  /**
   * Atualiza campos dos metadados (merge parcial).
   */
  async updateMetadata(updates) {
    try {
      const meta = await this._getCurrentMeta();
      if (!meta) return;
      Object.assign(meta.metadata, updates);
      await chrome.storage.local.set({ [CURRENT_META_KEY]: meta });
    } catch (e) {
      console.error('[FlowRecorder] Erro ao atualizar metadata:', e);
    }
  }

  /**
   * Reassembla o recording completo (meta + todos os steps).
   * Lê os steps em batch via chrome.storage.local.get.
   * @returns {Object|null}
   */
  async getRecording() {
    try {
      const meta = await this._getCurrentMeta();
      if (!meta) return null;
      const total = meta.metadata.total_steps || 0;
      if (total === 0) {
        return { ...meta, steps: [] };
      }
      const keys = [];
      for (let i = 0; i < total; i++) {
        keys.push(_stepKey(meta.recording_id, i));
      }
      const result = await chrome.storage.local.get(keys);
      const steps = keys.map(k => result[k]).filter(Boolean);
      return { ...meta, steps };
    } catch (e) {
      console.error('[FlowRecorder] Erro ao recuperar recording:', e);
      return null;
    }
  }

  /**
   * Retorna só o meta (sem ler steps). Use pra checks rápidos como
   * `hasRecording` ou `total_steps`.
   * @returns {Object|null}
   */
  async getMetaOnly() {
    return this._getCurrentMeta();
  }

  /**
   * Adiciona uma anotação. Anotações são pequenas e ficam inline no meta.
   */
  async addAnnotation(annotation) {
    try {
      const meta = await this._getCurrentMeta();
      if (!meta) return;
      if (!meta.annotations) meta.annotations = [];
      meta.annotations.push(annotation);
      await chrome.storage.local.set({ [CURRENT_META_KEY]: meta });
    } catch (e) {
      console.error('[FlowRecorder] Erro ao adicionar anotação:', e);
    }
  }

  /**
   * Remove meta + todos os step keys do recording ativo.
   */
  async clearRecording() {
    try {
      const meta = await this._getCurrentMeta();
      const keysToRemove = [CURRENT_META_KEY, STATE_KEY, RECORDING_KEY];
      if (meta) {
        const total = meta.metadata.total_steps || 0;
        for (let i = 0; i < total; i++) {
          keysToRemove.push(_stepKey(meta.recording_id, i));
        }
      }
      await chrome.storage.local.remove(keysToRemove);
      console.log('[FlowRecorder] Recording limpo do storage');
    } catch (e) {
      console.error('[FlowRecorder] Erro ao limpar recording:', e);
    }
  }

  // =========================================================================
  // Histórico de gravações
  // =========================================================================

  /**
   * Arquiva o recording atual no histórico. Reassembla steps e salva inline
   * em chave única (`flow_recorder_rec_<id>`) — uma escrita grande no fim,
   * mas evita N reads no viewer.
   */
  async archiveCurrentRecording() {
    try {
      const recording = await this.getRecording();
      if (!recording || !recording.steps || recording.steps.length === 0) return;

      const id = recording.recording_id;
      const recKey = `flow_recorder_rec_${id}`;

      await chrome.storage.local.set({ [recKey]: recording });

      const index = await this.getHistoryIndex();
      index.unshift({
        recording_id: id,
        created_at: recording.created_at,
        metadata: recording.metadata,
        annotations_count: (recording.annotations || []).length
      });

      if (index.length > MAX_HISTORY) {
        const removed = index.splice(MAX_HISTORY);
        for (const item of removed) {
          try {
            await chrome.storage.local.remove(`flow_recorder_rec_${item.recording_id}`);
          } catch (_) { /* ignora */ }
        }
      }

      await chrome.storage.local.set({ [HISTORY_INDEX_KEY]: index });
      console.log('[FlowRecorder] Recording arquivado no histórico:', id);
    } catch (e) {
      console.error('[FlowRecorder] Erro ao arquivar recording:', e);
    }
  }

  async getHistoryIndex() {
    try {
      const result = await chrome.storage.local.get(HISTORY_INDEX_KEY);
      return result[HISTORY_INDEX_KEY] || [];
    } catch (e) {
      console.error('[FlowRecorder] Erro ao ler índice do histórico:', e);
      return [];
    }
  }

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
