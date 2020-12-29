import { EventEmitter } from "events";
import { Logger } from "pino";
import { generateChildLogger } from "@pedrouid/pino-utils";
import { RelayTypes, IRelay } from "@walletconnect/types";
import { RelayJsonRpc, RELAY_JSONRPC } from "relay-provider";
import { encrypt, decrypt } from "@walletconnect/utils";
import { utf8ToHex, hexToUtf8 } from "enc-utils";
import {
  IJsonRpcProvider,
  formatJsonRpcRequest,
  JsonRpcPayload,
  isJsonRpcRequest,
  JsonRpcRequest,
  formatJsonRpcResult,
} from "@json-rpc-tools/utils";
import { JsonRpcProvider } from "@json-rpc-tools/provider";
import { safeJsonParse, safeJsonStringify } from "safe-json-utils";

import {
  RELAY_CONTEXT,
  RELAY_DEFAULT_PROTOCOL,
  RELAY_DEFAULT_RPC_URL,
  RELAY_DEFAULT_PUBLISH_TTL,
} from "../constants";

function getRelayProtocolJsonRpc(protocol: string) {
  const jsonrpc = RELAY_JSONRPC[protocol];
  if (typeof jsonrpc === "undefined") {
    throw new Error(`Relay Protocol not supported: ${protocol}`);
  }
  return jsonrpc;
}

export class Relay extends IRelay {
  public events = new EventEmitter();

  public provider: IJsonRpcProvider;

  public context: string = RELAY_CONTEXT;

  constructor(public logger: Logger, provider?: string | IJsonRpcProvider) {
    super(logger);
    this.logger = generateChildLogger(logger, this.context);

    this.provider = this.setProvider(provider);
    this.provider.on("payload", (payload: JsonRpcPayload) => this.onPayload(payload));
    this.provider.on("connect", () => this.events.emit("connect"));
    this.provider.on("disconnect", () => this.events.emit("disconnect"));
    this.provider.on("error", e => this.events.emit("error", e));
  }

  public async init(): Promise<void> {
    this.logger.trace(`Initialized`);
    await this.provider.connect();
  }

  public async publish(
    topic: string,
    payload: JsonRpcPayload,
    opts?: RelayTypes.PublishOptions,
  ): Promise<void> {
    this.logger.debug(`Publishing Payload`);
    this.logger.trace({ type: "method", method: "publish", params: { topic, payload, opts } });
    try {
      const protocol = opts?.relay.protocol || RELAY_DEFAULT_PROTOCOL;
      const msg = safeJsonStringify(payload);
      const message = opts?.encryptKeys
        ? await encrypt({
            ...opts.encryptKeys,
            message: msg,
          })
        : utf8ToHex(msg);
      const jsonRpc = getRelayProtocolJsonRpc(protocol);
      const request = formatJsonRpcRequest<RelayJsonRpc.PublishParams>(jsonRpc.publish, {
        topic,
        message,
        ttl: opts?.ttl || RELAY_DEFAULT_PUBLISH_TTL,
      });
      this.logger.info(`Outgoing Relay Payload`);
      this.logger.debug({ type: "payload", direction: "outgoing", request });
      await this.provider.request(request);
      this.logger.debug(`Successfully Published Payload`);
      this.logger.trace({ type: "method", method: "publish", request });
    } catch (e) {
      this.logger.debug(`Failed to Publish Payload`);
      this.logger.error(e);
      throw e;
    }
  }

  public async subscribe(
    topic: string,
    listener: (payload: JsonRpcPayload) => void,
    opts?: RelayTypes.SubscribeOptions,
  ): Promise<string> {
    this.logger.debug(`Subscribing Topic`);
    this.logger.trace({ type: "method", method: "subscribe", params: { topic, opts } });
    try {
      const protocol = opts?.relay.protocol || RELAY_DEFAULT_PROTOCOL;
      const jsonRpc = getRelayProtocolJsonRpc(protocol);
      const request = formatJsonRpcRequest<RelayJsonRpc.SubscribeParams>(jsonRpc.subscribe, {
        topic,
      });
      this.logger.info(`Outgoing Relay Payload`);
      this.logger.debug({ type: "payload", direction: "outgoing", request });
      const id = await this.provider.request(request);
      this.events.on(id, async ({ message }) => {
        const payload = safeJsonParse(
          opts?.decryptKeys
            ? await decrypt({
                ...opts.decryptKeys,
                encrypted: message,
              })
            : hexToUtf8(message),
        );
        listener(payload);
      });
      this.logger.debug(`Successfully Subscribed Topic`);
      this.logger.trace({ type: "method", method: "subscribe", request });
      return id;
    } catch (e) {
      this.logger.debug(`Failed to Subscribe Topic`);
      this.logger.error(e);
      throw e;
    }
  }

  public async unsubscribe(id: string, opts?: RelayTypes.SubscribeOptions): Promise<void> {
    this.logger.debug(`Unsubscribing Topic`);
    this.logger.trace({ type: "method", method: "unsubscribe", params: { id, opts } });
    try {
      const protocol = opts?.relay.protocol || RELAY_DEFAULT_PROTOCOL;
      const jsonRpc = getRelayProtocolJsonRpc(protocol);
      const request = formatJsonRpcRequest<RelayJsonRpc.UnsubscribeParams>(jsonRpc.unsubscribe, {
        id,
      });
      this.logger.info(`Outgoing Relay Payload`);
      this.logger.debug({ type: "payload", direction: "outgoing", request });

      await this.provider.request(request);
      this.events.removeAllListeners(id);
      this.logger.debug(`Successfully Unsubscribed Topic`);
      this.logger.trace({ type: "method", method: "unsubscribe", request });
    } catch (e) {
      this.logger.debug(`Failed to Unsubscribe Topic`);
      this.logger.error(e);
      throw e;
    }
  }

  public on(event: string, listener: any): void {
    this.events.on(event, listener);
  }

  public once(event: string, listener: any): void {
    this.events.once(event, listener);
  }

  public off(event: string, listener: any): void {
    this.events.off(event, listener);
  }

  public removeListener(event: string, listener: any): void {
    this.events.removeListener(event, listener);
  }

  // ---------- Private ----------------------------------------------- //

  private onPayload(payload: JsonRpcPayload) {
    this.logger.info(`Incoming Relay Payload`);
    this.logger.debug({ type: "payload", direction: "incoming", payload });
    if (isJsonRpcRequest(payload)) {
      if (payload.method.endsWith("_subscription")) {
        const event = (payload as JsonRpcRequest<RelayJsonRpc.SubscriptionParams>).params;
        this.events.emit(event.id, event.data);
        const response = formatJsonRpcResult(payload.id, true);
        this.provider.connection.send(response);
      }
    }
  }

  private setProvider(provider?: string | IJsonRpcProvider): IJsonRpcProvider {
    this.logger.debug(`Setting Relay Provider`);
    this.logger.trace({ type: "method", method: "setProvider", provider: provider?.toString() });
    const rpcUrl = typeof provider === "string" ? provider : RELAY_DEFAULT_RPC_URL;
    return typeof provider !== "string" && typeof provider !== "undefined"
      ? provider
      : new JsonRpcProvider(rpcUrl);
  }
}
