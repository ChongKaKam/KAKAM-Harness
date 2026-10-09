import { useState } from 'react';
import { Modal } from '../../client/components';
import type { Model, ReasoningEffort } from '../../shared/types';
import { ModelPicker } from './model-picker';
import './regenerate-dialog.css';

export function RegenerateDialog({
  models,
  modelId,
  effort,
  disabled,
  close,
  confirm,
}: {
  models: Model[];
  modelId: string;
  effort: ReasoningEffort;
  disabled: boolean;
  close: () => void;
  confirm: (modelId: string, effort: ReasoningEffort) => void;
}) {
  const [selectedId, setSelectedId] = useState(modelId);
  const [selectedEffort, setSelectedEffort] = useState(effort);
  const available = models.some((model) => model.id === selectedId);
  return (
    <Modal title="再次生成回复" close={close} className="chat-regenerate-dialog">
      <p className="chat-regenerate-description">
        使用原提问再次生成，可更换模型与思考程度。将替换最后一条回复，原调用用量仍保留在统计中。
      </p>
      <ModelPicker
        models={models}
        modelId={selectedId}
        effort={selectedEffort}
        disabled={disabled}
        onModel={setSelectedId}
        onEffort={setSelectedEffort}
      />
      <div className="modal-actions">
        <button type="button" className="button" onClick={close}>
          取消
        </button>
        <button
          type="button"
          className="button primary"
          disabled={disabled || !available}
          onClick={() => confirm(selectedId, selectedEffort)}
        >
          开始生成
        </button>
      </div>
    </Modal>
  );
}
