import { NextResponse } from 'next/server';
import { AdmissionResult } from '@/lib/limiter';

/**
 * Maps admission or limiter rejection / conflict to standard HTTP NextResponse.
 */
export function handleAdmissionFailure(
  admissionResult: AdmissionResult,
  idempotencyKey: string
): NextResponse {
  // 1. Conflict (idempotency_conflict, request_in_progress)
  if ('conflict' in admissionResult) {
    let message = admissionResult.message;
    if (admissionResult.errorCode === 'idempotency_conflict') {
      message = 'Idempotency key already used with different payload.';
    } else if (admissionResult.errorCode === 'request_in_progress') {
      message = 'Request is currently in progress.';
    }

    return NextResponse.json(
      {
        error: {
          message,
          type: 'requests',
          param: null,
          code: admissionResult.errorCode,
        },
      },
      {
        status: admissionResult.httpStatus,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'x-request-id': idempotencyKey,
        },
      }
    );
  }

  // 2. Terminal Retry (succeeded, failed, cancelled, lease_expired, or rejected retry)
  if ('isTerminalRetry' in admissionResult) {
    let message = 'Request has already been processed.';
    if (admissionResult.errorCode === 'rate_limit_exceeded') {
      message = 'Rate limit exceeded.';
    } else if (admissionResult.errorCode === 'concurrency_limit_exceeded') {
      message = 'Concurrency limit exceeded.';
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'x-request-id': idempotencyKey,
    };

    if (admissionResult.retryAfter !== undefined) {
      headers['Retry-After'] = String(admissionResult.retryAfter);
    }

    const outcome = {
      status: admissionResult.outcome.status,
      original_http_status: admissionResult.outcome.originalHttpStatus,
      original_error_code: admissionResult.outcome.originalErrorCode ?? null,
      originalHttpStatus: admissionResult.outcome.originalHttpStatus,
      originalErrorCode: admissionResult.outcome.originalErrorCode ?? null,
      completed_at: Math.floor(new Date(admissionResult.outcome.completedAt).getTime() / 1000),
    };

    return NextResponse.json(
      {
        error: {
          message,
          type: 'requests',
          param: null,
          code: admissionResult.errorCode || 'request_already_processed',
        },
        outcome,
      },
      {
        status: admissionResult.httpStatus,
        headers,
      }
    );
  }

  // 3. Fresh rejection (rate_limit_exceeded, concurrency_limit_exceeded)
  if ('reason' in admissionResult) {
    let message = 'Too Many Requests';
    if (admissionResult.reason === 'rate_limit_exceeded') {
      message = 'Rate limit exceeded.';
    } else if (admissionResult.reason === 'concurrency_limit_exceeded') {
      message = 'Concurrency limit exceeded.';
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'x-request-id': idempotencyKey,
    };

    if (admissionResult.retryAfter !== undefined) {
      headers['Retry-After'] = String(admissionResult.retryAfter);
    }

    return NextResponse.json(
      {
        error: {
          message,
          type: 'requests',
          param: null,
          code: admissionResult.errorCode,
        },
      },
      {
        status: admissionResult.httpStatus,
        headers,
      }
    );
  }

  // Fallback limiter unavailable
  return NextResponse.json(
    {
      error: {
        message: 'Service Unavailable: Rate limiter state is unavailable or unconfirmed',
        type: 'requests',
        param: null,
        code: 'limiter_unavailable',
      },
    },
    {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'x-request-id': idempotencyKey,
      },
    }
  );
}
