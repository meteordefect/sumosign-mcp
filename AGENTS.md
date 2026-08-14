# AGENTS.md — @sumosign/mcp

Cursor router for the published MCP server package.

## Stack

- Node stdio MCP server wrapping the SumoSign REST API
- Auth: `SUMOSIGN_API_KEY` (`ss_live_…`) — agent credential only
- Default API: `https://api.sumosign.app` (`SUMOSIGN_API_URL` override)

## Invariants

- API key **cannot** complete a signature. Tools may upload/create/send/poll/download evidence only.
- Prefer mirroring tool names/behavior with `../app/packages/mcp` when both exist; this package is the publishable surface.

## Available Resources

- Core workflow → `.cursor/rules/core-workflow.mdc`
- MCP conventions → `.cursor/rules/mcp-conventions.mdc`
- README → `README.md`
- Traces → `docs/agent-traces/`
- Decisions → `docs/decisions.md`
