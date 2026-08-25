"use client";

import { useState } from "react";
import { parseCsvPreview, extractPastedTextPreview, confirmImport } from "./import-actions";
import type { ImportRowPreview } from "@/lib/catalogue-import";

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
      <button onClick={() => setOpen(true)} className="text-sm px-3 py-2 rounded border hover:bg-gray-50">
        Import catalogue
      </button>
    );
  }

  const errorCount = rows.filter((r) => r.error).length;

  return (
    <section className="border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">Import catalogue</h2>
        <button
          onClick={() => {
            setOpen(false);
            reset();
          }}
          className="text-sm text-gray-500 hover:text-gray-800"
        >
          Close
        </button>
      </div>

      {status === "idle" && (
        <div className="space-y-4 text-sm">
          <div>
            <label className="flex flex-col gap-1">
              Upload a CSV
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleCsvFile(file);
                }}
                className="text-sm"
              />
            </label>
            <p className="text-xs text-gray-400 mt-1">Columns are matched by name (e.g. &quot;price&quot;, &quot;Price (INR)&quot;, &quot;SKU&quot;). Parsed in code, never sent to a model.</p>
          </div>

          <div className="border-t pt-4">
            <label className="flex flex-col gap-1">
              Or paste a product list
              <textarea
                rows={5}
                value={pastedText}
                onChange={(e) => setPastedText(e.target.value)}
                placeholder="Paste a product list from your website, a supplier email, or anywhere else..."
                className="border rounded px-3 py-2"
                maxLength={20_000}
              />
            </label>
            <button
              onClick={handleExtractPasted}
              disabled={!pastedText.trim()}
              className="mt-2 px-3 py-2 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 text-sm"
            >
              Extract products
            </button>
            <p className="text-xs text-gray-400 mt-1">A model reads this and proposes rows below — nothing is saved until you review and confirm.</p>
          </div>
        </div>
      )}

      {status === "parsing" && <p className="text-sm text-gray-500">Reading…</p>}

      {(status === "previewing" || status === "confirming") && (
        <div className="space-y-3">
          {unmappedColumns.length > 0 && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
              Unmapped columns (ignored): {unmappedColumns.join(", ")}
            </p>
          )}
          {errorCount > 0 && (
            <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
              {errorCount} row(s) have errors and will be skipped unless corrected below.
            </p>
          )}
          <p className="text-sm text-gray-500">
            {rows.length} row(s) parsed. Review — especially prices, shown in rupees — then confirm.
          </p>
          <div className="overflow-x-auto border rounded">
            <table className="w-full text-xs">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left p-2">Name</th>
                  <th className="text-left p-2">SKU</th>
                  <th className="text-left p-2">Price (₹)</th>
                  <th className="text-left p-2">Cost (₹)</th>
                  <th className="text-left p-2">Stock</th>
                  <th className="text-left p-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i} className={`border-t ${row.error ? "bg-red-50" : ""}`}>
                    <td className="p-1">
                      <input value={row.name} onChange={(e) => updateRow(i, { name: e.target.value })} className="border rounded px-2 py-1 w-32" />
                    </td>
                    <td className="p-1">
                      <input value={row.sku} onChange={(e) => updateRow(i, { sku: e.target.value })} className="border rounded px-2 py-1 w-24" />
                    </td>
                    <td className="p-1">
                      <input
                        type="number"
                        step="0.01"
                        value={row.priceRupees}
                        onChange={(e) => updateRow(i, { priceRupees: Number(e.target.value) })}
                        className="border rounded px-2 py-1 w-20"
                      />
                    </td>
                    <td className="p-1">
                      <input
                        type="number"
                        step="0.01"
                        value={row.costRupees}
                        onChange={(e) => updateRow(i, { costRupees: Number(e.target.value) })}
                        className="border rounded px-2 py-1 w-20"
                      />
                    </td>
                    <td className="p-1">
                      <input
                        type="number"
                        step="1"
                        value={row.stock}
                        onChange={(e) => updateRow(i, { stock: Number(e.target.value) })}
                        className="border rounded px-2 py-1 w-16"
                      />
                    </td>
                    <td className="p-1 text-red-700">{row.error ?? "OK"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleConfirm}
              disabled={status === "confirming"}
              className="px-3 py-2 rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 text-sm"
            >
              {status === "confirming" ? "Importing…" : `Import ${rows.filter((r) => !r.error).length} row(s)`}
            </button>
            <button onClick={reset} className="px-3 py-2 rounded border text-sm hover:bg-gray-50">
              Cancel
            </button>
          </div>
        </div>
      )}

      {status === "done" && (
        <div className="space-y-2">
          <p className="text-sm text-green-700">{message}</p>
          <button onClick={reset} className="text-sm px-3 py-2 rounded border hover:bg-gray-50">
            Import more
          </button>
        </div>
      )}

      {status === "error" && (
        <div className="space-y-2">
          <p className="text-sm text-red-700">{message}</p>
          <button onClick={reset} className="text-sm px-3 py-2 rounded border hover:bg-gray-50">
            Try again
          </button>
        </div>
      )}
    </section>
  );
}
