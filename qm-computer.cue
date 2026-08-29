package aegis

// Intent: QM computer sandbox — bare buildpack-deps container used by the
// QM orchestrator as a persistent agent computer. Replaces aegis-computer-policy.toml
// (lives here, with QM's source). The generic "computer" profile it embeds lives
// in the Aegis repo — resolve it via AEGIS_PROFILES_DIR.
//
//   AEGIS_PROFILES_DIR=/path/to/aegis/machines/profiles \
//     aegis-core --policy /Users/pk/work/qm/qm-computer.cue

intent: #Profile & {
	profile: "computer"

	oci_image:     "docker.io/library/buildpack-deps:bookworm-scm"
	mode:          "computer"
	force_nonroot: true

	resources: {
		mem_mb: 512
		cpus:   2
	}

	egress: {
		bundles: []
		allow_hosts: [
			"github.com:443",
			"api.github.com:443",
			"codeload.github.com:443",
			"objects.githubusercontent.com:443",
			"raw.githubusercontent.com:443",
			"stryv.com:443", // allow the Stryv product page for marketing research
		]
	}

	// Forward this computer's lifecycle (boot + exec/actions + network) to the Console when it
	// boots on a tool turn — so the QM computer sandbox appears, not just the host proxy.
	observe: {
		fleet_url: "http://127.0.0.1:8091"
		identity:  "qm-computer"
	}

	git: secret: "GITHUB_TOKEN"

	dlp: rules: [
		{on: "github.post", match: "secret",      action: "block"},
		{on: "github.post", match: "credit_card", action: "block"},
		{on: "github.post", match: "ssn",         action: "block"},
	]
}
