import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProjectScope } from "./fs-scope.js";
/** L20-8: "a fixture directory per scenario, real files, no mocks." Every test gets its own real temp directory, torn down after. */
export function makeFixture(files) {
    const root = mkdtempSync(path.join(tmpdir(), "thirdman-test-"));
    for (const [relPath, content] of Object.entries(files)) {
        const abs = path.join(root, relPath);
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, content, "utf8");
    }
    return {
        root,
        scope: new ProjectScope(root),
        cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
}
//# sourceMappingURL=test-fixture.js.map