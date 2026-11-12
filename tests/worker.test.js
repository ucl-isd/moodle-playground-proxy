// fetch is replaced by a fake that records each call and answers with a small
// zip.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import worker, { parseTarget } from "../worker.js";

const SHA = "8b217b1807bc0d33b3ac3b50ba516a7aaa7f367c";
const GITHUB_ZIP_URL = `https://github.com/danmarsden/moodle-mod_attendance/archive/${SHA}.zip`;
const CODELOAD_ZIP_URL = `https://codeload.github.com/danmarsden/moodle-mod_attendance/zip/${SHA}`;
const PUBLIC_ORIGIN = "https://ucl-isd.github.io";
const DEVELOPMENT_ORIGIN = "https://daviducl.github.io";
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
const MEGABYTE = 1024 * 1024;
const LIMIT = 50 * MEGABYTE;

const originalFetch = global.fetch;
let calls;
let githubAnswer;

beforeEach(() => {
  calls = [];
  githubAnswer = () =>
    new Response(ZIP, {
      status: 200,
      headers: { "Set-Cookie": "a=b", "Content-Type": "application/zip" },
    });
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return githubAnswer();
  };
});

afterEach(() => {
  global.fetch = originalFetch;
});

function ask(
  target,
  { origin = PUBLIC_ORIGIN, method = "GET", path = "/" } = {},
) {
  const requestUrl = new URL(`https://playground-proxy.example${path}`);
  if (target !== undefined) {
    requestUrl.searchParams.set("url", target);
  }
  const headers = origin ? { Origin: origin } : {};
  return worker.fetch(new Request(requestUrl, { method, headers }));
}

function githubBody(total, { breakAfter } = {}) {
  const chunk = new Uint8Array(MEGABYTE);
  const body = { sent: 0, cancelled: false };
  body.stream = new ReadableStream({
    pull(controller) {
      if (breakAfter !== undefined && body.sent >= breakAfter) {
        controller.error(new TypeError("connection lost"));
        return;
      }
      if (body.sent >= total) {
        controller.close();
        return;
      }
      const size = Math.min(MEGABYTE, total - body.sent);
      controller.enqueue(size === MEGABYTE ? chunk : chunk.subarray(0, size));
      body.sent += size;
    },
    cancel() {
      body.cancelled = true;
    },
  });
  return body;
}

async function byteCount(response) {
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
  }
  return total;
}

describe("a plugin zip", () => {
  it("is sent to an allowed origin", async () => {
    const response = await ask(GITHUB_ZIP_URL);
    assert.equal(response.status, 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), ZIP);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, CODELOAD_ZIP_URL);
    assert.equal(calls[0].init.redirect, "manual");
    assert.equal(
      calls[0].init.headers["User-Agent"],
      "ucl-isd-moodle-playground-proxy",
    );
    assert.equal(
      response.headers.get("Access-Control-Allow-Origin"),
      PUBLIC_ORIGIN,
    );
    assert.match(response.headers.get("Vary"), /Origin/);
    assert.equal(response.headers.get("Content-Type"), "application/zip");
    assert.equal(
      response.headers.get("Content-Disposition"),
      `attachment; filename="moodle-mod_attendance-${SHA}.zip"`,
    );
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=3600");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(
      response.headers.get("Content-Security-Policy"),
      "sandbox; default-src 'none'",
    );
    assert.equal(response.headers.get("Set-Cookie"), null);
    // Cloudflare drops a Content-Length from a stream, so none is sent.
    assert.equal(response.headers.get("Content-Length"), null);
  });

  it("is sent for the codeload form too", async () => {
    const response = await ask(CODELOAD_ZIP_URL);
    assert.equal(response.status, 200);
    assert.equal(calls[0].url, CODELOAD_ZIP_URL);
  });

  it("is sent to the development copy", async () => {
    const response = await ask(GITHUB_ZIP_URL, {
      origin: DEVELOPMENT_ORIGIN,
    });
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("Access-Control-Allow-Origin"),
      DEVELOPMENT_ORIGIN,
    );
  });

  it("with an upper case commit id is asked for in lower case", async () => {
    const response = await ask(
      `https://github.com/danmarsden/moodle-mod_attendance/archive/${SHA.toUpperCase()}.zip`,
    );
    assert.equal(response.status, 200);
    assert.equal(calls[0].url, CODELOAD_ZIP_URL);
    assert.equal(
      response.headers.get("Content-Disposition"),
      `attachment; filename="moodle-mod_attendance-${SHA}.zip"`,
    );
  });
});

describe("the 50 MB limit", () => {
  it("a size from github over 50 MB gets a 413 at once", async () => {
    const body = githubBody(LIMIT + 1);
    githubAnswer = () =>
      new Response(body.stream, {
        status: 200,
        headers: { "Content-Length": String(LIMIT + 1) },
      });
    const response = await ask(GITHUB_ZIP_URL);
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: "Zip is over 50 MB" });
    assert.equal(
      response.headers.get("Access-Control-Allow-Origin"),
      PUBLIC_ORIGIN,
    );
    // A stream fills one chunk ahead of the reader, so at most 1 MB is made.
    assert.ok(body.sent <= MEGABYTE);
    assert.equal(body.cancelled, true);
  });

  it("a size from github of exactly 50 MB is sent", async () => {
    githubAnswer = () =>
      new Response(githubBody(LIMIT).stream, {
        status: 200,
        headers: { "Content-Length": String(LIMIT) },
      });
    const response = await ask(GITHUB_ZIP_URL);
    assert.equal(response.status, 200);
    assert.equal(await byteCount(response), LIMIT);
  });

  it("with no size from github, exactly 50 MB is sent", async () => {
    githubAnswer = () =>
      new Response(githubBody(LIMIT).stream, { status: 200 });
    const response = await ask(GITHUB_ZIP_URL);
    assert.equal(response.status, 200);
    assert.equal(await byteCount(response), LIMIT);
  });

  it("with no size from github, the download stops after 50 MB", async () => {
    // 60 MB, so github is still sending when the worker stops reading.
    const body = githubBody(60 * MEGABYTE);
    githubAnswer = () => new Response(body.stream, { status: 200 });
    const response = await ask(GITHUB_ZIP_URL);
    assert.equal(response.status, 200);
    await assert.rejects(byteCount(response), /Zip is over 50 MB/);
    assert.equal(body.cancelled, true);
  });

  it("with no size from github, 50 MB and 1 byte stops", async () => {
    githubAnswer = () =>
      new Response(githubBody(LIMIT + 1).stream, { status: 200 });
    const response = await ask(GITHUB_ZIP_URL);
    await assert.rejects(byteCount(response), /Zip is over 50 MB/);
  });

  it("a download the browser stops reading stops github too", async () => {
    const body = githubBody(LIMIT);
    githubAnswer = () => new Response(body.stream, { status: 200 });
    const response = await ask(GITHUB_ZIP_URL);
    await response.body.cancel();
    assert.equal(body.cancelled, true);
  });

  it("a first chunk over 50 MB gets a 413", async () => {
    githubAnswer = () =>
      new Response(new Uint8Array(LIMIT + 1), { status: 200 });
    const response = await ask(GITHUB_ZIP_URL);
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: "Zip is over 50 MB" });
    assert.equal(
      response.headers.get("Access-Control-Allow-Origin"),
      PUBLIC_ORIGIN,
    );
  });
});

describe("the Origin", () => {
  for (const [name, origin] of [
    ["missing", null],
    ["another site", "https://example.com"],
    ["a lookalike", "https://ucl-isd.github.io.example.com"],
    ["over http", "http://ucl-isd.github.io"],
    ["null", "null"],
  ]) {
    it(`${name} gets a 403 without asking github`, async () => {
      const response = await ask(GITHUB_ZIP_URL, { origin });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
      assert.deepEqual(await response.json(), { error: "Origin not allowed" });
      assert.equal(calls.length, 0);
    });
  }
});

describe("the address asked for", () => {
  for (const [name, target] of [
    ["missing", undefined],
    ["a branch", "https://github.com/owner/repo/archive/main.zip"],
    ["a tag", "https://github.com/owner/repo/archive/refs/tags/v1.0.zip"],
    ["a short commit id", "https://github.com/owner/repo/archive/8b217b1.zip"],
    ["another host", `https://gitlab.com/owner/repo/-/archive/${SHA}.zip`],
    [
      "a host ending in github.com",
      `https://evilgithub.com/owner/repo/archive/${SHA}.zip`,
    ],
    [
      "a raw file",
      `https://raw.githubusercontent.com/owner/repo/${SHA}/version.php`,
    ],
    ["a repo page", "https://github.com/owner/repo"],
    ["over http", `http://github.com/owner/repo/archive/${SHA}.zip`],
    [
      "with a user name",
      `https://user@github.com/owner/repo/archive/${SHA}.zip`,
    ],
    [
      "with a password",
      `https://:pass@github.com/owner/repo/archive/${SHA}.zip`,
    ],
    ["with a port", `https://github.com:8443/owner/repo/archive/${SHA}.zip`],
    ["with a query", `https://github.com/owner/repo/archive/${SHA}.zip?x=1`],
    ["a parent path", `https://github.com/owner/../archive/${SHA}.zip`],
    [
      "an owner starting with a hyphen",
      `https://github.com/-owner/repo/archive/${SHA}.zip`,
    ],
    [
      "an encoded slash",
      `https://github.com/owner/repo%2Fx/archive/${SHA}.zip`,
    ],
    ["not an address", "nonsense"],
  ]) {
    it(`${name} gets a 400 without asking github`, async () => {
      const response = await ask(target);
      assert.equal(response.status, 400);
      assert.equal(response.headers.get("Content-Type"), "application/json");
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.deepEqual(await response.json(), {
        error: "Not a github plugin zip named by a full commit id",
      });
      assert.equal(calls.length, 0);
    });
  }

  it("on any path but the root gets a 404 without asking github", async () => {
    const response = await ask(GITHUB_ZIP_URL, { path: "/other" });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Not found" });
    assert.equal(
      response.headers.get("Access-Control-Allow-Origin"),
      PUBLIC_ORIGIN,
    );
    assert.equal(calls.length, 0);
  });
});

describe("the method", () => {
  it("POST gets a 405 without asking github", async () => {
    const response = await ask(GITHUB_ZIP_URL, { method: "POST" });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("Allow"), "GET, OPTIONS");
    assert.deepEqual(await response.json(), { error: "Only GET" });
    assert.equal(calls.length, 0);
  });

  it("HEAD gets a 405 without asking github", async () => {
    const response = await ask(GITHUB_ZIP_URL, { method: "HEAD" });
    assert.equal(response.status, 405);
    assert.equal(calls.length, 0);
  });

  it("OPTIONS from an allowed origin gets a 204 without asking github", async () => {
    const response = await ask(GITHUB_ZIP_URL, { method: "OPTIONS" });
    assert.equal(response.status, 204);
    assert.equal(
      response.headers.get("Access-Control-Allow-Origin"),
      PUBLIC_ORIGIN,
    );
    assert.equal(response.headers.get("Access-Control-Allow-Methods"), "GET");
    assert.equal(response.headers.get("Access-Control-Max-Age"), "600");
    assert.equal(calls.length, 0);
  });
});

describe("github's answer", () => {
  for (const status of [403, 404, 410, 429]) {
    it(`${status} is passed on, readable by the page`, async () => {
      githubAnswer = () => new Response("from github", { status });
      const response = await ask(GITHUB_ZIP_URL);
      assert.equal(response.status, status);
      assert.equal(
        response.headers.get("Access-Control-Allow-Origin"),
        PUBLIC_ORIGIN,
      );
      assert.deepEqual(await response.json(), {
        error: `github answered ${status}`,
      });
    });
  }

  it("500 becomes a 502", async () => {
    githubAnswer = () => new Response("server error", { status: 500 });
    const response = await ask(GITHUB_ZIP_URL);
    assert.equal(response.status, 502);
    assert.equal(
      response.headers.get("Access-Control-Allow-Origin"),
      PUBLIC_ORIGIN,
    );
    assert.deepEqual(await response.json(), { error: "github answered 500" });
  });

  it("a redirect is not followed", async () => {
    githubAnswer = () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://evil.example/x.zip" },
      });
    assert.equal((await ask(GITHUB_ZIP_URL)).status, 502);
    assert.equal(calls.length, 1);
  });

  it("no answer at all becomes a 502", async () => {
    githubAnswer = () => {
      throw new TypeError("network");
    };
    const response = await ask(GITHUB_ZIP_URL);
    assert.equal(response.status, 502);
    assert.equal(
      response.headers.get("Access-Control-Allow-Origin"),
      PUBLIC_ORIGIN,
    );
    assert.deepEqual(await response.json(), {
      error: "Could not reach github",
    });
  });

  it("200 with no body becomes a 502", async () => {
    githubAnswer = () => new Response(null, { status: 200 });
    const response = await ask(GITHUB_ZIP_URL);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      error: "github answered 200 with no zip",
    });
  });

  it("200 with an empty body becomes a 502", async () => {
    githubAnswer = () => new Response(new Uint8Array(0), { status: 200 });
    const response = await ask(GITHUB_ZIP_URL);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      error: "github answered 200 with no zip",
    });
  });

  it("a zip github stops sending at once becomes a 502", async () => {
    githubAnswer = () =>
      new Response(githubBody(LIMIT, { breakAfter: 0 }).stream, {
        status: 200,
      });
    const response = await ask(GITHUB_ZIP_URL);
    assert.equal(response.status, 502);
    assert.equal(
      response.headers.get("Access-Control-Allow-Origin"),
      PUBLIC_ORIGIN,
    );
    assert.deepEqual(await response.json(), {
      error: "github stopped sending the zip",
    });
  });

  it("a zip github stops sending part way ends as a broken download", async () => {
    githubAnswer = () =>
      new Response(githubBody(LIMIT, { breakAfter: 2 * MEGABYTE }).stream, {
        status: 200,
      });
    const response = await ask(GITHUB_ZIP_URL);
    assert.equal(response.status, 200);
    await assert.rejects(byteCount(response), /connection lost/);
  });
});

describe("parseTarget", () => {
  it("builds the codeload address", () => {
    assert.deepEqual(parseTarget(GITHUB_ZIP_URL), {
      owner: "danmarsden",
      repo: "moodle-mod_attendance",
      sha: SHA,
      url: CODELOAD_ZIP_URL,
    });
    assert.equal(parseTarget(""), null);
  });
});
