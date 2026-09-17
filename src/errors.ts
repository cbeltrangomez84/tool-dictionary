/**
 * The one error shape every layer speaks (spec 9.4): a status, a stable code,
 * a message meant for the agent, and structured details. The HTTP layer
 * renders it as `{ error: { code, message, details } }` without translation.
 */
export type ErrorCode =
  | 'not_found'
  | 'entry_not_found'
  | 'entry_removed'
  | 'unauthorized'
  | 'forbidden'
  | 'version_conflict'
  | 'invalid_dictionary'
  | 'not_loaded'
  | 'no_source'
  | 'dictionary_required'
  | 'dictionary_mismatch'
  // Execution (spec 9.7).
  | 'execution_disabled'
  | 'not_executable'
  | 'invalid_params'
  | 'missing_credential'
  | 'missing_variable'
  | 'target_not_allowed'
  | 'upstream_error'
  | 'upstream_redirect'
  | 'upstream_timeout';

export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details: unknown[] = [],
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}
