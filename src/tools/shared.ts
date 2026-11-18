import type { CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
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
          ? `Error: ${err.message}`
          : `Error: ${String(err)}`;
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

export function ok(text: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: structured };
}

const NOT_A_MESSAGE_ID = "Not a message id: pass the id exactly as mail_search or mail_senders_summary returned it.";

/**
 * A Graph message id: base64-like, often 150 characters or more, with `-`, `_`, `=`, `+` or `/`.
 * The pattern has no `.`, so no `.` or `..` segment can pass it; the refinement says so again, so that a
 * wider pattern could not let one through.
 */
export const MessageId = z
  .string()
  .regex(/^[A-Za-z0-9_=+/-]{16,512}$/, { message: NOT_A_MESSAGE_ID, abort: true })
  .refine((id) => id.split("/").every((segment) => segment !== "." && segment !== ".."), NOT_A_MESSAGE_ID);

/** 1 to 500 message ids. A repeated id is acted on once. */
export const MessageIds = z.array(MessageId).min(1).max(500).describe("Message ids (1 to 500)");
