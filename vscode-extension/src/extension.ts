import * as vscode from "vscode";
import * as path from "node:path";
import { ProjectScope } from "../../cli/src/fs-scope.js";
import { runAudit } from "../../cli/src/audit.js";
import { detectStack } from "../../cli/src/stacks/detect.js";
import { generateDiscoveryDoc } from "../../cli/src/generate/discovery-doc.js";
import { generateConfig } from "../../cli/src/generate/config.js";
import { snippetTargetForStack, generateSnippetWrite } from "../../cli/src/generate/snippet.js";
import { planWrite, applyWrite } from "../../cli/src/generate/diff.js";
import type { AuditCheck, AuditReport } from "../../cli/src/types.js";
import type { FileWrite } from "../../cli/src/generate/diff.js";
import { placeDiagnostics } from "./diagnostics.js";

/**
 * Layer 24-2: a thin presentation layer over cli/'s real audit engine —
 * no forked logic, per the plan's explicit instruction. Every function
 * imported above is the exact same function `npx thirdman audit` calls;
 * this file only turns AuditReport into vscode.Diagnostic objects, a
 * status bar item, and a diff-editor review flow. If a finding needs a
 * shape this engine doesn't produce, the engine gains it for both
 * callers (see shared/find-line.ts, added for this reason) — never a
 * second implementation living here.
 */

let diagnosticCollection: vscode.DiagnosticCollection;
let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  diagnosticCollection = vscode.languages.createDiagnosticCollection("thirdman");
  context.subscriptions.push(diagnosticCollection);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = "thirdman.runAudit";
  statusBarItem.text = "$(shield) Thirdman: not run";
  statusBarItem.tooltip = "Run the Thirdman agent-readiness audit";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(vscode.commands.registerCommand("thirdman.runAudit", runAuditCommand));
  context.subscriptions.push(vscode.commands.registerCommand("thirdman.reviewGeneratedFiles", reviewGeneratedFilesCommand));
}

export function deactivate() {
  diagnosticCollection?.dispose();
  statusBarItem?.dispose();
}

function workspaceRoot(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  return folders[0].uri.fsPath;
}

async function runAuditCommand(): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showWarningMessage("Thirdman: open a folder or workspace first.");
    return;
  }

  statusBarItem.text = "$(sync~spin) Thirdman: auditing…";

  let report: AuditReport;
  try {
    const scope = new ProjectScope(root);
    report = runAudit(scope);
  } catch (err) {
    statusBarItem.text = "$(shield) Thirdman: error";
    vscode.window.showErrorMessage(`Thirdman audit failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  publishDiagnostics(root, report.checks);
  statusBarItem.text = `$(shield) Thirdman: ${report.score}/100`;
  statusBarItem.tooltip = `Thirdman agent-readiness score: ${report.score}/100. Click to re-run.`;

  const failed = report.checks.filter((c) => !c.passed);
  if (failed.length > 0) {
    vscode.window.showInformationMessage(
      `Thirdman: ${report.score}/100 — ${failed.length} check${failed.length === 1 ? "" : "s"} failed. See the Problems panel.`,
      "Review generated files",
    ).then((selection) => {
      if (selection === "Review generated files") void reviewGeneratedFilesCommand();
    });
  } else {
    vscode.window.showInformationMessage(`Thirdman: ${report.score}/100 — every check passed.`);
  }
}

const SEVERITY: Record<"warning" | "information", vscode.DiagnosticSeverity> = {
  warning: vscode.DiagnosticSeverity.Warning,
  information: vscode.DiagnosticSeverity.Information,
};

/**
 * L24-2: findings anchored to real file/line positions — the whole
 * value of this extension over the CLI's terminal output. The actual
 * file/line placement logic lives in diagnostics.ts's placeDiagnostics
 * (pure, unit-tested); this function only turns that into real
 * vscode.Diagnostic objects, which can't be constructed outside a real
 * Extension Host.
 */
function publishDiagnostics(root: string, checks: AuditCheck[]): void {
  diagnosticCollection.clear();

  const byFile = new Map<string, vscode.Diagnostic[]>();
  for (const placed of placeDiagnostics(checks)) {
    const range = new vscode.Range(placed.line, 0, placed.line, 200);
    const diagnostic = new vscode.Diagnostic(range, placed.message, SEVERITY[placed.severity]);
    diagnostic.source = "thirdman";
    diagnostic.code = placed.checkId;
    const list = byFile.get(placed.relativePath) ?? [];
    list.push(diagnostic);
    byFile.set(placed.relativePath, list);
  }

  for (const [relativePath, diagnostics] of byFile) {
    diagnosticCollection.set(vscode.Uri.file(path.join(root, relativePath)), diagnostics);
  }
}

/**
 * L24-2: generated files "offered through the editor's own diff view,
 * so the merchant approves a change in the same UI they approve any
 * other" — vscode.diff, never a direct write. Applying a write still
 * goes through cli/'s own planWrite/applyWrite (L20-5's governing
 * rule), so nothing here can write a byte the merchant hasn't seen
 * diffed first, same as the terminal CLI.
 */
async function reviewGeneratedFilesCommand(): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showWarningMessage("Thirdman: open a folder or workspace first.");
    return;
  }

  const appOrigin = vscode.workspace.getConfiguration("thirdman").get<string>("appOrigin", "https://thirdman.dev");
  const scope = new ProjectScope(root);
  const detection = detectStack(scope);

  const placeholderPublishableKey = "REPLACE_WITH_YOUR_EMBED_PUBLISHABLE_KEY";
  const writes: FileWrite[] = [
    generateDiscoveryDoc({ merchantId: null, merchantName: "your store", origin: "https://your-site.example.com", appOrigin }),
    generateConfig({ merchantId: "unlinked", publishableKey: placeholderPublishableKey, allowedOrigin: "https://your-site.example.com", appOrigin }),
  ];

  const snippetTarget = snippetTargetForStack(detection.stack);
  if (snippetTarget) {
    const existing = scope.exists(snippetTarget.relativePath) ? scope.readFile(snippetTarget.relativePath) : "";
    writes.push(generateSnippetWrite(snippetTarget, existing, appOrigin, placeholderPublishableKey));
  }

  for (const write of writes) {
    const planned = planWrite(scope, write);
    if (planned.unchanged) continue;

    const leftUri = planned.oldContent === null ? vscode.Uri.parse(`untitled:${write.relativePath} (new file)`) : vscode.Uri.file(path.join(root, write.relativePath));
    const rightUri = vscode.Uri.parse(`thirdman-preview:${write.relativePath}`).with({ query: encodeURIComponent(write.newContent) });

    const providerDisposable = vscode.workspace.registerTextDocumentContentProvider("thirdman-preview", {
      provideTextDocumentContent: (uri) => decodeURIComponent(uri.query),
    });

    await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, `Thirdman: ${write.relativePath} (proposed)`);
    providerDisposable.dispose();

    const choice = await vscode.window.showInformationMessage(`Write ${write.relativePath}? Note: the config/discovery doc above use a placeholder publishable key — link a real account via /dashboard/cli or \`npx thirdman init\` to fill in real values.`, "Write this file", "Skip");
    if (choice === "Write this file") {
      applyWrite(scope, write);
      vscode.window.showInformationMessage(`Wrote ${write.relativePath}.`);
    }
  }
}
