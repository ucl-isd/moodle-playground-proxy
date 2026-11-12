#!/usr/bin/env node

import { createServer } from "node:http";
import worker from "./worker.js";

const PUBLIC_ORIGIN = "https://ucl-isd.github.io";
const DEVELOPMENT_ORIGIN = "https://daviducl.github.io";
// A coursework commit, 7.7 MB, so a size limit too small for coursework fails.
const SHA = "0618c25cef0ba56aace282ef3c58204f583fbf25";
const MISSING_SHA = "0000000000000000000000000000000000000000";
const REPO_URL = "https://github.com/ucl-isd/moodle-mod_coursework";
const GITHUB_ZIP_URL = `${REPO_URL}/archive/${SHA}.zip`;
const CODELOAD_ZIP_URL = `https://codeload.github.com/ucl-isd/moodle-mod_coursework/zip/${SHA}`;
const NOT_A_ZIP_MESSAGE = "Not a github plugin zip named by a full commit id";

// 20 s, long enough for a coursework zip.
const TIMEOUT_MS = 20000;

function proxyRequestUrl(base, target) {
  const requestUrl = new URL(base);
  if (target !== undefined) {
    requestUrl.searchParams.set("url", target);
  }
  return requestUrl.toString();
}

async function askProxy(
  base,
  target,
  { origin = PUBLIC_ORIGIN, method = "GET", timeout = TIMEOUT_MS } = {},
) {
  const headers = origin ? { Origin: origin } : {};
  const response = await fetch(proxyRequestUrl(base, target), {
    method,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(timeout),
  });
  const body = new Uint8Array(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, body };
}

function isZip(bytes) {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

function checkHeader(problems, headers, name, expected) {
  const actual = headers.get(name);
  if (actual !== expected) {
    problems.push(`${name} is ${actual}, not ${expected}`);
  }
}

function checkDownload(target, origin) {
  return async (base, timeout) => {
    const result = await askProxy(base, target, { origin, timeout });
    const problems = [];
    if (result.status !== 200) {
      problems.push(`HTTP ${result.status}`);
    }
    checkHeader(
      problems,
      result.headers,
      "access-control-allow-origin",
      origin,
    );
    const vary = (result.headers.get("vary") || "").split(/\s*,\s*/);
    if (!vary.includes("Origin")) {
      problems.push("no Vary: Origin");
    }
    checkHeader(problems, result.headers, "content-type", "application/zip");
    checkHeader(
      problems,
      result.headers,
      "content-disposition",
      `attachment; filename="moodle-mod_coursework-${SHA}.zip"`,
    );
    checkHeader(problems, result.headers, "x-content-type-options", "nosniff");
    checkHeader(
      problems,
      result.headers,
      "content-security-policy",
      "sandbox; default-src 'none'",
    );
    if (result.headers.get("set-cookie")) {
      problems.push("sets a cookie");
    }
    if (!isZip(result.body)) {
      problems.push("body is not a zip");
    }
    return problems;
  };
}

// Checks an answer that isn't a zip, its status, message and headers. Only a
// 403 is hidden from the page.
function checkAnswer(target, options, status, error, headers = {}) {
  return async (base, timeout) => {
    const result = await askProxy(base, target, { ...options, timeout });
    const problems = [];
    if (result.status !== status) {
      problems.push(`HTTP ${result.status}, not ${status}`);
    }
    const allowOrigin = result.headers.get("access-control-allow-origin");
    if (status === 403 && allowOrigin) {
      problems.push("still sends Access-Control-Allow-Origin");
    }
    if (status !== 403 && allowOrigin !== PUBLIC_ORIGIN) {
      problems.push(`Access-Control-Allow-Origin is ${allowOrigin}`);
    }
    for (const [name, value] of Object.entries(headers)) {
      checkHeader(problems, result.headers, name, value);
    }
    if (error !== undefined) {
      const text = new TextDecoder().decode(result.body);
      if (text !== JSON.stringify({ error })) {
        problems.push(
          `body is ${text.slice(0, 80)}, not the worker's "${error}"`,
        );
      }
    }
    return problems;
  };
}

export const CHECKS = [
  [
    "a plugin zip downloads for the playground",
    checkDownload(GITHUB_ZIP_URL, PUBLIC_ORIGIN),
  ],
  [
    "a plugin zip downloads for the development site",
    checkDownload(GITHUB_ZIP_URL, DEVELOPMENT_ORIGIN),
  ],
  [
    "the codeload address downloads too",
    checkDownload(CODELOAD_ZIP_URL, PUBLIC_ORIGIN),
  ],
  [
    "no Origin gets a 403",
    checkAnswer(GITHUB_ZIP_URL, { origin: null }, 403, "Origin not allowed"),
  ],
  [
    "another site gets a 403",
    checkAnswer(
      GITHUB_ZIP_URL,
      { origin: "https://example.com" },
      403,
      "Origin not allowed",
    ),
  ],
  [
    "a lookalike site gets a 403",
    checkAnswer(
      GITHUB_ZIP_URL,
      { origin: "https://ucl-isd.github.io.example.com" },
      403,
      "Origin not allowed",
    ),
  ],
  [
    "Origin null gets a 403",
    checkAnswer(GITHUB_ZIP_URL, { origin: "null" }, 403, "Origin not allowed"),
  ],
  [
    "the playground over http gets a 403",
    checkAnswer(
      GITHUB_ZIP_URL,
      { origin: "http://ucl-isd.github.io" },
      403,
      "Origin not allowed",
    ),
  ],
  [
    "a branch name gets a 400",
    checkAnswer(`${REPO_URL}/archive/main.zip`, {}, 400, NOT_A_ZIP_MESSAGE),
  ],
  [
    "another host gets a 400",
    checkAnswer("https://example.com/plugin.zip", {}, 400, NOT_A_ZIP_MESSAGE),
  ],
  [
    "a github page that isn't a zip gets a 400",
    checkAnswer(REPO_URL, {}, 400, NOT_A_ZIP_MESSAGE),
  ],
  [
    "a short commit id gets a 400",
    checkAnswer(
      `${REPO_URL}/archive/${SHA.slice(0, 7)}.zip`,
      {},
      400,
      NOT_A_ZIP_MESSAGE,
    ),
  ],
  [
    "a query on the address gets a 400",
    checkAnswer(`${GITHUB_ZIP_URL}?x=1`, {}, 400, NOT_A_ZIP_MESSAGE),
  ],
  [
    "a user name in the address gets a 400",
    checkAnswer(
      `https://user@github.com/ucl-isd/moodle-mod_coursework/archive/${SHA}.zip`,
      {},
      400,
      NOT_A_ZIP_MESSAGE,
    ),
  ],
  [
    "a port in the address gets a 400",
    checkAnswer(
      `https://github.com:8443/ucl-isd/moodle-mod_coursework/archive/${SHA}.zip`,
      {},
      400,
      NOT_A_ZIP_MESSAGE,
    ),
  ],
  [
    "another path gets a 404",
    (base, timeout) =>
      checkAnswer(
        GITHUB_ZIP_URL,
        {},
        404,
        "Not found",
      )(new URL("other", base).toString(), timeout),
  ],
  [
    "a commit that doesn't exist gets github's 404",
    checkAnswer(
      `${REPO_URL}/archive/${MISSING_SHA}.zip`,
      {},
      404,
      "github answered 404",
    ),
  ],
  [
    "POST gets a 405",
    checkAnswer(GITHUB_ZIP_URL, { method: "POST" }, 405, "Only GET", {
      allow: "GET, OPTIONS",
    }),
  ],
  [
    "HEAD gets a 405",
    checkAnswer(GITHUB_ZIP_URL, { method: "HEAD" }, 405, undefined, {
      allow: "GET, OPTIONS",
    }),
  ],
  [
    "OPTIONS gets a 204",
    checkAnswer(GITHUB_ZIP_URL, { method: "OPTIONS" }, 204, undefined, {
      "access-control-allow-methods": "GET",
    }),
  ],
];

// report(name, problems) is called as each check finishes.
export async function runChecks(
  base,
  { timeout = TIMEOUT_MS, report = () => {} } = {},
) {
  const results = [];
  for (const [name, check] of CHECKS) {
    let problems;
    try {
      problems = await check(base, timeout);
    } catch (error) {
      problems = [`could not ask: ${error.message}`];
    }
    results.push({ name, problems });
    report(name, problems);
  }
  return results;
}

export async function runLocal(handler = worker) {
  const server = createServer(async (incoming, outgoing) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (typeof value === "string") {
        headers.set(name, value);
      }
    }
    const request = new Request(
      `http://${incoming.headers.host}${incoming.url}`,
      { method: incoming.method, headers },
    );
    let answer;
    try {
      answer = await handler.fetch(request);
    } catch (error) {
      answer = new Response(`worker threw: ${error.message}`, { status: 500 });
    }
    // A download that breaks part way ends the connection. Cloudflare does the
    // same. The check then records a FAIL.
    let body;
    try {
      body = Buffer.from(await answer.arrayBuffer());
    } catch {
      outgoing.destroy();
      return;
    }
    outgoing.writeHead(answer.status, Object.fromEntries(answer.headers));
    outgoing.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}/`,
    close: () => server.close(),
  };
}

async function main() {
  const proxyAddress = process.argv[2];
  if (!proxyAddress) {
    console.error("usage: node check-proxy.mjs <proxy url> | local");
    process.exit(2);
  }
  const local = proxyAddress === "local" ? await runLocal() : null;
  const base = local ? local.base : proxyAddress;
  const results = await runChecks(base, {
    report: (name, problems) =>
      console.log(
        problems.length === 0
          ? `PASS  ${name}`
          : `FAIL  ${name}: ${problems.join("; ")}`,
      ),
  });
  local?.close();

  const failed = results.filter((result) => result.problems.length > 0).length;
  console.log(
    failed
      ? `${failed} of ${CHECKS.length} checks failed`
      : `all ${CHECKS.length} checks passed`,
  );
  process.exit(failed ? 1 : 0);
}

if (import.meta.main) {
  main();
}
