import type { CodingBackend } from "../backend/index.js";
import type { PlatformAdapter } from "../platform/index.js";
import type { SandboxProvider } from "../sandbox/index.js";
import type { Mention } from "../types.js";

/** Per-thread coordination state, held in router memory only. See spec §3, §4.1. */
type TurnState = "idle" | "running";

interface ThreadState {
  state: TurnState;
  pending: boolean;
}

/**
 * Router — plumbing, NOT an LLM (spec §6). It owns: immediate-ACK ingress (in
 * the adapter), idempotent dispatch, the idle/running/pending state machine +
 * coalescing (§4.1), boundary logging (§4.9), and turn dispatch. It interprets
 * the agent's output only via CodingBackend.parseResult.
 *
 * This is a skeleton: the seam wiring is real; the full turn lifecycle
 * (coalescing, boundary logging, session-id capture, eviction) is TODO.
 */
export class Router {
  /** Transient coordination state (§3, bucket 2) — lost on restart, by design. */
  private readonly threads = new Map<string, ThreadState>();
  /** Idempotent dispatch on ts (§4.1). A real impl TTLs this to the retry window. */
  private readonly seenTs = new Set<string>();

  constructor(
    private readonly platform: PlatformAdapter,
    private readonly sandbox: SandboxProvider,
    private readonly backend: CodingBackend,
  ) {}

  start(): void {
    this.platform.onMention((mention) => {
      this.onMention(mention).catch((err) => console.error("[router] turn failed", err));
    });
  }

  private async onMention(mention: Mention): Promise<void> {
    // 1. Idempotent dispatch on ts — drop already-accepted triggers (§4.1).
    if (this.seenTs.has(mention.ts)) {
      return;
    }
    this.seenTs.add(mention.ts);

    // 2. idle/running/pending state machine + coalescing (§4.1).
    //    TODO: if running, set pending and return; coalesce on completion.
    const key = `${mention.thread.channel}:${mention.thread.threadTs}`;
    const thread = this.threads.get(key) ?? { state: "idle", pending: false };
    thread.state = "running";
    this.threads.set(key, thread);

    // 3. Dispatch (minimal happy path). A real impl resolves-or-creates the
    //    sandbox by deterministic name (§4.1, §4.3), drives the turn so its
    //    stream-reader/logger outlives the dispatch (§4.1, §4.9), persists the
    //    session id (§4.5), and acks with a reaction first (§4.1/§4.2).
    const sandboxName = `t-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    const handle = await this.sandbox.create(sandboxName, "<repo-ref>");
    const argv = this.backend.turnArgs(mention.text);
    const result = await this.sandbox.exec(handle, argv); // raw stream — log at the boundary (§4.9)
    const { finalText, ok } = this.backend.parseResult(result.stdout);
    await this.platform.postReply(mention.thread, ok ? finalText : "Turn failed.");

    thread.state = "idle";
  }
}
