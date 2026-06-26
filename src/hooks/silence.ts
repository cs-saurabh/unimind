/**
 * stdout isolation for hook processes. The iii SDK (and OTel) log to stdout/console
 * on import and connect. For the UserPromptSubmit hook, Claude Code injects the hook's
 * stdout into the model's context — so any stray library output would pollute it.
 *
 * This module (imported FIRST, before the SDK) redirects all console output and the
 * default process.stdout to stderr, and exposes `writeStdout` as the ONLY sanctioned
 * channel to the real stdout — used solely for the intended additionalContext JSON.
 */
const realStdoutWrite = process.stdout.write.bind(process.stdout);

/** The only sanctioned way to emit to the real stdout from a hook. */
export function writeStdout(text: string): void {
  realStdoutWrite(text);
}

// Everything else → stderr (visible in `claude --debug`, never injected as context).
const toStderr = (...args: unknown[]) => {
  process.stderr.write(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n");
};
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;
console.warn = toStderr;
// Redirect anything writing to process.stdout (e.g. SDK logging) to stderr too.
(process.stdout.write as unknown) = ((chunk: any, ...rest: any[]) => {
  return (process.stderr.write as any)(chunk, ...rest);
}) as typeof process.stdout.write;
