// Aegis sandbox backend — runs each qm agent computer as an Aegis microVM (libkrun +
// OCI image), adding wire-level DLP + credential custody (real API keys never enter the
// sandbox) + deny-all egress on top of the same local-microVM model as `smolmachines`.
//
// Transport: aegis-core boots in `computer` mode and exposes a localhost HTTP control
// surface (POST /exec {script,timeout_sec} → {code,stdout,stderr}; POST /teardown). One
// process == one provisioned computer. File ops ride on /exec via createExecFileOps, so
// this backend only needs exec + teardown — exactly like smolmachines rides on exec.
//
// NOTE: draft — verified end-to-end at the transport layer from Node (spawn → /exec with
// state persistence → /teardown); still needs a `tsc` pass against qm's build + wiring.

import { spawn, type ChildProcess } from "node:child_process";
import { shq } from "../util/shell.ts";
import type { WorkspaceLayer } from "../types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { createExecFileOps, posixJoin } from "./exec-file-ops.ts";
import {
  type AgentComputerProfile,
  type ExecOptions,
  type ExecResult,
  type ProvisionOptions,
  type Sandbox,
  type SandboxHandle,
  type TeardownOptions,
} from "./sandbox.ts";

export interface AegisSandboxConfig {
  /** Path to the aegis-core binary. */
  aegisBin: string;
  /** Path to a `mode=computer` policy.toml (declares [rootfs] oci_image + egress). */
  computerPolicy: string;
  /** Working dir aegis-core runs from (so its aegis-rootfs/alpine-rootfs resolve). */
  cwd: string;
  /** Guest workspace dir (matches the image workdir / a writable mount). */
  workspaceDir?: string;
  homeDir?: string;
  defaultTimeoutSec?: number;
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

interface Computer {
  proc: ChildProcess;
  port: number;
}

const NON_INTERACTIVE = "set -o pipefail 2>/dev/null; ";

export function createAegisSandbox(_workspace: WorkspaceStore, cfg: AegisSandboxConfig): Sandbox {
  const workspaceDir = cfg.workspaceDir ?? "/workspace";
  const homeDir = cfg.homeDir ?? "/home/agent";
  const defaultTimeoutSec = cfg.defaultTimeoutSec ?? 120;
  const byId = new Map<string, Computer>();

  const profile: AgentComputerProfile = {
    backend: "aegis",
    writablePersistence: "snapshot_to_workspace",
    processSessions: false,
    egressEnforcement: "domain", // Aegis enforces deny-all egress + DLP at the wire
    spec: { os: "linux", workdir: workspaceDir, homeDir },
  };

  // Boot one aegis-core `computer` process; resolve when it prints its control port.
  async function boot(id: string): Promise<Computer> {
    const proc = spawn(cfg.aegisBin, ["--policy", cfg.computerPolicy], {
      cwd: cfg.cwd,
      env: { ...process.env },
    });
    const port = await new Promise<number>((resolve, reject) => {
      let buf = "";
      const to = setTimeout(() => reject(new Error(`aegis computer ${id}: no control port in 30s`)), 30_000);
      proc.stdout?.on("data", (d: Buffer) => {
        buf += d.toString();
        const m = buf.match(/AEGIS_COMPUTER_LISTENING=(\d+)/);
        if (m) { clearTimeout(to); resolve(Number(m[1])); }
      });
      proc.once("exit", (code) => { clearTimeout(to); reject(new Error(`aegis computer ${id} exited early (${code})`)); });
    });
    const computer: Computer = { proc, port };
    byId.set(id, computer);
    // Greppable telemetry: one line per microVM booted (count sandboxes with
    // `grep -c "aegis: computer BOOTED"` on qm's log). One computer per scopeId, reused across turns.
    console.error(`[aegis] computer BOOTED id=${id} port=${port} pid=${proc.pid} (live=${byId.size})`);
    return computer;
  }

  async function execRaw(id: string, script: string, timeoutSec: number): Promise<ExecResult> {
    const c = byId.get(id);
    if (!c) throw new Error(`aegis exec: unknown computer ${id}`);
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), (timeoutSec + 5) * 1000);
    try {
      const res = await fetch(`http://127.0.0.1:${c.port}/exec`, {
        method: "POST",
        body: JSON.stringify({ script, timeout_sec: timeoutSec }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`aegis exec http ${res.status}`);
      const j = (await res.json()) as { code: number; stdout: string; stderr: string };
      return { stdout: j.stdout, stderr: j.stderr, code: j.code, timedOut: false };
    } finally {
      clearTimeout(to);
    }
  }

  // File ops on top of exec (base64), shared with listDir/removeDir/extractFiles.
  const execFileOps = createExecFileOps({
    label: "aegis",
    exec: (id, script, timeoutSec) => execRaw(id, script, timeoutSec),
    writeInline: async (id, abs, data) => {
      const b64 = Buffer.from(data).toString("base64");
      const r = await execRaw(id, `mkdir -p ${shq(abs.replace(/\/[^/]*$/, "") || "/")} && printf %s ${shq(b64)} | base64 -d > ${shq(abs)}`, 60);
      if (r.code !== 0) throw new Error(`aegis writeInline failed: ${r.stderr}`);
    },
  });

  const sandbox: Sandbox = {
    profile,
    ...execFileOps,

    async provision(layers: WorkspaceLayer[], provOpts?: ProvisionOptions): Promise<SandboxHandle> {
      const writable = layers.find((l) => l.mode === "rw") ?? layers[0];
      const id = writable?.scopeId ?? "default";
      if (!byId.has(id)) await boot(id);
      const handle: SandboxHandle = {
        id,
        rootDir: workspaceDir,
        homeDir,
        backend: "aegis",
        ...(provOpts?.env ? { env: provOpts.env } : {}),
      };
      const prep = await execRaw(id, `mkdir -p ${shq(workspaceDir)}`, 60);
      if (prep.code !== 0) throw new Error(`aegis provision prep: ${prep.stderr}`);
      return handle;
    },

    async run(handle, command, execOpts?: ExecOptions): Promise<ExecResult> {
      const timeoutSec = execOpts?.timeoutMs ? Math.ceil(execOpts.timeoutMs / 1000) : defaultTimeoutSec;
      const exports = Object.entries(handle.env ?? {})
        .map(([k, v]) => `export ${k}=${shq(v)}`)
        .join("; ");
      const script = `${NON_INTERACTIVE}${exports ? exports + "; " : ""}cd ${shq(handle.rootDir)} 2>/dev/null; ${command}`;
      return execRaw(handle.id, script, timeoutSec);
    },

    async writeFileBytes(handle, relPath, data): Promise<void> {
      await execFileOps.extractFiles(handle, [{ path: relPath, data }]);
    },
    async writeFile(handle, relPath, data): Promise<void> {
      await sandbox.writeFileBytes(handle, relPath, Buffer.from(data, "utf8"));
    },
    async readFileBytes(handle, relPath): Promise<Uint8Array | null> {
      const abs = posixJoin(handle.rootDir, relPath);
      const r = await execRaw(handle.id, `base64 ${shq(abs)} 2>/dev/null`, 60);
      if (r.code !== 0) return null;
      return new Uint8Array(Buffer.from(r.stdout.replace(/\s+/g, ""), "base64"));
    },
    async readFile(handle, relPath): Promise<string | null> {
      const bytes = await sandbox.readFileBytes(handle, relPath);
      return bytes === null ? null : Buffer.from(bytes).toString("utf8");
    },

    async teardown(handle, _tdOpts?: TeardownOptions): Promise<void> {
      const c = byId.get(handle.id);
      if (!c) return;
      byId.delete(handle.id);
      console.error(`[aegis] computer TEARDOWN id=${handle.id} port=${c.port} (live=${byId.size})`);
      try {
        await fetch(`http://127.0.0.1:${c.port}/teardown`, { method: "POST" });
      } catch (e) {
        cfg.onError?.({ category: "aegis_sandbox", code: "teardown", message: String(e), scopeLabel: handle.id });
      }
      setTimeout(() => { try { c.proc.kill(); } catch {} }, 3000);
    },
  };

  return sandbox;
}
