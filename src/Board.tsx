import { useState, type CSSProperties } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDroppable,
  pointerWithin,
  closestCorners,
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

function CardContent({ task, done }: { task: Task; done: boolean }) {
  const overdue =
    task.due_date &&
    !done &&
    task.due_date < new Date().toLocaleDateString("sv-SE");
  return (
    <>
      <span className="card-title">{task.title}</span>
      {task.description && (
        <span className="card-description">{task.description}</span>
      )}
      {task.latest_post && (
        <span className="card-latest">
          <span className="card-latest-label">Senaste inlägg</span>
          <span className="line-clamp-2">{task.latest_post}</span>
        </span>
      )}
      <span className="card-meta">
        {task.priority !== "normal" && (
          <span className={`priority ${task.priority}`}>
            {task.priority === "high" ? "↑ " : "↓ "}
            {priorities[task.priority]}
          </span>
        )}
        {task.due_date && (
          <span className={`deadline ${overdue ? "overdue" : ""}`}>
            <time dateTime={task.due_date}>
              {new Date(`${task.due_date}T12:00:00`).toLocaleDateString(
                "sv-SE",
                { day: "numeric", month: "short" },
              )}
            </time>
          </span>
        )}
        {task.post_count > 0 && (
          <span className="post-count">
            {task.post_count} {task.post_count === 1 ? "inlägg" : "inlägg"}
          </span>
        )}
      </span>
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
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id, disabled });
  return (
    <article
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`task-card group ${isDragging ? "dragging" : ""}`}
      data-task-id={task.id}
    >
      <button
        className="card-open"
        onClick={() => onEdit(task)}
        aria-label={`Redigera ${task.title}`}
      >
        <CardContent task={task} done={done} />
      </button>
      {task.child_board && (
        <button
          className="child-board-link"
          onClick={() => onOpenBoard(task.child_board!.id)}
        >
          Scrum · {task.child_board.done_count}/{task.child_board.task_count}{" "}
          klara →
        </button>
      )}
      <button
        className="drag-handle"
        {...attributes}
        {...listeners}
        aria-label={`Dra ${task.title}`}
        title="Dra för att flytta. Tangentbord: mellanslag, piltangenter, mellanslag."
        disabled={disabled}
      >
        <svg
          width="14"
          height="18"
          viewBox="0 0 14 18"
          fill="currentColor"
          aria-hidden="true"
        >
          {[5, 9, 13].flatMap((y) =>
            [5, 9].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1" />),
          )}
        </svg>
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
        <h2 className="flex items-center gap-2.5 text-sm font-semibold min-w-0">
          <span
            className={`column-dot ${column.is_done ? "done" : column.key === "in_progress" ? "in_progress" : ""}`}
          />
          <span className="truncate" title={column.description || column.name}>
            {column.name}
          </span>
          <span className="count">{tasks.length}</span>
        </h2>
        <div className="flex shrink-0">
          <button
            className="icon-button small"
            aria-label={`Redigera kolumn ${column.name}`}
            onClick={() => onColumnEdit(column)}
          >
            ···
          </button>
          <button
            className="icon-button small"
            disabled={creationDisabled}
            aria-label={`Ny uppgift i ${column.name}`}
            onClick={() => onCreate(column.id)}
          >
            +
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
        {!tasks.length && <div className="empty-column">Inga uppgifter</div>}
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
  onOpenBoard: (id: string) => void;
  creationDisabled?: boolean;
  disabled: boolean;
}) {
  const [active, setActive] = useState<Task>();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
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
        return hits.length ? hits : closestCorners(args);
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
