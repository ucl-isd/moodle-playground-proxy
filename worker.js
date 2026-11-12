// Moodle playground download proxy.
// https://github.com/ucl-isd/moodle-playground-proxy
//
// The playground runs Moodle in the browser and installs plugins from github
// zips. github doesn't let a web page read those zips directly, so the
// playground asks this worker for them instead, for example
// https://playground-proxy.preview-moodle.ucl.ac.uk/?url=https://github.com/<owner>/<repo>/archive/<commit>.zip
//
// Replaces the playgrounds proxy, github-proxy.exelearning.dev. See readme.
//
// Rules
// - a full commit id, so the zip at a link stays the same
//   - github also accepts a tree id, and its zip changes each time it is built
//   - github also accepts a commit from any fork of the repo, under the
//     repo's name
// - only pages on the playground's sites, so other web sites can't download
//   through a UCL address
// - downloads with no cookies, so nothing downloaded from a UCL name runs as a page
// Rate limiting is a Cloudflare rule on the hostname.

// Sites whose pages may download through the proxy
// - ucl-isd.github.io, the public UCL playground and every other ucl-isd
//   Pages site
// - daviducl.github.io, the development copy and every other daviducl Pages
//   site
// Private github Pages sites (the ones that need a github sign in) are on a
// different address, so their pages get a 403. Adding one here would only let it
// download public repos, because the proxy does not sign in to github.
const ALLOWED_ORIGINS = [
  "https://ucl-isd.github.io",
  "https://daviducl.github.io",
];

// 50 MB, the same limit the playground uses for its other downloads. Most
// moodle plugins are under 10 MB.
const MAX_BYTES = 50 * 1024 * 1024;

// Github's 403, 404, 410 and 429 are passed on as the same status.
// The JSON message is for curl and check-proxy.mjs, not for the playground.
const PASSTHROUGH_STATUSES = new Set([403, 404, 410, 429]);

// github's naming rules. Owners are up to 39 characters, repos up to 100.
const SHA = /^[0-9a-f]{40}$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Returns {owner, repo, sha, url} for a github plugin zip, or null
 * The two forms accepted
 * - github.com/<owner>/<repo>/archive/<commit>.zip
 * - codeload.github.com/<owner>/<repo>/zip/<commit>
 * Anything else gets a 400, such as release assets and branch zips.
 */
export function parseTarget(address) {
  let parsed;
  try {
    parsed = new URL(address);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port
  ) {
    return null;
  }
  if (parsed.search || parsed.hash) {
    return null;
  }

  let match = null;
  if (parsed.hostname === "github.com") {
    match = parsed.pathname.match(
      /^\/([^/]+)\/([^/]+)\/archive\/([^/]+)\.zip$/,
    );
  }
  if (parsed.hostname === "codeload.github.com") {
    match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/zip\/([^/]+)$/);
  }
  if (!match) {
    return null;
  }

  const [, owner, repo] = match;
  // github.com redirects an upper case id to lower case, and codeload gives
  // different bytes for one, so always ask in lower case.
  const sha = match[3].toLowerCase();
  if (!OWNER.test(owner) || !REPO.test(repo) || !SHA.test(sha)) {
    return null;
  }
  return {
    owner,
    repo,
    sha,
    url: `https://codeload.github.com/${owner}/${repo}/zip/${sha}`,
  };
}

function responseHeaders(origin, extra = {}) {
  const headers = new Headers({
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "Cache-Control": "no-store",
    Vary: "Origin",
    ...extra,
  });
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  return headers;
}

function errorResponse(status, message, origin, extra = {}) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: responseHeaders(origin, {
      "Content-Type": "application/json",
      ...extra,
    }),
  });
}

function zipTooBigResponse(origin) {
  return errorResponse(
    413,
    `Zip is over ${MAX_BYTES / 1024 / 1024} MB`,
    origin,
  );
}

// Streamed directly, because a cloudflare worker has 128 MB shared by all its
// requests. If we stream past MAX_BYTES, or if github stops, the download breaks.
function streamZipUpToMaxBytes(reader, firstChunk) {
  let nextChunk = firstChunk;
  let total = 0;
  return new ReadableStream({
    async pull(controller) {
      let chunk = nextChunk;
      nextChunk = null;
      if (!chunk) {
        try {
          chunk = await reader.read();
        } catch (error) {
          controller.error(error);
          return;
        }
      }
      if (chunk.done) {
        controller.close();
        return;
      }
      total += chunk.value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel().catch(() => {});
        controller.error(
          new Error(`Zip is over ${MAX_BYTES / 1024 / 1024} MB`),
        );
        return;
      }
      controller.enqueue(chunk.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin");
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return errorResponse(403, "Origin not allowed", null);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: responseHeaders(origin, {
          "Access-Control-Allow-Methods": "GET",
          // The browser may reuse this answer for 10 minutes before asking again.
          "Access-Control-Max-Age": "600",
        }),
      });
    }
    if (request.method !== "GET") {
      return errorResponse(405, "Only GET", origin, {
        Allow: "GET, OPTIONS",
      });
    }

    const requestUrl = new URL(request.url);
    if (requestUrl.pathname !== "/") {
      return errorResponse(404, "Not found", origin);
    }
    const target = parseTarget(requestUrl.searchParams.get("url") || "");
    if (!target) {
      return errorResponse(
        400,
        "Not a github plugin zip named by a full commit id",
        origin,
      );
    }

    let githubResponse;
    try {
      githubResponse = await fetch(target.url, {
        redirect: "manual",
        headers: { "User-Agent": "ucl-isd-moodle-playground-proxy" },
      });
    } catch {
      return errorResponse(502, "Could not reach github", origin);
    }
    const { status } = githubResponse;
    if (PASSTHROUGH_STATUSES.has(status)) {
      return errorResponse(status, `github answered ${status}`, origin);
    }
    if (status !== 200) {
      return errorResponse(502, `github answered ${status}`, origin);
    }
    if (!githubResponse.body) {
      return errorResponse(502, "github answered 200 with no zip", origin);
    }

    // A size from github over MAX_BYTES gets a 413
    // - github sends a size only once it has sent the whole zip already
    // - without one, the download stops at MAX_BYTES as a broken download
    if (Number(githubResponse.headers.get("Content-Length")) > MAX_BYTES) {
      await githubResponse.body.cancel().catch(() => {});
      return zipTooBigResponse(origin);
    }

    // Read the first chunk before answering, so an empty zip or an early
    // failure still gets a proper 502, or a 413 if it's already too big.
    const reader = githubResponse.body.getReader();
    let firstChunk;
    try {
      firstChunk = await reader.read();
    } catch {
      return errorResponse(502, "github stopped sending the zip", origin);
    }
    if (firstChunk.done) {
      return errorResponse(502, "github answered 200 with no zip", origin);
    }
    if (firstChunk.value.byteLength > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return zipTooBigResponse(origin);
    }

    return new Response(streamZipUpToMaxBytes(reader, firstChunk), {
      status: 200,
      headers: responseHeaders(origin, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${target.repo}-${target.sha}.zip"`,
        // A zip named by a full commit id doesn't change, so browsers may keep
        // it for an hour.
        "Cache-Control": "public, max-age=3600",
      }),
    });
  },
};
