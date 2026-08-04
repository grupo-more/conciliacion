"use client";

export function Pager({
  page,
  total,
  pageSize,
  onPage,
}: {
  page: number;
  total: number;
  pageSize: number;
  onPage: (p: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap text-sm">
      <span className="text-text-muted">
        Mostrando <strong>{(page * pageSize + 1).toLocaleString("es-CL")}</strong>–
        <strong>{Math.min(total, (page + 1) * pageSize).toLocaleString("es-CL")}</strong> de{" "}
        <strong>{total.toLocaleString("es-CL")}</strong>
      </span>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onPage(Math.max(0, page - 1))}
          disabled={page === 0}
          className="rounded-md border border-border-soft px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-bg-soft"
        >
          ← Anterior
        </button>
        <span className="text-text-muted whitespace-nowrap">
          Página {page + 1} de {totalPages}
        </span>
        <button
          onClick={() => onPage(page + 1)}
          disabled={page + 1 >= totalPages}
          className="rounded-md border border-border-soft px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-bg-soft"
        >
          Siguiente →
        </button>
      </div>
    </div>
  );
}
