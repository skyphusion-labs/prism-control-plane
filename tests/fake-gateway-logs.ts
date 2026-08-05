// A scripted AI Gateway log feed for the tests.
//
// The reason `GatewayLogSource` is an interface at all: the cases reconciliation exists to handle cannot be
// provoked on demand from the real API. A row Cloudflare recorded no cost for, a row whose metadata names a
// request this plane never wrote down, a row tagged with the wrong account, a page the API returned
// garbage in, a backlog longer than one run may process -- every one of those is a case where moving money
// would be wrong, and every one of them is scriptable here in two lines.
//
// PAGES ARE SERVED THE WAY CLOUDFLARE SERVES THEM: rows ascending by `created_at`, filtered to strictly
// after `sinceIso`, sliced by `page`/`perPage`, and a SHORT page is how the end of the feed is signalled.
// The run loop terminates on that short page, so a fake that always returned a full one would loop
// forever and a fake that always returned a short one would never exercise paging.

import type { GatewayLogPage, GatewayLogRow, GatewayLogSource } from "../src/aig-logs";

export interface FakeLogSourceOptions {
  gatewayId?: string;
  /** Rows the feed holds, in any order. They are sorted ascending on read. */
  rows?: GatewayLogRow[];
  /** Unreadable rows to report on the FIRST page, standing in for a shape change in the API. */
  malformed?: number;
  /** Set to make every `listSince` throw, standing in for a token that lacks AI Gateway Read. */
  fail?: string | null;
}

export class FakeLogSource implements GatewayLogSource {
  readonly gatewayId: string;
  rows: GatewayLogRow[];
  malformed: number;
  fail: string | null;
  /** Every call this run made, so a test can assert paging and the D1-read economy around it. */
  calls: { sinceIso: string; page: number; perPage: number }[] = [];

  constructor(options: FakeLogSourceOptions = {}) {
    this.gatewayId = options.gatewayId ?? "prism-proxy";
    this.rows = options.rows ?? [];
    this.malformed = options.malformed ?? 0;
    this.fail = options.fail ?? null;
  }

  async listSince(args: { sinceIso: string; page: number; perPage: number }): Promise<GatewayLogPage> {
    this.calls.push({ ...args });
    if (this.fail) throw new Error(this.fail);

    const since = Date.parse(args.sinceIso);
    const matching = this.rows
      .filter((row) => Date.parse(row.createdAt) > since)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const start = (args.page - 1) * args.perPage;
    return {
      rows: matching.slice(start, start + args.perPage),
      malformed: args.page === 1 ? this.malformed : 0,
      totalCount: matching.length,
    };
  }
}

/** One row, with the fields a test cares about and safe defaults for the rest. */
export function logRow(overrides: Partial<GatewayLogRow> & { id: string; createdAt: string }): GatewayLogRow {
  return {
    model: "@cf/meta/llama-3.1-8b-instruct",
    provider: "workers-ai",
    statusCode: 200,
    success: true,
    cached: false,
    tokensIn: 10,
    tokensOut: 20,
    costMicroUsd: 100,
    requestId: null,
    accountId: null,
    ...overrides,
  };
}
