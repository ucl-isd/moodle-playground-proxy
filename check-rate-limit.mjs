#!/usr/bin/env node
// Checks the cloudflare rate limit

const WORKER_403_BODY = JSON.stringify({ error: "Origin not allowed" });
const FEWEST_BEFORE_BLOCK = 500;

const TIMEOUT_MS = 20000;

async function ask(base, timeout) {
  const response = await fetch(base, {
    redirect: "manual",
    signal: AbortSignal.timeout(timeout),
  });
  return {
    status: response.status,
    server: response.headers.get("server"),
    body: await response.text(),
  };
}

// Returns { blockedAfter, server, body } on a 429, or { problem }.
export async function checkRateLimit(
  base,
  { tries = 800, batchSize = 10, timeout = TIMEOUT_MS } = {},
) {
  let asked = 0;
  while (asked < tries) {
    const batch = Math.min(batchSize, tries - asked);
    let answers;
    try {
      answers = await Promise.all(
        Array.from({ length: batch }, () => ask(base, timeout)),
      );
    } catch (error) {
      return { problem: `could not ask: ${error.message}` };
    }
    for (const answer of answers) {
      asked++;
      if (answer.status === 429 && asked < FEWEST_BEFORE_BLOCK) {
        return {
          problem: `blocked after ${asked} requests, so the rule looks lower than 600 a minute`,
        };
      }
      if (answer.status === 429) {
        return {
          blockedAfter: asked,
          server: answer.server,
          body: answer.body.slice(0, 100),
        };
      }
      if (answer.status !== 403 || answer.body !== WORKER_403_BODY) {
        return {
          problem: `request ${asked} got HTTP ${answer.status} ${answer.body.slice(0, 80)}, not the worker's 403 or a 429`,
        };
      }
    }
  }
  return { problem: `no 429 after ${tries} requests` };
}

async function main() {
  const proxyAddress = process.argv[2];
  if (!proxyAddress) {
    console.error("usage: node check-rate-limit.mjs <proxy url>");
    process.exit(2);
  }
  const result = await checkRateLimit(proxyAddress);
  if (result.problem) {
    console.log(`FAIL  rate limit: ${result.problem}`);
    process.exit(1);
  }
  console.log(
    `PASS  rate limit: blocked after ${result.blockedAfter} requests, server ${result.server}, body ${result.body}`,
  );
  process.exit(0);
}

if (import.meta.main) {
  main();
}
