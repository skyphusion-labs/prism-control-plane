// Stub for vitest (node env). Production uses the real cloudflare:workers runtime.
export class DurableObject {
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(_ctx: unknown, _env: unknown) {}
}

/** Minimal WorkflowEntrypoint so PlaneLongRunWorkflow typechecks under node. */
export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(_ctx: unknown, protected env: Env) {}
  // Subclasses implement run(event, step).
  async run(_event: unknown, _step: unknown): Promise<unknown> {
    return undefined;
  }
}

export type WorkflowEvent<T> = { payload: T };
export type WorkflowStep = {
  do: <T>(
    name: string,
    opts: unknown,
    fn: () => Promise<T>,
  ) => Promise<T>;
};
