import type { ErrorBody } from '@gateway/shared-types';

/** Stable machine-readable error codes returned by the gateway. */
export const ErrorCodes = {
  BAD_REQUEST: 'BAD_REQUEST',
  ROUTE_NOT_FOUND: 'ROUTE_NOT_FOUND',
  AUTHENTICATION_ERROR: 'AUTHENTICATION_ERROR',
  AUTHORIZATION_ERROR: 'AUTHORIZATION_ERROR',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT',
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  CIRCUIT_OPEN: 'CIRCUIT_OPEN',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  HEADERS_TOO_LARGE: 'HEADERS_TOO_LARGE',
  CONFIGURATION_ERROR: 'CONFIGURATION_ERROR',
  REDIS_ERROR: 'REDIS_ERROR',
  DATABASE_ERROR: 'DATABASE_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  CONFLICT: 'CONFLICT',
  UNPROCESSABLE: 'UNPROCESSABLE',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/** How an upstream failure should be classified for circuit breaking. */
export type UpstreamFailureKind = 'timeout' | 'connection' | 'bad_response' | 'none';

export class GatewayError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly failureKind: UpstreamFailureKind;
  readonly details?: unknown;

  constructor(
    code: ErrorCode,
    statusCode: number,
    message: string,
    failureKind: UpstreamFailureKind = 'none',
    details?: unknown,
  ) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.statusCode = statusCode;
    this.failureKind = failureKind;
    this.details = details;
  }
}

export function toErrorResponse(
  err: unknown,
  requestId: string,
): { statusCode: number; body: ErrorBody } {
  if (err instanceof GatewayError) {
    return {
      statusCode: err.statusCode,
      body: {
        error: {
          code: err.code,
          message: err.message,
          requestId,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
      },
    };
  }
  return {
    statusCode: 500,
    body: {
      error: {
        code: ErrorCodes.INTERNAL_ERROR,
        message: 'An unexpected error occurred',
        requestId,
      },
    },
  };
}
