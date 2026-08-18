// C4: qm's OWN test harness driving the Aegis backend through the Sandbox contract.
// Boots a real Aegis microVM (aegis-core computer mode) and exercises provision → run →
// writeFile/readFile → run-reads-file → teardown. Proves qm can execute agent-turn work
// inside an Aegis sandbox.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAegisSandbox } from "../src/sandbox/aegis-sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import type { WorkspaceLayer } from "../src/types.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";

const POC = "/Users/pk/work/POC";

const sandbox: Sandbox = createAegisSandbox(
  createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "aegis-ws-"))),
  {
    aegisBin: `${POC}/aegis-core/target/debug/aegis-core`,
    computerPolicy: "/tmp/computer-policy.toml",
    cwd: POC,
    // The base image's / is owned by the host extractor uid and guest-root lacks
    // CAP_DAC_OVERRIDE, so put the scratch workspace under world-writable /tmp.
    // (Proper fix — idmap the OS-layer mount host_euid→0 — is a tracked follow-up.)
    workspaceDir: "/tmp/aegis-workspace",
  },
);

const layers: WorkspaceLayer[] = [{ scopeId: "t1", mountPath: "/workspace", mode: "rw" }];
let handle: SandboxHandle;

before(async () => {
  handle = await sandbox.provision(layers); // boots the Aegis microVM
}, { timeout: 60_000 });

after(async () => {
  if (handle) await sandbox.teardown(handle);
});

test("profile advertises the aegis backend with egress enforcement", () => {
  assert.equal(sandbox.profile.backend, "aegis");
  assert.equal(sandbox.profile.egressEnforcement, "domain");
});

test("run executes a command in the Aegis sandbox", { timeout: 30_000 }, async () => {
  const r = await sandbox.run(handle, "echo hello-from-qm; id -u");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /hello-from-qm/);
});

test("writeFile/readFile round-trip + state persists across runs", { timeout: 30_000 }, async () => {
  await sandbox.writeFile(handle, "note.txt", "qm-payload-42");
  const back = await sandbox.readFile(handle, "note.txt");
  assert.equal(back, "qm-payload-42");
  // A later run in the same computer sees the file — persistent computer.
  const r = await sandbox.run(handle, "cat note.txt");
  assert.match(r.stdout, /qm-payload-42/);
});
