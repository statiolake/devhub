import { Readable, Writable } from "node:stream";
import { redactSecrets } from "./redaction";

export interface CancellationTokenLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => unknown): { dispose(): void };
}

export class RequestCancelledError extends Error {
  public constructor(message = "The request was cancelled.") {
    super(message);
    this.name = "RequestCancelledError";
  }
}

export class JsonRpcRemoteError extends Error {
  public readonly code: number;
  public readonly data: unknown;

  public constructor(code: number, message: string, data: unknown) {
    super(message);
    this.name = "JsonRpcRemoteError";
    this.code = code;
    this.data = data;
  }
}

export class JsonRpcConnectionClosedError extends Error {
  public constructor(message = "The JSON-RPC connection is closed.") {
    super(message);
    this.name = "JsonRpcConnectionClosedError";
  }
}

interface JsonRpcRequestMessage {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotificationMessage {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcResponseMessage {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

type JsonRpcMessage =
  | JsonRpcRequestMessage
  | JsonRpcNotificationMessage
  | JsonRpcResponseMessage;

type RequestHandler = (
  method: string,
  params: unknown,
) => Promise<unknown> | unknown;
type NotificationHandler = (method: string, params: unknown) => void;

export interface JsonRpcConnectionOptions {
  requestHandler?: (
    method: string,
    params: unknown,
  ) => Promise<unknown> | unknown;
  notificationHandler?: (method: string, params: unknown) => void;
  log?: (message: string, details?: unknown) => void;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  cancellationDisposable?: { dispose(): void };
  timeout?: NodeJS.Timeout;
}

/**
 * Minimal LSP JSON-RPC transport. It intentionally knows nothing about VS Code
 * so that protocol behavior can be tested without starting an Extension Host.
 */
export class JsonRpcConnection {
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly requestHandler: RequestHandler;
  private readonly notificationHandler: NotificationHandler;
  private readonly log?: (message: string, details?: unknown) => void;
  private readonly requestTimeoutMs: number;
  private inputBuffer = Buffer.alloc(0);
  private nextRequestId = 1;
  private closed = false;
  private readonly onDataBound: (chunk: Buffer | string) => void;
  private readonly onErrorBound: (error: Error) => void;
  private readonly onEndBound: () => void;

  public constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    options: JsonRpcConnectionOptions = {},
  ) {
    this.requestHandler = options.requestHandler ?? (() => undefined);
    this.notificationHandler = options.notificationHandler ?? (() => undefined);
    this.log = options.log;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
    this.onDataBound = (chunk) => this.onData(chunk);
    this.onErrorBound = (error) => this.close(error);
    this.onEndBound = () =>
      this.close(new JsonRpcConnectionClosedError("The JSON-RPC input ended."));

    this.input.on("data", this.onDataBound);
    this.input.on("error", this.onErrorBound);
    this.input.on("end", this.onEndBound);
    this.input.on("close", this.onEndBound);
  }

  public request<T>(
    method: string,
    params?: unknown,
    cancellationToken?: CancellationTokenLike,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new JsonRpcConnectionClosedError());
    }
    if (cancellationToken?.isCancellationRequested === true) {
      return Promise.reject(
        new RequestCancelledError(`${method} was cancelled.`),
      );
    }

    const id = this.nextRequestId++;
    const message: JsonRpcRequestMessage = {
      jsonrpc: "2.0",
      id,
      method,
    };
    if (params !== undefined) {
      message.params = params;
    }

    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve: (value) => resolve(value as T),
        reject,
      };

      if (timeoutMs > 0) {
        pending.timeout = setTimeout(() => {
          this.pending.delete(id);
          pending.cancellationDisposable?.dispose();
          this.notify("$/cancelRequest", { id });
          reject(new Error(`JSON-RPC request timed out: ${method}`));
        }, timeoutMs);
      }

      this.pending.set(id, pending);

      try {
        this.write(message);
      } catch (error) {
        this.pending.delete(id);
        pending.cancellationDisposable?.dispose();
        if (pending.timeout !== undefined) {
          clearTimeout(pending.timeout);
        }
        reject(error);
        return;
      }

      if (cancellationToken !== undefined) {
        const cancel = () => {
          if (!this.pending.has(id)) {
            return;
          }
          this.pending.delete(id);
          if (pending.timeout !== undefined) {
            clearTimeout(pending.timeout);
          }
          this.notify("$/cancelRequest", { id });
          reject(new RequestCancelledError(`${method} was cancelled.`));
        };

        if (cancellationToken.isCancellationRequested) {
          cancel();
          return;
        }
        pending.cancellationDisposable =
          cancellationToken.onCancellationRequested(cancel);
      }
    });
  }

  public notify(method: string, params?: unknown): void {
    if (this.closed) {
      return;
    }

    const message: JsonRpcNotificationMessage = {
      jsonrpc: "2.0",
      method,
    };
    if (params !== undefined) {
      message.params = params;
    }
    this.write(message);
  }

  public dispose(reason = new JsonRpcConnectionClosedError()): void {
    this.close(reason);
    this.input.removeListener("data", this.onDataBound);
    this.input.removeListener("error", this.onErrorBound);
    this.input.removeListener("end", this.onEndBound);
    this.input.removeListener("close", this.onEndBound);
  }

  private write(message: JsonRpcMessage): void {
    if (this.closed) {
      throw new JsonRpcConnectionClosedError();
    }

    const body = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.from(
      `Content-Length: ${body.byteLength}\r\n\r\n`,
      "ascii",
    );
    this.output.write(Buffer.concat([header, body]));
    if (this.log !== undefined) {
      this.log(
        `--> ${"method" in message ? message.method : "response"}`,
        redactSecrets(message),
      );
    }
  }

  private onData(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    this.inputBuffer = Buffer.concat([this.inputBuffer, bytes]);

    while (true) {
      const headerEnd = this.inputBuffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }

      const header = this.inputBuffer.subarray(0, headerEnd).toString("ascii");
      const contentLengthLine = header
        .split("\r\n")
        .find((line) => /^content-length\s*:/i.test(line));
      if (contentLengthLine === undefined) {
        this.close(new Error("LSP message does not contain Content-Length."));
        return;
      }

      const contentLength = Number.parseInt(
        contentLengthLine.split(":", 2)[1]?.trim() ?? "",
        10,
      );
      if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
        this.close(
          new Error("LSP message contains an invalid Content-Length."),
        );
        return;
      }

      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;
      if (this.inputBuffer.byteLength < messageEnd) {
        return;
      }

      const body = this.inputBuffer
        .subarray(messageStart, messageEnd)
        .toString("utf8");
      this.inputBuffer = this.inputBuffer.subarray(messageEnd);
      try {
        const parsed: unknown = JSON.parse(body);
        if (parsed === null || typeof parsed !== "object") {
          throw new Error("JSON-RPC message must be an object.");
        }
        const message = parsed as JsonRpcMessage;
        this.dispatch(message);
      } catch (error) {
        this.log?.("Failed to parse a JSON-RPC message.", {
          error: String(error),
        });
      }
    }
  }

  private dispatch(message: JsonRpcMessage): void {
    if ("method" in message) {
      if ("id" in message) {
        void this.handleRequest(message);
      } else {
        this.notificationHandler(message.method, message.params);
      }
      return;
    }

    const pending = this.pending.get(message.id);
    if (pending === undefined) {
      this.log?.("Received a response for an unknown request.", {
        id: message.id,
      });
      return;
    }

    this.pending.delete(message.id);
    pending.cancellationDisposable?.dispose();
    if (pending.timeout !== undefined) {
      clearTimeout(pending.timeout);
    }

    if (message.error !== undefined) {
      pending.reject(
        new JsonRpcRemoteError(
          message.error.code,
          message.error.message,
          message.error.data,
        ),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  private async handleRequest(message: JsonRpcRequestMessage): Promise<void> {
    try {
      const result = await this.requestHandler(message.method, message.params);
      if (!this.closed) {
        this.write({ jsonrpc: "2.0", id: message.id, result });
      }
    } catch (error) {
      if (!this.closed) {
        try {
          this.write({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : String(error),
            },
          });
        } catch {
          // The peer may have closed while the request handler was running.
        }
      }
    }
  }

  private close(reason: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.cancellationDisposable?.dispose();
      if (pending.timeout !== undefined) {
        clearTimeout(pending.timeout);
      }
      pending.reject(reason);
    }
    this.pending.clear();
  }
}
