import ivm from "isolated-vm";
import type { AgentState, AgentAction } from "./types";

const MEMORY_LIMIT_MB = 50;
const TIMEOUT_MS = 500;

export type SandboxResult =
  | { ok: true; action: AgentAction }
  | { ok: false; reason: "timeout" | "crash"; error: string };

export async function sandboxCall(
  code: string,
  state: AgentState
): Promise<SandboxResult> {
  const isolate = new ivm.Isolate({ memoryLimit: MEMORY_LIMIT_MB });
  const context = await isolate.createContext();
  const jail = context.global;
  await jail.set("global", jail.derefInto());

  try {
    const compiled = await isolate.compileScript(
      code + `\n;globalThis.act = act;`
    );
    await compiled.run(context);

    const stateJson = JSON.stringify(state);
    const resultPromise = context.eval(
      `JSON.stringify(act(JSON.parse('${stateJson.replace(/'/g, "\\'")}')))`,
      { timeout: TIMEOUT_MS }
    );

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("TIMEOUT")), TIMEOUT_MS + 100)
    );

    const raw = await Promise.race([resultPromise, timeoutPromise]);
    const action = JSON.parse(raw) as AgentAction;
    return { ok: true, action };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    if (message.includes("TIMEOUT") || message.includes("timeout")) {
      return { ok: false, reason: "timeout", error: "act() exceeded 500ms" };
    }
    return { ok: false, reason: "crash", error: message };
  } finally {
    isolate.dispose();
  }
}
