import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Announcements,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Eye, GripVertical, Trash2 } from 'lucide-react';
import { Empty } from '../../client/components';
import type { Model } from '../../shared/types';
import './models.css';

export interface ManagedModel extends Model {
  userIds: string[];
}
interface RowProps {
  model: ManagedModel;
  isDefault: boolean;
  disabled: boolean;
  onEdit: (model: ManagedModel) => void;
  onDelete: (model: ManagedModel) => void;
}
function ModelColumns() {
  return (
    <colgroup>
      {Array.from({ length: 7 }, (_, i) => (
        <col key={i} />
      ))}
    </colgroup>
  );
}
function ModelCells({
  model,
  isDefault,
  disabled,
  onEdit,
  onDelete,
  handle,
}: RowProps & { handle: ReactNode }) {
  return (
    <>
      <td className="models-sort-handle-cell">{handle}</td>
      <td className="models-sort-name">
        <strong>{model.label}</strong>
        {isDefault && <span className="badge">默认模型</span>}
        <small>{model.name}</small>
      </td>
      <td data-label="来源">{model.providerName}</td>
      <td data-label="能力">
        <span className="badge">
          {model.vision ? (
            <>
              <Eye size={12} />
              文字 + 图片
            </>
          ) : (
            '文字'
          )}
        </span>
      </td>
      <td data-label="授权">{model.userIds.length} 位用户</td>
      <td data-label="状态">
        <span className={`status ${model.enabled ? '' : 'off'}`}>
          {model.enabled ? '已启用' : '已停用'}
        </span>
      </td>
      <td className="models-sort-actions">
        <div className="row">
          <button
            type="button"
            className="button"
            disabled={disabled}
            onClick={() => onEdit(model)}
          >
            管理
          </button>
          <button
            type="button"
            className="icon-button"
            disabled={disabled}
            aria-label={`删除模型 ${model.label}`}
            onClick={() => onDelete(model)}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </td>
    </>
  );
}
function ModelRow(props: RowProps & { reducedMotion: boolean }) {
  const { model, disabled, reducedMotion } = props;
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: model.id,
    disabled,
    transition: reducedMotion ? null : { duration: 220, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
  });
  return (
    <tr
      ref={setNodeRef}
      data-model-id={model.id}
      className={`models-sort-row ${isDragging ? 'models-sort-dragging' : ''}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <ModelCells
        {...props}
        handle={
          <button
            ref={setActivatorNodeRef}
            type="button"
            className="icon-button models-sort-handle"
            {...attributes}
            {...listeners}
            disabled={disabled}
            aria-label={`拖动排序 ${model.label}`}
            title="拖动排序；键盘按空格选中，再用上下方向键移动"
          >
            <GripVertical size={18} aria-hidden="true" />
          </button>
        }
      />
    </tr>
  );
}

export function SortableModels({
  models,
  onOrder,
  onEdit,
  onDelete,
}: {
  models: ManagedModel[];
  onOrder: (ids: string[]) => Promise<void>;
  onEdit: RowProps['onEdit'];
  onDelete: RowProps['onDelete'];
}) {
  const [items, setItems] = useState(models);
  const [reducedMotion, setReducedMotion] = useState(
    () => matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [active, setActive] = useState<{ model: ManagedModel; width: number }>();
  const activeRef = useRef(false);
  const latest = useRef(models);
  latest.current = models;
  useEffect(() => {
    if (!savingRef.current && !activeRef.current) setItems(models);
  }, [models]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const defaultId = items.find((model) => model.enabled)?.id;
  const rowProps = { disabled: saving, onEdit, onDelete, reducedMotion };
  const label = (id: string | number) => items.find((m) => m.id === id)?.label ?? '模型';
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      `已选中 ${label(active.id)}，使用上下方向键移动，空格保存，Escape 取消。`,
    onDragOver: ({ active, over }) =>
      over
        ? `${label(active.id)} 移至第 ${items.findIndex((m) => m.id === over.id) + 1} 位。`
        : undefined,
    onDragEnd: ({ active, over }) =>
      over ? `${label(active.id)} 排序完成，正在保存。` : '排序已取消。',
    onDragCancel: () => '排序已取消。',
  };
  async function finish({ active, over }: DragEndEvent) {
    activeRef.current = false;
    setActive(undefined);
    if (!over || active.id === over.id || savingRef.current) {
      setItems(latest.current);
      return;
    }
    const from = items.findIndex((m) => m.id === active.id);
    const to = items.findIndex((m) => m.id === over.id);
    if (from < 0 || to < 0) return;
    const previous = items;
    const next = arrayMove(items, from, to);
    setItems(next);
    savingRef.current = true;
    setSaving(true);
    try {
      await onOrder(next.map((m) => m.id));
    } catch {
      setItems(latest.current === models ? previous : latest.current);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }
  return (
    <>
      <p className="muted small models-sort-help" role="status">
        {saving
          ? '正在保存排序…'
          : '拖动左侧手柄调整顺序；首个已启用模型为默认。用户无权使用时顺延，主动选择过的模型保持不变。'}
      </p>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        accessibility={{
          announcements,
          screenReaderInstructions: {
            draggable: '按空格开始排序，上下方向键移动，空格保存，Escape 取消。',
          },
        }}
        onDragStart={({ active, activatorEvent }) => {
          const model = items.find((m) => m.id === active.id);
          if (model) {
            activeRef.current = true;
            setActive({
              model,
              width:
                active.rect.current.initial?.width ??
                (activatorEvent.target as HTMLElement)?.closest('tr')?.getBoundingClientRect()
                  .width ??
                600,
            });
          }
        }}
        onDragCancel={() => {
          activeRef.current = false;
          setActive(undefined);
          setItems(latest.current);
        }}
        onDragEnd={(event) => {
          void finish(event);
        }}
      >
        <SortableContext items={items} strategy={verticalListSortingStrategy}>
          <div className="panel table-wrap models-sort-panel" aria-busy={saving}>
            <table className="models-sort-table" aria-label="模型管理与授权">
              <ModelColumns />
              <thead>
                <tr>
                  <th aria-label="排序" />
                  <th>模型 / 标识</th>
                  <th>来源</th>
                  <th>能力</th>
                  <th>授权用户</th>
                  <th>状态</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((model) => (
                  <ModelRow
                    key={model.id}
                    model={model}
                    isDefault={model.id === defaultId}
                    {...rowProps}
                  />
                ))}
              </tbody>
            </table>
            {!items.length && (
              <Empty title="白名单还是空的">从模型来源中探测模型，或使用右上角按钮手动添加。</Empty>
            )}
          </div>
        </SortableContext>
        {createPortal(
          <DragOverlay
            dropAnimation={
              reducedMotion ? null : { duration: 220, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
            }
          >
            {active && (
              <div
                className="models-sort-overlay"
                aria-hidden="true"
                style={{ width: active.width }}
              >
                <table className="models-sort-table">
                  <ModelColumns />
                  <tbody>
                    <tr className="models-sort-row">
                      <ModelCells
                        model={active.model}
                        isDefault={active.model.id === defaultId}
                        {...rowProps}
                        disabled
                        handle={
                          <span className="icon-button">
                            <GripVertical size={18} />
                          </span>
                        }
                      />
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
    </>
  );
}
