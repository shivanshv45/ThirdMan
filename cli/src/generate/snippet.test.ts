import { describe, it, expect } from "vitest";
import { buildSnippet, injectSnippet, generateSnippetWrite, snippetTargetForStack } from "./snippet.js";

describe("injectSnippet", () => {
  it("inserts before insertBeforePattern when no marker exists", () => {
    const html = "<html><body>\n<p>hi</p>\n</body></html>";
    const snippet = buildSnippet("http://app.example.com", "pk_abc");
    const result = injectSnippet(html, snippet, /<\/body>/);
    expect(result).toContain(snippet);
    expect(result.indexOf(snippet)).toBeLessThan(result.indexOf("</body>"));
  });

  it("appends at the end when insertBeforePattern is null", () => {
    const html = "<html></html>";
    const snippet = buildSnippet("http://app.example.com", "pk_abc");
    const result = injectSnippet(html, snippet, null);
    expect(result).toContain(snippet);
  });

  it("is idempotent: injecting twice never produces two snippets", () => {
    const html = "<html><body>\n</body></html>";
    const snippet = buildSnippet("http://app.example.com", "pk_abc");
    const once = injectSnippet(html, snippet, /<\/body>/);
    const twice = injectSnippet(once, snippet, /<\/body>/);

    const occurrences = (twice.match(/data-embed-key/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it("replaces an existing block in place when the key changes", () => {
    const html = "<html><body></body></html>";
    const first = injectSnippet(html, buildSnippet("http://app.example.com", "pk_old"), /<\/body>/);
    const second = injectSnippet(first, buildSnippet("http://app.example.com", "pk_new"), /<\/body>/);

    expect(second).not.toContain("pk_old");
    expect(second).toContain("pk_new");
    expect((second.match(/data-embed-key/g) ?? []).length).toBe(1);
  });

  it("finds and replaces a JSX-wrapped marker from a prior run (idempotency across comment styles)", () => {
    const jsxSnippet = buildSnippet("http://app.example.com", "pk_old").replace(/<!--(.*)-->/g, "{/*$1*/}");
    const layout = `export default function Layout() {\n  return <body>\n    ${jsxSnippet}\n  </body>;\n}`;

    const replaced = injectSnippet(layout, buildSnippet("http://app.example.com", "pk_new"), /<\/body>/);
    expect(replaced).not.toContain("pk_old");
  });
});

describe("generateSnippetWrite + snippetTargetForStack", () => {
  it("wraps as JSX for nextjs and as HTML comment for static_html", () => {
    const nextTarget = snippetTargetForStack("nextjs")!;
    const nextWrite = generateSnippetWrite(nextTarget, "<html><body></body></html>", "http://app.example.com", "pk_1");
    expect(nextWrite.newContent).toContain("{/*");
    expect(nextWrite.relativePath).toBe("src/app/layout.tsx");

    const staticTarget = snippetTargetForStack("static_html")!;
    const staticWrite = generateSnippetWrite(staticTarget, "<html><body></body></html>", "http://app.example.com", "pk_1");
    expect(staticWrite.newContent).toContain("<!--");
    expect(staticWrite.relativePath).toBe("index.html");
  });

  it("returns null for a stack with no supported automatic injection target", () => {
    expect(snippetTargetForStack("woocommerce")).toBeNull();
    expect(snippetTargetForStack("express")).toBeNull();
  });
});
