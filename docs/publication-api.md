# Build a custom read-only conversation viewer

Workstation's publication API is the small, stable surface for presenting one
allowlisted OIX conversation and a selected workspace subtree in a custom UI.
Use it for a minimal transcript, a project-status page, or a branded artifact
browser. It is intentionally separate from the trusted OIX app-server protocol:
the publication API cannot send prompts, change Goals, approve actions, operate
the computer, or modify files.

The API contract is described by
[`publication-api.openapi.yaml`](publication-api.openapi.yaml). A runnable,
framework-free client lives in
[`examples/publication-viewer/index.html`](../examples/publication-viewer/index.html).

## Connect through a relay

A browser talks to a public relay, never directly to the private sidecar. The
relay forwards only these reads and adds the sidecar bearer token upstream:

```text
browser                    public relay                 private Workstation
GET /snapshot       ->     GET /snapshot        ->     GET /api/public-thread/snapshot
GET /workspace      ->     GET /workspace       ->     GET /api/public-workspace
GET /file           ->     GET /file            ->     GET /api/public-workspace/file
```

Keep the sidecar on loopback or a private service network. Do not put its bearer
token in browser code, URLs, storage, or HTML. The relay may use any public base
path; clients receive that base path as their `endpoint`.

## Load and follow a conversation

Request the newest visible messages first:

```http
GET https://example.com/publication/snapshot?limit=10
Accept: application/json
```

The response has this shape:

```json
{
  "schemaVersion": 1,
  "threadId": "thread_123",
  "title": "Published conversation",
  "status": "working",
  "goal": {
    "objective": "Translate every qualifying paper.",
    "status": "active",
    "updatedAt": 1788650000
  },
  "messages": [
    {
      "id": "message_1",
      "role": "assistant",
      "parts": [
        { "kind": "text", "content": "Package 42 is complete." },
        { "kind": "tool", "id": "tool_1", "label": "Created report.pdf", "state": "complete" }
      ]
    }
  ],
  "page": { "nextCursor": "message_1", "hasMore": true },
  "eventCursor": "1788650000:turn_9",
  "updatedAt": 1788650000000
}
```

`messages` are chronological within each page. `limit` defaults to 24 and is
clamped to 1–100. To load the next older page, pass the previous response's
`page.nextCursor` as the exclusive `before` cursor:

```http
GET /publication/snapshot?limit=10&before=message_1
```

Prepend that response's messages. Do not reverse either page. Continue only
while `page.hasMore` is true and `page.nextCursor` is non-null. Cursors are
opaque; never construct or parse them. Preserve the first visible element's
screen position when prepending so the transcript does not jump.

Poll the newest page every 2–5 seconds to follow a live thread. Replace messages
with matching IDs and append new IDs. `eventCursor` is an opaque change hint;
equal values mean the underlying thread has not advanced. A reconnect should
reload the newest page and retain already loaded older pages only if `threadId`
is unchanged.

`status` describes current execution, while `goal.status` describes durable
intent. In particular, `status: "idle"` with `goal.status: "active"` means the
Goal remains active between work cycles; it does not mean the project ended.

Render message parts in array order:

- `text` is sanitized display text. Render it as text or with a safe Markdown
  renderer; never inject it as raw HTML.
- `tool` is a public activity summary. Show its `label` and `state`. `output` is
  optional and clients must work when it is absent.

Reasoning, private paths, credentials, raw command output, approvals, and
non-allowlisted tool details are not part of the public contract.

## Browse published files

List the publication root or one relative directory:

```http
GET /publication/workspace
GET /publication/workspace?path=papers%2F00042
```

The response contains the display `name`, current relative `path`,
`capabilities`, and sorted `entries`. Directories precede files. A file entry
may include `size`; every entry includes `modifiedAt` in Unix milliseconds.
Treat paths as opaque relative paths and pass them back with `URLSearchParams`.

Fetch one file with:

```http
GET /publication/file?path=papers%2F00042%2Fenglish.pdf
```

Files up to 250 MiB are returned inline with `X-Content-Type-Options: nosniff`.
Known preview types are PDF, CSV, JSON, Markdown, plain text, YAML, GIF, JPEG,
PNG, and WebP. Other extensions use `application/octet-stream`. Range requests
are not part of version 1; clients should not require them.

The listing's version 1 capabilities are exactly `browse` and `read`. Their
presence does not authorize mutation, and the publication surface has no write
routes.

## Errors and reconnection

JSON errors use `{ "error": "safe public message" }`.

| Status | Meaning | Client behavior |
| --- | --- | --- |
| `400` | Invalid path or wrong file/directory operation | Fix the request; do not retry unchanged. |
| `401` | Relay authentication to the sidecar failed | Treat as a deployment fault; never ask a public user for the relay token. |
| `404` | Published path is missing or unavailable | Show a not-found state. |
| `413` | File exceeds the preview limit | Explain that the file cannot be previewed. |
| `503` | Publication is unconfigured or reconnecting | Keep the last good view and retry with bounded backoff. |

A reasonable `503` schedule is 1, 2, 3, then 5 seconds, capped at 5 seconds.
Reset the delay after a successful response. Do not clear a previously rendered
transcript during a temporary reconnect.

## Compatibility

`schemaVersion` is the compatibility boundary. Version 1 clients must ignore
unknown object fields and unknown message-part kinds, and must not infer write
capabilities from future fields. A breaking rename, removal, semantic change,
or new required field requires a new schema version. Additive optional fields
may be introduced within version 1.

Pin tests to the OpenAPI document and still handle runtime errors. The public
relay can be upgraded independently of a custom frontend, so tolerant readers
are required.

For a trusted, interactive custom client—prompts, streaming events, approvals,
models, and Goal mutation—use the OIX app-server protocol instead. See the
[OIX app-server guide](https://github.com/openinterpreter/open-interpreter/blob/main/core/docs/app-server.md).

