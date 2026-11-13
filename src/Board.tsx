import { useState, type CSSProperties } from "react";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDroppable,
  pointerWithin,
  closestCorners,
  rectIntersection,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  priorities,
  type Task,
  type Column as BoardColumn,
} from "../shared/schema.js";
import { Icon } from "./Icon.js";

function CardContent({ task, done }: { task: Task; done: boolean }) {
  const overdue =
    task.due_date &&
    !done &&
    task.due_date < new Date().toLocaleDateString("sv-SE");
  const hasMeta =
    task.priority !== "normal" ||
    task.due_date ||
    task.post_count > 0 ||
    task.urgency_score !== undefined;
  return (
    <>
      <span className="card-title">{task.title}</span>
      {task.description && (
        <span className="card-description">{task.description}</span>
      )}
      {hasMeta && (
        <span className="card-meta">
          {task.urgency_score !== undefined && (
            <span
              className={`urgency-score ${task.urgency_score >= 75 ? "urgent" : ""}`}
              title={`${task.source_count ?? 0} kopplade mejl/kalenderobjekt`}
            >
              {task.urgency_score}%
            </span>
          )}
          {task.priority !== "normal" && (
            <span className={`priority ${task.priority}`}>
              <Icon name={task.priority === "high" ? "up" : "down"} size={14} />
              {priorities[task.priority]}
            </span>
          )}
          {task.due_date && (
            <span className={`deadline ${overdue ? "overdue" : ""}`}>
              <Icon name="calendar" size={14} />
              <time dateTime={task.due_date}>
                {new Date(`${task.due_date}T12:00:00`).toLocaleDateString(
                  "sv-SE",
                  { day: "numeric", month: "short" },
                )}
              </time>
              {overdue && <span className="sr-only">, försenad</span>}
            </span>
          )}
          {task.post_count > 0 && (
            <span className="post-count">
              <Icon name="comment" size={14} />
              {task.post_count}
              <span className="sr-only"> inlägg</span>
            </span>
          )}
        </span>
      )}
    </>
  );
}
function Card({
  task,
  done,
  onEdit,
  onOpenBoard,
  disabled,
}: {
  task: Task;
  done: boolean;
  onEdit: (task: Task) => void;
  onOpenBoard: (id: string) => void;
  disabled: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id, disabled });
  // Mouse and touch drag the whole card; the keyboard drags via the handle so
  // Enter/Space on the card still opens it.
  const { onKeyDown, ...pointer } = listeners ?? {};
  const child = task.child_board;
  return (
    <article
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`task-card ${isDragging ? "dragging" : ""}`}
      data-task-id={task.id}
      {...pointer}
      onContextMenu={(e) => {
        // Long-press starts a drag on touch screens; keep the context menu out of the way.
        if ((e.nativeEvent as PointerEvent).pointerType === "touch")
          e.preventDefault();
      }}
    >
      <button
        className="card-open"
        onClick={() => onEdit(task)}
        aria-label={`Öppna ${task.title}`}
      >
        <CardContent task={task} done={done} />
      </button>
      {child && (
        <button
          className="child-board-link"
          onClick={() => onOpenBoard(child.id)}
        >
          <span>Scrum-tavla</span>
          <span className="child-progress" aria-hidden="true">
            <span
              style={{
                width: `${child.task_count ? (child.done_count / child.task_count) * 100 : 0}%`,
              }}
            />
          </span>
          <span>
            {child.done_count}/{child.task_count}
            <span className="sr-only"> klara</span>
          </span>
        </button>
      )}
      <button
        ref={setActivatorNodeRef}
        className="drag-handle"
        {...attributes}
        onKeyDown={onKeyDown as React.KeyboardEventHandler | undefined}
        aria-label={`Flytta ${task.title}`}
        disabled={disabled}
      >
        <Icon name="grip" size={16} />
      </button>
    </article>
  );
}
function Column({
  column,
  tasks,
  onEdit,
  onCreate,
  onColumnEdit,
  onOpenBoard,
  creationDisabled,
  disabled,
}: {
  column: BoardColumn;
  tasks: Task[];
  onEdit: (task: Task) => void;
  onCreate: (id: string) => void;
  onColumnEdit: (column: BoardColumn) => void;
  onOpenBoard: (id: string) => void;
  creationDisabled?: boolean;
  disabled: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  return (
    <section
      className={`column ${isOver ? "column-over" : ""}`}
      aria-label={column.name}
      data-column={column.id}
      data-column-key={column.key}
    >
      <header className="column-header">
        <h2>
          <span
            className={`column-dot ${column.is_done ? "done" : column.key === "in_progress" ? "in_progress" : ""}`}
            aria-hidden="true"
          />
          <span className="column-name">{column.name}</span>
          <span className="count">{tasks.length}</span>
        </h2>
        <div className="column-actions">
          <button
            className="icon-button"
            data-tip="Redigera kolumn"
            data-tip-end=""
            aria-label={`Redigera kolumn ${column.name}`}
            onClick={() => onColumnEdit(column)}
          >
            <Icon name="more" />
          </button>
          <button
            className="icon-button"
            data-tip="Ny uppgift"
            data-tip-end=""
            disabled={creationDisabled}
            aria-label={`Ny uppgift i ${column.name}`}
            onClick={() => onCreate(column.id)}
          >
            <Icon name="plus" />
          </button>
        </div>
      </header>
      {column.description && (
        <p className="column-description">{column.description}</p>
      )}
      <div ref={setNodeRef} className="column-cards">
        <SortableContext
          items={tasks.map((task) => task.id)}
          strategy={verticalListSortingStrategy}
        >
          {tasks.map((task) => (
            <Card
              key={task.id}
              task={task}
              done={column.is_done}
              onEdit={onEdit}
              onOpenBoard={onOpenBoard}
              disabled={disabled}
            />
          ))}
        </SortableContext>
        {!tasks.length && <p className="empty-column">Inga uppgifter</p>}
      </div>
    </section>
  );
}
export function Board({
  tasks,
  columns,
  onEdit,
  onCreate,
  onMove,
  onColumnEdit,
  onAddColumn,
  onOpenBoard,
  creationDisabled,
  disabled,
}: {
  tasks: Task[];
  columns: BoardColumn[];
  onEdit: (task: Task) => void;
  onCreate: (id: string) => void;
  onMove: (id: string, columnId: string, position: number) => void;
  onColumnEdit: (column: BoardColumn) => void;
  onAddColumn: () => void;
  onOpenBoard: (id: string) => void;
  creationDisabled?: boolean;
  disabled: boolean;
}) {
  const [active, setActive] = useState<Task>();
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    // Press and hold to drag on touch, so a swipe still scrolls the board.
    useSensor(TouchSensor, {
      activationConstraint: { delay: 220, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: (event, args) => {
        const { collisionRect, droppableRects } = args.context;
        if (collisionRect && ["ArrowLeft", "ArrowRight"].includes(event.code)) {
          // Small edge differences between the overlay and its lane must not
          // make the current column a horizontal keyboard destination.
          const otherColumns = new Map(droppableRects);
          for (const [id, rect] of otherColumns) {
            if (Math.abs(rect.left - collisionRect.left) < 2)
              otherColumns.delete(id);
          }
          return sortableKeyboardCoordinates(event, {
            ...args,
            context: { ...args.context, droppableRects: otherColumns },
          });
        }
        return sortableKeyboardCoordinates(event, args);
      },
    }),
  );
  function drop(event: DragEndEvent) {
    setActive(undefined);
    const task = tasks.find((t) => t.id === event.active.id);
    if (!task || !event.over || event.over.id === task.id) return;
    const target = tasks.find((t) => t.id === event.over!.id),
      columnId = target?.column_id ?? String(event.over.id);
    if (!columns.some((c) => c.id === columnId)) return;
    const inColumn = tasks.filter((t) => t.column_id === columnId);
    let position = target
      ? inColumn.findIndex((t) => t.id === target.id)
      : inColumn.filter((t) => t.id !== task.id).length;
    if (target && columnId !== task.column_id) {
      const rect = event.active.rect.current.translated;
      if (
        rect &&
        rect.top + rect.height / 2 >
          event.over.rect.top + event.over.rect.height / 2
      )
        position++;
    }
    onMove(task.id, columnId, position);
  }
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={(args) => {
        const hits = pointerWithin(args);
        if (hits.length) return hits;
        // Keyboard dragging has no pointer. Prefer the lane actually intersected
        // by the card, so a tall empty lane beats the card's original position.
        const intersections = rectIntersection(args);
        return intersections.length ? intersections : closestCorners(args);
      }}
      onDragStart={(event) =>
        setActive(tasks.find((t) => t.id === event.active.id))
      }
      onDragCancel={() => setActive(undefined)}
      onDragEnd={drop}
      accessibility={{
        screenReaderInstructions: {
          draggable:
            "Mellanslag plockar upp, piltangenter flyttar och mellanslag släpper. Escape avbryter.",
        },
      }}
    >
      <div
        className="board"
        style={{ "--column-count": columns.length } as CSSProperties}
      >
        {columns.map((column) => (
          <Column
            key={column.id}
            column={column}
            tasks={tasks.filter((t) => t.column_id === column.id)}
            onEdit={onEdit}
            onCreate={onCreate}
            onColumnEdit={onColumnEdit}
            onOpenBoard={onOpenBoard}
            creationDisabled={creationDisabled}
            disabled={disabled}
          />
        ))}
        <div className="add-column">
          <button className="button ghost" onClick={onAddColumn}>
            <Icon name="plus" size={16} />
            Ny kolumn
          </button>
        </div>
      </div>
      <DragOverlay dropAnimation={null}>
        {active && (
          <div className="task-card drag-overlay">
            <div className="card-open">
              <CardContent
                task={active}
                done={!!columns.find((c) => c.id === active.column_id)?.is_done}
              />
            </div>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
