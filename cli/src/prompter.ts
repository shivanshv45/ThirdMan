import prompts from "prompts";

/**
 * The interactive layer, as a swappable interface. `prompts`' real
 * implementation reads raw keypresses, which makes non-interactive
 * (piped/CI) testing of init.ts unreliable — every command function
 * takes a Prompter so tests can inject a scripted one and exercise the
 * exact same code path a real merchant runs through. See L20-8.
 */
export interface Prompter {
  confirm(message: string, initial: boolean): Promise<boolean>;
  text(message: string, initial?: string): Promise<string>;
  select<T extends string>(message: string, choices: T[]): Promise<T | undefined>;
}

export const realPrompter: Prompter = {
  async confirm(message, initial) {
    const { value } = await prompts({ type: "confirm", name: "value", message, initial });
    return value ?? false;
  },
  async text(message, initial = "") {
    const { value } = await prompts({ type: "text", name: "value", message, initial });
    return value ?? "";
  },
  async select(message, choices) {
    const { value } = await prompts({ type: "select", name: "value", message, choices: choices.map((c) => ({ title: c, value: c })) });
    return value;
  },
};

/** A scripted Prompter for tests — answers are consumed in call order, one per method invocation, regardless of type. */
export function scriptedPrompter(answers: (boolean | string | undefined)[]): Prompter {
  let i = 0;
  const next = () => answers[i++];
  return {
    async confirm(_message, initial) {
      const v = next();
      return typeof v === "boolean" ? v : initial;
    },
    async text(_message, initial = "") {
      const v = next();
      return typeof v === "string" ? v : initial;
    },
    async select(_message, choices) {
      const v = next();
      return typeof v === "string" ? (v as never) : choices[0];
    },
  };
}
