#!/usr/bin/env node
/**
 * Smoke test for the avv MCP server.
 *
 * Speaks real MCP over stdio: handshake, tool listing, a tool call that returns
 * image blocks, and the SSRF refusal path. Run it after `npm run build`.
 *
 *   node scripts/smoke-mcp.mjs [path-to-a-local-video]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";

const sample = process.argv[2];
let failures = 0;

function check(label, condition, detail = "") {
  const mark = condition ? "  ok  " : "  FAIL";
  if (!condition) failures++;
  console.log(`${mark} ${label}${detail ? ` - ${detail}` : ""}`);
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["packages/mcp/dist/index.js"],
  cwd: process.cwd(),
});

const client = new Client({ name: "avv-smoke", version: "1.0.0" });
await client.connect(transport);
check("handshake", true, JSON.stringify(client.getServerVersion()));

const { tools } = await client.listTools();
check("tools listed", tools.length >= 8, `${tools.length} tools`);
for (const t of tools) {
  const params = Object.keys(t.inputSchema?.properties ?? {});
  console.log(`         ${t.name.padEnd(18)} ${String(params.length).padStart(2)} params${t.annotations?.readOnlyHint ? "  [read-only]" : ""}`);
}
check("every tool has a description", tools.every((t) => (t.description ?? "").length > 40));

const doc = await client.callTool({ name: "video_doctor", arguments: {} });
check("video_doctor responds", !doc.isError);
console.log(doc.content[0].text.split("\n").slice(0, 5).map((l) => `         ${l}`).join("\n"));

if (sample && existsSync(sample)) {
  const res = await client.callTool({
    name: "video_watch",
    arguments: { source: sample, frames: 4, transcript: false },
  });
  const images = res.content.filter((c) => c.type === "image");
  check("video_watch returns frames as images", images.length === 4, `${images.length} image blocks`);
  check("images are base64 jpeg", images.every((i) => i.mimeType === "image/jpeg" && i.data.length > 1000));
  check("a text block accompanies the images", res.content.some((c) => c.type === "text"));
} else {
  console.log("  skip  video_watch (pass a local video path to exercise it)");
}

// A poisoned instruction could point an agent at cloud metadata; the server
// must refuse rather than fetch it.
const bad = await client.callTool({
  name: "video_info",
  arguments: { source: "http://169.254.169.254/latest/meta-data/" },
});
check("private/metadata URLs are refused", bad.isError === true, bad.content[0].text.split("\n")[0]);

const traversal = await client.callTool({
  name: "video_download",
  arguments: { source: "https://www.youtube.com/watch?v=jNQXAC9IVRw", dir: "/etc/avv-should-not-exist" },
});
check("writes outside the allowed roots are refused", traversal.isError === true, traversal.content[0].text.split("\n")[0]);

await client.close();
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
