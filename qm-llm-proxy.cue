package aegis

// Intent: QM host dlp-proxy observer.
// This intent is NOT booted as a VM — it carries the observe + ai config
// consumed HOST-side by aegis-core's MITM tap and fleet forwarder.
// Embed the minimal "computer" profile so CUE resolves cleanly.
//
// WIRE: QM's agent (pi or claude harness) speaks the ANTHROPIC messages wire
// (POST /v1/messages), NOT OpenAI /v1/chat/completions. So capture runs
// through the existing claude_h1 path (handle_mitm_claude), NOT the OpenAI
// handlers. Two destinations, depending on the harness:
//   - HARNESS=claude, ANTHROPIC_BASE_URL unset → hits api.anthropic.com,
//     which the host proxy AUTO-inspects (hardwired to handle_mitm_claude).
//     No ai.endpoint entry is needed for that case — observe alone captures it.
//   - HARNESS=pi (PI_MODEL=gemma via LiteLLM) → hits the trycloudflare tunnel
//     speaking the Anthropic wire; that arbitrary host must be declared below
//     with wire_format:"anthropic" so the proxy routes it to handle_mitm_claude.
//
// NOTE: the ai.endpoint host below is a trycloudflare tunnel and ROTATES
// every time the `cloudflared tunnel` process restarts. Update it whenever
// the QM LiteLLM tunnel URL changes.

intent: #Profile & {
	profile: "computer"

	// Placeholder image — not booted; this intent is host-only.
	oci_image:     "docker.io/library/busybox:latest"
	force_nonroot: true

	observe: {
		prompts:   "full"
		payloads:  "full"
		fleet_url: "http://127.0.0.1:8091"
		identity:  "qm"
	}

	// Only needed for the LiteLLM-tunnel (HARNESS=pi) case; harmless/unused when
	// QM hits api.anthropic.com directly (that host is auto-inspected).
	ai: endpoint: [
		{
			// ponytail: ROTATES — update when the cloudflared tunnel restarts
			host:        "describing-optional-correspondence-allocation.trycloudflare.com:443"
			wire_format: "anthropic"
		},
	]
}
