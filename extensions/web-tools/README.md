# web-tools

Pi extension that registers two public-web tools:

- `webfetch` — fetch one public URL as markdown, text, html, or an inline raster image
- `websearch` — search the public web for current information and candidate URLs

Both tools are inactive while an `openai-codex` model is selected because that provider has its own web tooling. Switching to another provider restores whichever web tools were active before the switch.

## Tools

### `webfetch`

Parameters:

- `url` — required
- `format` — optional: `markdown`, `text`, `html`
- `timeout` — optional timeout in seconds, clamped to `1..120`

Current defaults:

- `defaultFormat`: `markdown`
- `timeoutSeconds`: `30`
- `maxResponseBytes`: `5 MB`
- `blockPrivateHosts`: `true`
- `maxRedirects`: `5`
- `fallbackUserAgent`: `opencode`

Behavior notes:

- only `http://` and `https://` URLs are supported
- private/local hosts and IPs are blocked by default
- raster images (`png`, `jpeg`, `gif`, `webp`) are returned inline as images
- HTML is converted to markdown or text when requested
- binary content is rejected
- if a site returns `403` with `cf-mitigated: challenge`, the tool retries with the fallback user agent

### `websearch`

Parameters:

- `query` — required
- `maxResults` — optional, clamped to `1..20`
- `depth` — optional: `auto`, `fast`, `deep` (`deep` is accepted as a compatibility alias and mapped to `fast`)

Current defaults:

- `enabled`: `true`
- `provider`: `exa`
- `endpoint`: `https://mcp.exa.ai/mcp`
- `apiKey`: from `EXA_API_KEY` env var (no key = free tier with rate limits)
- `timeoutSeconds`: `25`
- `defaultMaxResults`: `8`
- `defaultDepth`: `auto`

Behavior notes:

- uses the Exa MCP endpoint
- Exa currently supports provider depths `auto` and `fast`; tool input `deep` is downgraded to `fast`
- search responses are limited to `1 MB`
- without an API key, Exa applies free-tier rate limits (2 QPS, 50 requests/day); set `EXA_API_KEY` to remove limits
- provider requests currently send:
  - `livecrawl: "fallback"`
  - `contextMaxCharacters: 2000`

## Configuration

The extension has an internal settings shape:

```ts
{
  fetch: {
    defaultFormat: "markdown" | "text" | "html";
    timeoutSeconds: number;
    maxResponseBytes: number;
    blockPrivateHosts: boolean;
    maxRedirects: number;
    fallbackUserAgent: string;
  };
  search: {
    enabled: boolean;
    provider: "exa";
    endpoint: string;
    apiKey?: string;
    timeoutSeconds: number;
    defaultMaxResults: number;
    defaultDepth: "auto" | "fast" | "deep";
  };
}
```

But in the current implementation, these are hardcoded defaults in `settings.ts`.

That means:

- `webfetch.format` and `webfetch.timeout` can be overridden per call
- `websearch.maxResults` and `websearch.depth` can be overridden per call
- the underlying defaults are not currently exposed through Pi settings, extension settings, or env vars

### Setting your Exa API key

Get an API key at [dashboard.exa.ai/api-keys](https://dashboard.exa.ai/api-keys) and export it in your shell environment:

```bash
export EXA_API_KEY=exa-...
pi
```

When set, the key is sent as an `Authorization: Bearer` header to the Exa MCP endpoint, bypassing the free-tier rate limits (2 QPS, 50 requests/day). Without it, anonymous requests are rate-limited but still work for light usage.

To change the defaults, edit:

- `home/.pi/agent/extensions/web-tools/settings.ts`

## Source of truth

- extension entry: `home/.pi/agent/extensions/web-tools/index.ts`
- settings/defaults: `home/.pi/agent/extensions/web-tools/settings.ts`
- fetch tool: `home/.pi/agent/extensions/web-tools/webfetch.ts`
- search tool: `home/.pi/agent/extensions/web-tools/websearch.ts`
- Exa provider: `home/.pi/agent/extensions/web-tools/providers/exa.ts`
