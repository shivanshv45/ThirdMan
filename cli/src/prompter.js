import prompts from "prompts";
export const realPrompter = {
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
export function scriptedPrompter(answers) {
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
            return typeof v === "string" ? v : choices[0];
        },
    };
}
//# sourceMappingURL=prompter.js.map