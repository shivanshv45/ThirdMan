/**
 * L20-5's optional JSON-LD generation: "the first thing to cut if it
 * cannot be done cleanly — a half-correct JSON-LD block is worse than
 * none." Cutting it entirely for this session rather than shipping a
 * heuristic that guesses at a merchant's product template shape from
 * static analysis — that guess is exactly the "half-correct" failure
 * mode the plan warns against. Left as a named, deliberate gap (see
 * PROGRESS.md/DECISIONS.md) rather than a fabricated block.
 */
export {};
