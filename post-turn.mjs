// Send one signed turn to local qm core. Usage: node post-turn.mjs "your prompt"  [threadRef]
import { signedHeaders } from "./plugins/chassis/src/core-client.ts";
import { readFileSync } from "node:fs";
const env = Object.fromEntries(readFileSync(".env","utf8").split("\n")
  .filter(l=>l && !l.startsWith("#") && l.includes("="))
  .map(l=>{const i=l.indexOf("=");return [l.slice(0,i), l.slice(i+1)];}));
const text = process.argv[2] ?? "Write a bash script hello.sh that prints uname -a and id -u, save it to the workspace, run it, show the output.";
const threadRef = process.argv[3] ?? `t-${Date.now()}`;   // new thread => new sandbox; reuse a threadRef to reuse the sandbox
const path = "/v1/turns";
const body = JSON.stringify({
  surface:"api", actor:{externalId:"pk-dev"},
  conversation:{kind:"channel", channelRef:"C-test", threadRef, audience:[]},
  text,
});
const headers = signedHeaders(env.CORE_SIGNING_SECRET, "POST", path, body);
const t0 = Date.now();
const res = await fetch(`http://localhost:8080${path}`, { method:"POST", headers, body });
console.log(`[http=${res.status} time=${((Date.now()-t0)/1000).toFixed(1)}s thread=${threadRef}]`);
const j = await res.text();
try { console.log(JSON.parse(j).reply ?? j); } catch { console.log(j); }
