import type { CallToolResult } from "@modelcontextprotocol/server";
import { AuthError } from "../auth.js";
import { GraphError } from "../graph.js";

/** Run a tool body, converting thrown errors into an isError result with an actionable message. */
export async function run(body: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await body();
  } catch (err) {
    const message =
      err instanceof AuthError || err instanceof GraphError
        ? err.message
        : err instanceof Error
          ? `Erreur : ${err.message}`
          : `Erreur : ${String(err)}`;
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

export function ok(text: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: structured };
}
