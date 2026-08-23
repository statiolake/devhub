import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  TerminalAckRequest,
  TerminalAttachReceipt,
  TerminalClient,
  TerminalDetachRequest,
  TerminalInputRequest,
  TerminalResizeRequest,
  TerminalTransport,
} from "../terminal/client";

export const AGENT_SURFACE_ATTACH_COMMAND = "agent_surface_attach" as const;
export const AGENT_SURFACE_INPUT_COMMAND = "agent_surface_input" as const;
export const AGENT_SURFACE_RESIZE_COMMAND = "agent_surface_resize" as const;
export const AGENT_SURFACE_ACKNOWLEDGE_COMMAND =
  "agent_surface_acknowledge" as const;
export const AGENT_SURFACE_DETACH_COMMAND = "agent_surface_detach" as const;

const tauriTransport: TerminalTransport = {
  invoke: <T>(command: string, args: Record<string, unknown>) =>
    invoke<T>(command, args),
  channel(onMessage) {
    const channel = new Channel<unknown>();
    channel.onmessage = onMessage;
    return channel;
  },
};

export function createAgentSurfaceClient(
  transport: TerminalTransport = tauriTransport,
): TerminalClient {
  return {
    async attach(request, onFrame) {
      const channel = transport.channel(onFrame);
      return transport.invoke<TerminalAttachReceipt>(
        AGENT_SURFACE_ATTACH_COMMAND,
        { payload: request, channel },
      );
    },
    async input(request: TerminalInputRequest) {
      await transport.invoke<void>(AGENT_SURFACE_INPUT_COMMAND, {
        payload: request,
      });
    },
    async resize(request: TerminalResizeRequest) {
      await transport.invoke<void>(AGENT_SURFACE_RESIZE_COMMAND, {
        payload: request,
      });
    },
    async acknowledge(request: TerminalAckRequest) {
      await transport.invoke<void>(AGENT_SURFACE_ACKNOWLEDGE_COMMAND, {
        payload: request,
      });
    },
    async detach(request: TerminalDetachRequest) {
      await transport.invoke<void>(AGENT_SURFACE_DETACH_COMMAND, {
        payload: request,
      });
    },
  };
}

export const defaultAgentSurfaceClient = createAgentSurfaceClient();
