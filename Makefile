.PHONY: demo demo-stakeholder

demo:
	@set -eu; \
	corepack pnpm build >/dev/null; \
	demo_dir=$$(mktemp -d "$${TMPDIR:-/tmp}/recruitos-demo.XXXXXX"); \
	trap 'rm -rf "$$demo_dir"' EXIT; \
	database="$$demo_dir/runtime.db"; \
	prepared=$$(node apps/cli/dist/bin.js demo:prepare --db "$$database" --json); \
	candidate_id=$$(printf '%s' "$$prepared" | node -e 'const fs=require("node:fs");const value=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(value.data.candidateIds[0]);'); \
	node apps/cli/dist/bin.js packet "$$candidate_id" --db "$$database"; \
	node apps/cli/dist/bin.js eval:class1 --candidate-id "$$candidate_id" --db "$$database"

demo-stakeholder:
	@set -eu; \
	corepack pnpm build >/dev/null; \
	demo_dir=$$(mktemp -d "$${TMPDIR:-/tmp}/recruitos-stakeholder.XXXXXX"); \
	trap 'rm -rf "$$demo_dir"' EXIT; \
	database="$$demo_dir/runtime.db"; \
	node scripts/demo-stakeholder.mjs --db "$$database"
