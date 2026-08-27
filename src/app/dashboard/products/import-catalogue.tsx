"use client";

import { useState } from "react";
import { parseCsvPreview, extractPastedTextPreview, confirmImport } from "./import-actions";
import type { ImportRowPreview } from "@/lib/catalogue-import";
import { Surface } from "@/components/ui";

type Source = "csv" | "pasted_text";
type Status = "idle" | "parsing" | "previewing" | "confirming" | "done" | "error";

export function ImportCatalogue() {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<Source>("csv");
  const [pastedText, setPastedText] = useState("");
  const [rows, setRows] = useState<ImportRowPreview[]>([]);
  const [unmappedColumns, setUnmappedColumns] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handleCsvFile(file: File) {
    setStatus("parsing");
    setMessage(null);
    setSource("csv");
    try {
      const text = await file.text();
      const preview = await parseCsvPreview(text);
      setRows(preview.rows);
      setUnmappedColumns(preview.unmappedColumns);
      setStatus("previewing");
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Could not parse the CSV file.");
    }
  }

  async function handleExtractPasted() {
    if (!pastedText.trim()) return;
    setStatus("parsing");
    setMessage(null);
    setSource("pasted_text");
    try {
      const preview = await extractPastedTextPreview(pastedText);
      setRows(preview.rows);
      setUnmappedColumns(preview.unmappedColumns);
      setStatus("previewing");
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Could not extract products from that text.");
    }
  }

  function updateRow(index: number, patch: Partial<ImportRowPreview>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch, error: null } : r)));
  }

  async function handleConfirm() {
    setStatus("confirming");
    setMessage(null);
    try {
      const result = await confirmImport(source, rows);
      setStatus("done");
      setMessage(`Imported ${result.rowsImported} of ${result.rowsParsed} rows (${result.rowsSkipped} skipped).`);
      setRows([]);
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Import failed.");
    }
  }

  function reset() {
    setRows([]);
    setUnmappedColumns([]);
    setPastedText("");
    setStatus("idle");
    setMessage(null);
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-sm px-3 py-2 rounded-[var(--radius)] bg-ink-overlay border border-ink-line text-on-ink hover:border-on-ink-faint transition-colors duration-[var(--dur-fast)]"
      >
        Import catalogue
      </button>
    );
  }

  const errorCount = rows.filter((r) => r.error).length;

  return (
    <Surface variant="raised" className="p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[var(--t-h4)] font-medium text-on-ink">Import catalogue</h2>
        <button
          onClick={() => {
            setOpen(false);
            reset();
          }}
          className="text-sm text-on-ink-faint hover:text-on-ink transition-colors"
        >
          Close
        </button>
      </div>

      {status === "idle" && (
        <div className="space-y-4 text-sm">
          <div>
            <label className="flex flex-col gap-1.5">
              <span className="text-on-ink-dim font-medium">Upload a CSV</span>
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleCsvFile(file);
                }}
                className="text-sm text-on-ink-dim file:mr-3 file:py-1.5 file:px-3 file:rounded-[var(--radius)] file:border file:border-ink-line file:bg-ink-overlay file:text-on-ink file:text-sm"
              />
            </label>
            <p className="text-xs text-on-ink-faint mt-1.5">
              Columns are matched by name (e.g. &quot;price&quot;, &quot;Price (INR)&quot;, &quot;SKU&quot;). Parsed in code, never sent to a model.
            </p>
          </div>

          <div className="border-t border-ink-line pt-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-on-ink-dim font-medium">Or paste a product list</span>
              <textarea
                rows={5}
                value={pastedText}
                onChange={(e) => setPastedText(e.target.value)}
                placeholder="Paste a product list from your website, a supplier email, or anywhere else..."
                className="w-full rounded-[var(--radius)] bg-ink-overlay border border-ink-line px-3 py-2 text-sm text-on-ink placeholder:text-on-ink-faint outline-none focus:border-accent focus:ring-1 focus:ring-accent/40"
                maxLength={20_000}
              />
            </label>
            <button
              onClick={handleExtractPasted}
              disabled={!pastedText.trim()}
              className="mt-2 px-3 py-2 rounded-[var(--radius)] bg-accent text-accent-ink hover:bg-accent-bright disabled:opacity-50 text-sm font-medium transition-colors duration-[var(--dur-fast)]"
            >
              Extract products
            </button>
            <p className="text-xs text-on-ink-faint mt-1.5">
              A model reads this and proposes rows below — nothing is saved until you review and confirm.
            </p>
          </div>
        </div>
      )}

      {status === "parsing" && (
        <p className="text-sm text-on-ink-dim flex items-center gap-2">
          <span className="h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin" aria-hidden="true" />
          Reading…
        </p>
      )}

      {(status === "previewing" || status === "confirming") && (
        <div className="space-y-3">
          {unmappedColumns.length > 0 && (
            <p className="text-xs text-escalate-bright bg-escalate-wash border border-escalate-line rounded-[var(--radius)] px-3 py-2">
              Unmapped columns (ignored): {unmappedColumns.join(", ")}
            </p>
          )}
          {errorCount > 0 && (
            <p className="text-xs text-deny-bright bg-deny-wash border border-deny-line rounded-[var(--radius)] px-3 py-2">
              {errorCount} row(s) have errors and will be skipped unless corrected below.
            </p>
          )}
          <p className="text-sm text-on-ink-dim">
            {rows.length} row(s) parsed. Review — especially prices, shown in rupees — then confirm.
          </p>
          <div className="overflow-x-auto rounded-[var(--radius-lg)] border border-ink-line">
            <table className="w-full text-xs border-collapse">
              <thead className="bg-ink-overlay">
                <tr>
                  <th className="text-left p-2 text-on-ink-faint font-medium uppercase tracking-[0.06em] text-[var(--t-label)]">Name</th>
                  <th className="text-left p-2 text-on-ink-faint font-medium uppercase tracking-[0.06em] text-[var(--t-label)]">SKU</th>
                  <th className="text-left p-2 text-on-ink-faint font-medium uppercase tracking-[0.06em] text-[var(--t-label)]">Price (₹)</th>
                  <th className="text-left p-2 text-on-ink-faint font-medium uppercase tracking-[0.06em] text-[var(--t-label)]">Cost (₹)</th>
                  <th className="text-left p-2 text-on-ink-faint font-medium uppercase tracking-[0.06em] text-[var(--t-label)]">Stock</th>
                  <th className="text-left p-2 text-on-ink-faint font-medium uppercase tracking-[0.06em] text-[var(--t-label)]">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i} className={`border-t border-ink-line-soft ${row.error ? "bg-deny-wash" : ""}`}>
                    <td className="p-1">
                      <input
                        value={row.name}
                        onChange={(e) => updateRow(i, { name: e.target.value })}
                        className="border border-ink-line bg-ink rounded-[var(--radius-sm)] px-2 py-1 w-32 text-on-ink outline-none focus:border-accent"
                      />
                    </td>
                    <td className="p-1">
                      <input
                        value={row.sku}
                        onChange={(e) => updateRow(i, { sku: e.target.value })}
                        className="border border-ink-line bg-ink rounded-[var(--radius-sm)] px-2 py-1 w-24 text-on-ink outline-none focus:border-accent font-mono"
                      />
                    </td>
                    <td className="p-1">
                      <input
                        type="number"
                        step="0.01"
                        value={row.priceRupees}
                        onChange={(e) => updateRow(i, { priceRupees: Number(e.target.value) })}
                        className="border border-ink-line bg-ink rounded-[var(--radius-sm)] px-2 py-1 w-20 text-on-ink outline-none focus:border-accent font-mono tabular-nums"
                      />
                    </td>
                    <td className="p-1">
                      <input
                        type="number"
                        step="0.01"
                        value={row.costRupees}
                        onChange={(e) => updateRow(i, { costRupees: Number(e.target.value) })}
                        className="border border-ink-line bg-ink rounded-[var(--radius-sm)] px-2 py-1 w-20 text-on-ink outline-none focus:border-accent font-mono tabular-nums"
                      />
                    </td>
                    <td className="p-1">
                      <input
                        type="number"
                        step="1"
                        value={row.stock}
                        onChange={(e) => updateRow(i, { stock: Number(e.target.value) })}
                        className="border border-ink-line bg-ink rounded-[var(--radius-sm)] px-2 py-1 w-16 text-on-ink outline-none focus:border-accent font-mono tabular-nums"
                      />
                    </td>
                    <td className="p-1 text-deny-bright font-mono">{row.error ?? "OK"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* The confirm step stays structurally distinct from the preview above — a
              separate, visually emphasised action, never folded into the same flow. */}
          <div className="flex gap-2 pt-1">
            <button
              onClick={handleConfirm}
              disabled={status === "confirming"}
              className="px-4 py-2 rounded-[var(--radius)] bg-allow text-ink hover:bg-allow-bright disabled:opacity-50 text-sm font-medium transition-colors duration-[var(--dur-fast)]"
            >
              {status === "confirming" ? "Importing…" : `Confirm — import ${rows.filter((r) => !r.error).length} row(s)`}
            </button>
            <button
              onClick={reset}
              className="px-3 py-2 rounded-[var(--radius)] border border-ink-line text-on-ink-dim hover:text-on-ink text-sm transition-colors duration-[var(--dur-fast)]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {status === "done" && (
        <div className="space-y-2">
          <p className="text-sm text-allow-bright">{message}</p>
          <button
            onClick={reset}
            className="text-sm px-3 py-2 rounded-[var(--radius)] border border-ink-line text-on-ink-dim hover:text-on-ink transition-colors duration-[var(--dur-fast)]"
          >
            Import more
          </button>
        </div>
      )}

      {status === "error" && (
        <div className="space-y-2">
          <p className="text-sm text-deny-bright">{message}</p>
          <button
            onClick={reset}
            className="text-sm px-3 py-2 rounded-[var(--radius)] border border-ink-line text-on-ink-dim hover:text-on-ink transition-colors duration-[var(--dur-fast)]"
          >
            Try again
          </button>
        </div>
      )}
    </Surface>
  );
}
