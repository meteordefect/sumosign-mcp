# @sumosign/mcp

MCP server exposing the [SumoSign](https://sumosign.app) signing API to AI agents
(Claude, ChatGPT, Copilot, and any MCP-compatible client) over stdio.

The API key authenticates the **agent**, not a signer. It can never complete a
signature — signing is always done by a human recipient through their emailed,
one-time link, with consent capture and an append-only audit trail.

## Install & run

No install step is required; run it directly with `npx`:

```bash
SUMOSIGN_API_KEY=ss_live_... npx @sumosign/mcp
```

### Configuration

| Env var | Required | Default | Description |
|---|---|---|---|
| `SUMOSIGN_API_KEY` | yes | — | A scoped `ss_live_...` key from the SumoSign portal. |
| `SUMOSIGN_API_URL` | no | `https://api.sumosign.app` | Override for self-hosted or staging APIs. |

### Client config example

```json
{
  "mcpServers": {
    "sumosign": {
      "command": "npx",
      "args": ["-y", "@sumosign/mcp"],
      "env": { "SUMOSIGN_API_KEY": "ss_live_..." }
    }
  }
}
```

## Tools

The server registers **15 tools**:

### Documents

- `upload_document` — upload a local PDF; returns the document id used to create envelopes.
- `analyze_document` — analyze an uploaded PDF for field-placement suggestions (text extraction, no OCR).

### Templates

- `create_template` — create a reusable template from a PDF with text anchors like `{{signature_1}}`.
- `list_templates` — list the organization's reusable templates.
- `seed_starter_templates` — seed sample templates (test envelope, simple NDA, one-page agreement).

### Envelopes — create

- `create_envelope` — create a draft envelope from an uploaded document (inline fields) or a template.
- `create_envelope_from_template` — create a draft envelope from a template; fields are inherited.

### Envelopes — verify & send

- `preview_envelope` — download a placement preview (every field drawn as a dashed, labeled box) to a local path. No email is sent and no envelope is consumed — use it to confirm placement with a human before sending.
- `send_envelope` — send a draft envelope. Only humans can sign; this tool cannot complete a signature.

### Envelopes — track

- `get_envelope` — get envelope status including per-recipient progress.
- `list_envelopes` — list the most recent envelopes for the organization.
- `void_envelope` — void an envelope before completion; revokes outstanding signing links (audit-logged).
- `get_audit_trail` — get the append-only audit trail with actor attribution.

### Downloads

- `download_signed_pdf` — download the flattened, signed PDF of a completed envelope to a local path.
- `download_certificate` — download the Certificate of Completion to a local path.

## Security

- **Local filesystem access.** `upload_document` reads a local PDF path you provide, and
  `preview_envelope`, `download_signed_pdf`, and `download_certificate` write files to local
  paths you provide. The server can therefore read and write any file the host process can
  reach. Run it with least privilege and only point it at paths you intend to share.
- **Untrusted document content / prompt injection.** `analyze_document` extracts text from
  PDFs and returns it to the agent. Document contents are untrusted input and may contain
  prompt-injection attempts. Treat extracted text as data, not instructions, and keep a human
  in the loop before `send_envelope`.
- **Least-privilege API keys.** Issue a scoped key per agent from the SumoSign portal and grant
  only the scopes that agent needs. Available scopes: `documents:create`, `documents:read`,
  `documents:send`, `documents:download`, `templates:read`, `templates:write`, `signers:manage`,
  `webhooks:write`, `audit_logs:read`, `branding:write`, `voice:trigger`. Keys are hashed at
  rest and revocable, and can never complete a signature on a human's behalf.

## About

[SumoSign](https://sumosign.app) is developed by [Cipher Projects](https://cipherprojects.com).

## License

MIT
