#!/usr/bin/env node
/**
 * SumoSign MCP server (stdio).
 *
 * Config via environment:
 *   SUMOSIGN_API_KEY  — required, ss_live_... key from the portal
 *   SUMOSIGN_API_URL  — optional, defaults to https://api.sumosign.app
 *
 * The API key authenticates the agent and can never complete a signature.
 * Signing is always done by a human recipient through their emailed link.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { randomUUID } from 'crypto';
import { readFile, writeFile } from 'fs/promises';
import { basename } from 'path';
import { z } from 'zod';

const API_URL = (process.env.SUMOSIGN_API_URL ?? 'https://api.sumosign.app').replace(/\/$/, '');
const API_KEY = process.env.SUMOSIGN_API_KEY ?? '';

async function api(
  method: string,
  path: string,
  body?: BodyInit,
  contentType?: string,
  idempotencyKey?: string,
): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${API_KEY}` };
  if (contentType) headers['content-type'] = contentType;
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const response = await fetch(`${API_URL}${path}`, { method, headers, body });
  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after');
    const detail = await response.text().catch(() => '');
    throw new Error(
      `SumoSign API 429 (rate limited${retryAfter ? `, retry after ${retryAfter}s` : ''}): ${detail}`,
    );
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`SumoSign API ${response.status}: ${detail}`);
  }
  return response;
}

async function apiJson<T>(
  method: string,
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<T> {
  const response = await api(
    method,
    path,
    body === undefined ? undefined : JSON.stringify(body),
    body === undefined ? undefined : 'application/json',
    idempotencyKey,
  );
  return response.json() as Promise<T>;
}

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

const recipientShape = z.object({
  email: z.string().email(),
  name: z.string(),
  role: z.enum(['signer', 'cc', 'viewer']).default('signer'),
  routingOrder: z.number().int().min(0).default(0),
});

const fieldShape = z.object({
  type: z.enum(['signature', 'initials', 'date_signed', 'text', 'checkbox']),
  page: z.number().int().min(1),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  required: z.boolean().default(true),
  recipientIndex: z.number().int().min(0),
});

/**
 * Methodology that /llms.txt gives raw-API agents. Folded into MCP `instructions`
 * so a client that only connects tools still gets the Field placement ladder —
 * without this, MCP agents see 15 tools and zero placement guidance.
 */
const SERVER_INSTRUCTIONS = `SumoSign signing API for AI agents. Your API key authenticates the sending agent and can never complete a signature — a human recipient always signs via their emailed one-time link.

## Core flow
1. upload_document (or use an existing template)
2. Place fields using the Field placement ladder below — never blind-guess coordinates
3. create_envelope or create_envelope_from_template
4. preview_envelope when coordinates came from analyze or estimation; confirm with a human before send
5. send_envelope → poll get_envelope until completed → download_signed_pdf / download_certificate / get_audit_trail

## Field placement ladder (never blind-guess coordinates)
1. **Template** — repeatable docs; embed {{signature_N}} / {{date_signed_N}} / {{initials_N}} / {{text_N}} / {{checkbox_N}} anchors, then create_template, or reuse list_templates / seed_starter_templates.
2. **SumoSign analyze** — after upload_document, call analyze_document; confirm/adjust suggestions[] before create_envelope. No OCR — scanned PDFs return hasExtractableText: false.
3. **Agent-side text extraction** — PyMuPDF / pdfplumber locally if analyze misses labels.
4. **Embed anchors** — agent-generated PDFs include {{signature_N}} at generation time, then create_template.
5. **OCR** — if hasExtractableText is false (scanned PDF); agent-side or human review.
6. **Vision** — last resort only; never auto-send without human confirmation.

Coordinates are PDF user units, origin bottom-left. Off-page fields are rejected with field_out_of_bounds — read page sizes from the error (or analyze pageSizes) and correct.

## The human checkpoint
Do not attempt to bypass recipient signing. Agents cannot complete signatures; that human affirmative act is what keeps the workflow enforceable.`;

const server = new McpServer(
  { name: 'sumosign', version: '0.1.1' },
  { instructions: SERVER_INSTRUCTIONS },
);

type ToolResult = ReturnType<typeof jsonResult>;

/**
 * Registers a tool with the schema typed as z.ZodRawShape. Full zod inference
 * through the SDK's tool generics exceeds TypeScript's instantiation depth
 * (TS2589), so handler inputs are validated at runtime and typed loosely here.
 */
function registerTool(
  name: string,
  description: string,
  shape: z.ZodRawShape,
  handler: (input: Record<string, any>) => Promise<ToolResult>,
): void {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  (server.tool as (...args: unknown[]) => unknown)(name, description, shape, handler);
}

registerTool(
  'upload_document',
  'Upload a PDF from a local file path. Returns the document id used to create envelopes.',
  { filePath: z.string().describe('Absolute path to a PDF file') },
  async ({ filePath }) => {
    const bytes = await readFile(filePath);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'application/pdf' }), basename(filePath));
    const response = await api('POST', '/v1/documents', form);
    return jsonResult(await response.json());
  },
);

registerTool(
  'analyze_document',
  'Analyze an uploaded PDF for field placement suggestions (text extraction, no OCR). Returns likelySigningPages, outline, and suggestions[] ready for create_envelope.',
  { documentId: z.string().uuid() },
  async ({ documentId }) => jsonResult(await apiJson('GET', `/v1/documents/${documentId}/analyze`)),
);

registerTool(
  'create_envelope',
  'Create a signing envelope from an uploaded document (inline fields) or from a template (templateId + recipients). Returns the envelope in status draft. Sends Idempotency-Key automatically for safe retries.',
  {
    documentId: z.string().uuid().optional(),
    templateId: z.string().uuid().optional(),
    name: z.string(),
    message: z.string().optional(),
    routingMode: z.enum(['parallel', 'sequential']).default('parallel'),
    expiresInDays: z.number().int().min(1).max(365).optional(),
    recipients: z.array(recipientShape).min(1),
    fields: z.array(fieldShape).optional(),
    idempotencyKey: z
      .string()
      .uuid()
      .optional()
      .describe('Client idempotency key; reuse on retry. Auto-generated if omitted.'),
  },
  async (input) => {
    const { idempotencyKey, ...body } = input;
    return jsonResult(
      await apiJson('POST', '/v1/envelopes', body, idempotencyKey ?? randomUUID()),
    );
  },
);

registerTool(
  'create_template',
  'Create a reusable template from an uploaded PDF that contains text anchors like {{signature_1}}. Returns parsed field coordinates.',
  {
    documentId: z.string().uuid(),
    name: z.string(),
  },
  async (input) => jsonResult(await apiJson('POST', '/v1/templates', input)),
);

registerTool(
  'list_templates',
  'List reusable templates for the organization.',
  {},
  async () => jsonResult(await apiJson('GET', '/v1/templates')),
);

registerTool(
  'seed_starter_templates',
  'Seed SumoSign sample templates (test envelope, simple NDA, one-page agreement) with baked-in anchors.',
  {},
  async () => jsonResult(await apiJson('POST', '/v1/templates/starter-pack')),
);

registerTool(
  'create_envelope_from_template',
  'Create a draft envelope from a template. Provide recipients only — fields are inherited from the template. Sends Idempotency-Key automatically for safe retries.',
  {
    templateId: z.string().uuid(),
    name: z.string(),
    message: z.string().optional(),
    routingMode: z.enum(['parallel', 'sequential']).default('parallel'),
    expiresInDays: z.number().int().min(1).max(365).optional(),
    recipients: z.array(recipientShape).min(1),
    idempotencyKey: z
      .string()
      .uuid()
      .optional()
      .describe('Client idempotency key; reuse on retry. Auto-generated if omitted.'),
  },
  async (input) => {
    const { templateId, idempotencyKey, ...rest } = input;
    return jsonResult(
      await apiJson(
        'POST',
        '/v1/envelopes',
        { templateId, ...rest },
        idempotencyKey ?? randomUUID(),
      ),
    );
  },
);

registerTool(
  'preview_envelope',
  'Download a placement preview of an envelope to a local file path: the PDF with every field drawn as a dashed, labeled box. Use it to verify signature placement with a human before send_envelope — no email is sent and no envelope is consumed.',
  { envelopeId: z.string().uuid(), outputPath: z.string() },
  async ({ envelopeId, outputPath }) => {
    const response = await api('GET', `/v1/envelopes/${envelopeId}/preview`);
    await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
    return jsonResult({ ok: true, savedTo: outputPath });
  },
);

registerTool(
  'send_envelope',
  'Send a draft envelope. Returns 202 with { jobId, status: "queued", envelopeId }; token issuance and signing-invite emails run asynchronously. Poll get_envelope until recipients show status sent. Only humans can sign — this tool cannot complete a signature. Sends Idempotency-Key automatically for safe retries.',
  { envelopeId: z.string().uuid(), idempotencyKey: z.string().uuid().optional() },
  async ({ envelopeId, idempotencyKey }) =>
    jsonResult(
      await apiJson(
        'POST',
        `/v1/envelopes/${envelopeId}/send`,
        undefined,
        idempotencyKey ?? randomUUID(),
      ),
    ),
);

registerTool(
  'get_envelope',
  'Get envelope status including per-recipient progress. Statuses: draft, sent, viewed, partially_signed, completed, voided, expired.',
  { envelopeId: z.string().uuid() },
  async ({ envelopeId }) => jsonResult(await apiJson('GET', `/v1/envelopes/${envelopeId}`)),
);

registerTool(
  'list_envelopes',
  'List the most recent envelopes for the organization.',
  {},
  async () => jsonResult(await apiJson('GET', '/v1/envelopes')),
);

registerTool(
  'void_envelope',
  'Void an envelope before completion. Revokes all outstanding signing links. The reason is audit-logged.',
  { envelopeId: z.string().uuid(), reason: z.string() },
  async ({ envelopeId, reason }) =>
    jsonResult(await apiJson('POST', `/v1/envelopes/${envelopeId}/void`, { reason })),
);

registerTool(
  'get_audit_trail',
  'Get the append-only audit trail for an envelope: every event with timestamp and actor attribution (user, api_key, recipient, system).',
  { envelopeId: z.string().uuid() },
  async ({ envelopeId }) => jsonResult(await apiJson('GET', `/v1/envelopes/${envelopeId}/audit`)),
);

registerTool(
  'download_signed_pdf',
  'Download the flattened, signed PDF of a completed envelope to a local file path.',
  { envelopeId: z.string().uuid(), outputPath: z.string() },
  async ({ envelopeId, outputPath }) => {
    const response = await api('GET', `/v1/envelopes/${envelopeId}/download`);
    await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
    return jsonResult({ ok: true, savedTo: outputPath });
  },
);

registerTool(
  'download_certificate',
  'Download the Certificate of Completion (recipients, timestamps, IPs, event timeline, document hash) to a local file path.',
  { envelopeId: z.string().uuid(), outputPath: z.string() },
  async ({ envelopeId, outputPath }) => {
    const response = await api('GET', `/v1/envelopes/${envelopeId}/certificate`);
    await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
    return jsonResult({ ok: true, savedTo: outputPath });
  },
);

async function main() {
  if (!API_KEY) {
    console.error('SUMOSIGN_API_KEY is required (ss_live_... key from the SumoSign portal)');
    process.exit(1);
  }
  await server.connect(new StdioServerTransport());
}

void main();
