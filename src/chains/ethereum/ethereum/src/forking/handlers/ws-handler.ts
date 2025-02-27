import { EthereumInternalOptions } from "@ganache/ethereum-options";
import { AbortError, CodedError } from "@ganache/ethereum-utils";
import { AbortSignal } from "abort-controller";
import WebSocket from "ws";
import { Handler } from "../types";
import { BaseHandler } from "./base-handler";
import Deferred, { DeferredPromise } from "../deferred";
import { JsonRpcResponse, JsonRpcError } from "@ganache/utils";

const { JSONRPC_PREFIX } = BaseHandler;

export class WsHandler extends BaseHandler implements Handler {
  private open: Promise<unknown>;
  private connection: WebSocket;
  private inFlightRequests = new Map<
    string | number,
    DeferredPromise<{
      response: JsonRpcResponse | JsonRpcError;
      raw: string | Buffer;
    }>
  >();

  constructor(options: EthereumInternalOptions, abortSignal: AbortSignal) {
    super(options, abortSignal);

    const { url, origin } = options.fork;

    this.connection = new WebSocket(url.toString(), {
      origin,
      headers: this.headers
    });
    // `nodebuffer` is already the default, but I just wanted to be explicit
    // here because when `nodebuffer` is the binaryType the `message` event's
    // data type is guaranteed to be a `Buffer`. We don't need to check for
    // different types of data.
    // I mention all this because if `arraybuffer` or `fragment` is used for the
    // binaryType the `"message"` event's `data` may end up being
    // `ArrayBuffer | Buffer`, or `Buffer[] | Buffer`, respectively.
    // If you need to change this, you probably need to change our `onMessage`
    // handler too.
    this.connection.binaryType = "nodebuffer";

    this.open = this.connect(this.connection);
    this.connection.onclose = () => {
      // try to connect again...
      // TODO: backoff and eventually fail
      this.open = this.connect(this.connection);
    };
    this.abortSignal.addEventListener("abort", () => {
      this.connection.onclose = null;
      this.connection.close(1000);
    });
    this.connection.onmessage = this.onMessage.bind(this);
  }

  public async request<T>(method: string, params: unknown[]) {
    await this.open;
    if (this.abortSignal.aborted) return Promise.reject(new AbortError());

    const key = JSON.stringify({ method, params });

    const send = () => {
      if (this.abortSignal.aborted) return Promise.reject(new AbortError());

      const messageId = this.id++;
      const deferred = Deferred<{
        response: JsonRpcResponse | JsonRpcError;
        raw: string | Buffer;
      }>();

      // TODO: timeout an in-flight request after some amount of time
      this.inFlightRequests.set(messageId, deferred);

      this.connection.send(`${JSONRPC_PREFIX}${messageId},${key.slice(1)}`);
      return deferred.promise.finally(() => this.requestCache.delete(key));
    };
    return await this.queueRequest<T>(key, send);
  }

  public onMessage(event: WebSocket.MessageEvent) {
    if (event.type !== "message") return;

    // data is always a `Buffer` because the websocket's binaryType is set to
    // `nodebuffer`
    const raw = event.data as Buffer;

    // TODO: handle invalid JSON (throws on parse)?
    const response = JSON.parse(raw) as JsonRpcResponse | JsonRpcError;
    const id = response.id;
    const prom = this.inFlightRequests.get(id);
    if (prom) {
      this.inFlightRequests.delete(id);
      prom.resolve({ response, raw: raw });
    }
  }

  private connect(connection: WebSocket) {
    let open = new Promise((resolve, reject) => {
      connection.onopen = resolve;
      connection.onerror = reject;
    });
    open.then(
      () => {
        connection.onopen = null;
        connection.onerror = null;
      },
      err => {
        console.log(err);
      }
    );
    return open;
  }

  public close() {
    this.connection.close();
    return Promise.resolve();
  }
}
