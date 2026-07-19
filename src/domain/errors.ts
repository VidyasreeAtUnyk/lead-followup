export const TOOL_ERROR_CODES = [
  "INVALID_TRANSITION",
  "DO_NOT_CONTACT",
  "NOT_APPROVED",
  "RATE_LIMITED",
  "EVIDENCE_INVALID",
  "INSUFFICIENT_PROFILE",
  "NOT_FOUND",
  "UNGROUNDED_FIGURES",
  "INVALID_INPUT",
  "ALREADY_SENT",
] as const;
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

/**
 * All guardrails throw this instead of a raw Error so the agent loop can
 * serialize `{ error, message }` back to the model as a tool result and let
 * it self-correct on the next turn, rather than crashing the run.
 */
export class ToolError extends Error {
  readonly error: ToolErrorCode;

  constructor(error: ToolErrorCode, message: string) {
    super(message);
    this.name = "ToolError";
    this.error = error;
  }

  toJSON() {
    return { error: this.error, message: this.message };
  }
}

export function isToolError(e: unknown): e is ToolError {
  return e instanceof ToolError;
}
