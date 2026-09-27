// Stub for vitest (node env). Production uses the real cloudflare:workflows runtime.
export class NonRetryableError extends Error {
  constructor(message: string, name = "NonRetryableError") {
    super(message);
    this.name = name;
  }
}
