/**
 * Structured facts about *what* was being attempted when something failed - which issue, which
 * project, which API call.
 *
 * The APIs this service talks to raise errors that describe only the failure, never the subject:
 * Linear answers a lookup for a deleted issue with "Entity not found: Issue - Could not find
 * referenced Issue", which names neither the issue nor the Todoist project whose description
 * pointed at it. Since every poll cycle walks many issues and projects, a message like that is
 * unactionable on its own - it says something is wrong but not what to go look at.
 *
 * So context is attached to the error at the layer that knows it, and travels up with it: the
 * client layer names the API call and its arguments, and callers add whatever they know that the
 * client cannot (e.g. that an issue identifier was parsed out of a particular project's
 * description). Whoever finally logs it gets the whole chain.
 */
export type ErrorContext = Record<string, unknown>;

/** The message of an error-like value, however it was thrown. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'string') {
    return err;
  }
  return String(err);
}

/** Renders context inline for the message, so a single log line reads on its own. */
function renderContext(context: ErrorContext): string {
  const parts = Object.entries(context)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`;
}

/**
 * An error that carries the context of the operation that failed. The message reads
 * `<what> (<context>): <underlying message>`, and the context is also kept structured so
 * `errorFields` can hand it to the logger as real fields rather than prose.
 */
export class ContextualError extends Error {
  readonly context: ErrorContext;

  constructor(what: string, context: ErrorContext = {}, cause?: unknown) {
    const described = `${what}${renderContext(context)}`;
    super(cause === undefined ? described : `${described}: ${errorMessage(cause)}`, { cause });
    this.name = 'ContextualError';
    this.context = { ...collectContext(cause), ...context };
  }
}

/** Merges the context of every `ContextualError` in the cause chain; the outermost layer wins. */
function collectContext(err: unknown): ErrorContext {
  // Depth-bounded: a cause chain is normally two or three deep, but an error whose `cause`
  // points back at itself would otherwise hang the process that was only trying to log it.
  const merged: ErrorContext = {};
  const layers: ErrorContext[] = [];
  for (let current: unknown = err, depth = 0; current instanceof Error && depth < 10; depth++) {
    if (current instanceof ContextualError) {
      layers.push(current.context);
    }
    current = current.cause;
  }
  for (const layer of layers.reverse()) {
    Object.assign(merged, layer);
  }
  return merged;
}

/**
 * The standard field set for logging a failure: the full message plus every fact any layer
 * attached. Spread it into a `logger.error` call in place of a hand-written `error:` field.
 */
export function errorFields(err: unknown): ErrorContext {
  return { ...collectContext(err), error: errorMessage(err) };
}

/**
 * Runs `fn`, re-throwing any failure wrapped with what it was doing and to what. Use it wherever
 * the caller knows something the callee cannot - the callee sees an issue identifier, the caller
 * knows which Todoist project it was read out of.
 */
export async function withContext<T>(
  what: string,
  context: ErrorContext,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new ContextualError(what, context, err);
  }
}
