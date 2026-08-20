import { signedHeaders } from "./plugins/chassis/src/core-client.ts";
import { readFileSync } from "node:fs";
const env = Object.fromEntries(readFileSync(".env","utf8").split("\n")
  .filter(l=>l && !l.startsWith("#") && l.includes("="))
  .map(l=>{const i=l.indexOf("=");return [l.slice(0,i), l.slice(i+1)];}));
const path = "/v1/admin/custom-providers/litellm";
const body = JSON.stringify({
  name: "Home DGX (LiteLLM)",
  protocol: "openai",
  baseUrl: env.LITELLM_BASE_URL,   // set in .env (gitignored) — ephemeral tunnel URL
  models: [{ id: "gemma-4-31B", name: "Gemma 4 31B", contextWindow: 131072, maxTokens: 8192 }],
  apiKey: "sk-litellm-noauth",
  validate: false,
});
const headers = { ...signedHeaders(env.CORE_SIGNING_SECRET, "PUT", path, body), "x-admin-actor": "admin-alice@test" };
const res = await fetch(`http://localhost:8080${path}`, { method: "PUT", headers, body });
console.log(`[http=${res.status}]`, (await res.text()).slice(0, 600));
