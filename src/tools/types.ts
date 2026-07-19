import type { DatabaseSync } from "node:sqlite";
import type { z } from "zod";

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<TInput>;
  /** May throw ToolError -- the dispatcher catches it and returns it as the tool result. */
  execute: (db: DatabaseSync, input: TInput) => TOutput;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any, any>;
