/**
 * Exit codes. These mirror the Reliastra CLI byte-for-byte.
 *
 * Source of truth: cli/cmd/reliastra/main.go
 *   exitOK 0, exitUsage 1, exitAPI 2, exitAuth 3, exitUnverified 4,
 *   exitDenied 5, exitNetwork 6, exitInterrupt 130
 *
 * Two actions that both ship a Reliastra exit code must agree on it. If you
 * change a number here, change it there, or a workflow that passes locally
 * breaks in CI.
 */
export const EXIT = Object.freeze({
  OK: 0,
  USAGE: 1,
  API: 2,
  AUTH: 3,
  UNVERIFIED: 4,
  DENIED: 5,
  NETWORK: 6,
  INTERRUPT: 130,
});

export const EXIT_DOC = Object.freeze({
  [EXIT.OK]: "observation recorded; job passes",
  [EXIT.USAGE]: "invalid or missing input; nothing was called",
  [EXIT.API]: "Reliastra returned an error or an unreadable body",
  [EXIT.AUTH]: "token missing, malformed, or rejected (401/403)",
  [EXIT.UNVERIFIED]: "no observation exists yet; nothing can be concluded",
  [EXIT.DENIED]: "an observation was made and it matched your fail-on gate",
  [EXIT.NETWORK]: "could not reach reliastra.com (DNS, TLS, timeout, reset)",
  [EXIT.INTERRUPT]: "the job was cancelled while waiting",
});

/** An error that carries its own exit code. Anything else is treated as API. */
export class ReliastraError extends Error {
  constructor(message, exitCode, hint) {
    super(message);
    this.name = "ReliastraError";
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

export const usageError = (message, hint) => new ReliastraError(message, EXIT.USAGE, hint);
export const apiError = (message, hint) => new ReliastraError(message, EXIT.API, hint);
export const authError = (message, hint) => new ReliastraError(message, EXIT.AUTH, hint);
export const networkError = (message, hint) => new ReliastraError(message, EXIT.NETWORK, hint);
export const unverifiedError = (message, hint) => new ReliastraError(message, EXIT.UNVERIFIED, hint);