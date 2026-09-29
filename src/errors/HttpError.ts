export class HttpError extends Error {
  public readonly statusCode: number;
  public readonly code?: string;
  public readonly details?: unknown;
  public readonly retryable?: boolean;

  constructor(statusCode: number, message: string, code?: string, details?: unknown, retryable?: boolean) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.retryable = retryable;
  }
}
