# Moodle playground download proxy

The [Moodle playground](https://github.com/ucl-isd/moodle-playground) runs Moodle in the browser and installs plugins
from github zips. A web page can't read those zips straight from github, so the playground asks this proxy instead:

```
https://playground-proxy.preview-moodle.ucl.ac.uk/?url=https://github.com/<owner>/<repo>/archive/<commit>.zip
```

## Why not the playground's proxy

The playground comes with a proxy, but it can't be used for UCL:
- the one it points at, `github-proxy.exelearning.dev`, is a third party service
- its code (`scripts/github-proxy-worker.js` in the playground) has about ten modes (branches, pull requests,
  releases, raw files, feeds, and other hosts such as Google Drive and Dropbox), lets any site use it, and shows a
  page on its own address
- none of those can be switched off, so deploying it would mean editing it into this anyway

## What it does

- returns github plugin zips named by a full 40 character commit id, not a branch or tag
- only for pages on `https://ucl-isd.github.io`, and `https://daviducl.github.io` for development
- sent as downloads, with no cookies
- at most 50 MB
  - a zip github says is bigger gets a 413
  - when github doesn't say, the download stops at 50 MB
- GET only (and the browser's OPTIONS check)

Any other request gets a 4xx. github's 403, 404, 410 and 429 are passed on as the same status. If github cannot be
reached or fails in any other way, the answer is a 502, or a broken download if the zip has already started.

The origin check stops other web sites using it. Scripts can send any origin, so the Cloudflare rate limit is what
limits them.

The playground's `addonProxyUrl` setting points here. Its `phpCorsProxyUrl` must not: PHP's other downloads, such
as language packs and download.moodle.org, aren't github plugin zips, so each would get a 400.

## Deploy (Cloudflare dashboard)

The whole proxy is one file, [`worker.js`](worker.js), with no dependencies and no build step.

Before you start:
- Access to the `ucl.ac.uk` zone in UCL's Cloudflare account, with permission to create workers and worker routes,
  and to change the zone's WAF custom rules, rate limiting rules and bot settings.
- The `*.preview-moodle.ucl.ac.uk` wildcard record stays proxied (orange cloud). The route below only takes over
  `playground-proxy.preview-moodle.ucl.ac.uk`; every other preview-moodle name is untouched.

Deploy:
1. Workers & Pages -> Create -> Create Worker. Name it `moodle-playground-proxy`, and deploy the starter code.
2. Open [`worker.js`](worker.js) and click "Copy raw file" (the copy icon above the code). That is the version on
   `main`, which is the version to deploy. Changes are merged to `main` only when they are ready to go live.
3. In Cloudflare, open the worker you just created and click "Edit code". Delete the starter code, paste in what you
   copied, and click "Deploy".
4. Settings -> Domains & Routes -> Add -> Route: `playground-proxy.preview-moodle.ucl.ac.uk/*`, zone `ucl.ac.uk`.
5. Same page: turn off the workers.dev address and preview URLs, so the proxy is only reachable on the UCL name.
   The zone's rate limit and bot settings don't apply on a workers.dev address.

Zone settings (once):
- Bots: github Actions runners mustn't get a bot check, because the playground's automatic tests download through
  the proxy from them.
  - With Super Bot Fight Mode: a WAF custom rule for `http.host eq "playground-proxy.preview-moodle.ucl.ac.uk"`
    with the action Skip, and only "All Super Bot Fight Mode Rules" ticked. Ticking "All rate limiting rules" would
    turn the rate limit below off.
  - With the free Bot Fight Mode: it can't be skipped for one hostname (Cloudflare's Bot Fight Mode page), so
    runners are blocked unless it is off for the zone.
- Rate limit: a rate limiting rule on the same hostname: 600 requests per 1 minute per IP, then block that IP for
  1 minute.
- Logs: keep them for 7 days at most, or turn Workers Logs off. No Logpush for this worker.

Updates: when `main` changes, repeat steps 2 and 3.

## Check it

```
npm run check
npm run check:local
```

`npm run check` checks the deployed proxy. `npm run check:local` runs the same checks against `worker.js` locally.
Both use real github.

It checks:
- the playground and the development site can both download a coursework zip
- the codeload address for it works too
- every download has the download headers and no cookies
- no origin, another site, `null` or http gets a 403
- a branch name, another host, a github page, a short commit id, a query, a user name or a port gets a 400
- another path gets a 404, and a commit that doesn't exist gets github's 404
- POST and HEAD get a 405, and OPTIONS gets a 204

The JSON message shows the worker answered, not Cloudflare:
- a Cloudflare error page can have the same status
- HEAD has no body, so it is checked by status and Allow

Output:
- PASS or FAIL as each check finishes
- exit 1 if any fail

Node 22.18 or later.

`npm run check` only asks the UCL name. After a deploy, also open
`https://moodle-playground-proxy.<your workers subdomain>.workers.dev/`: it shouldn't answer with
`{"error":"Origin not allowed"}`.

After a deploy, also run the check from github: Actions -> Tests -> Run workflow. That checks the deployed proxy
from a github runner, which is where the playground's automatic tests run. A Cloudflare bot check can let your own
machine through and still block a runner.

Running a workflow needs write access to this repo.

To check the rate limit, run Actions -> Rate limit -> Run workflow. Don't run `check-rate-limit.mjs` from the UCL
network, because it blocks the address it runs from for 1 minute.

To run the file directly, for example against the deployed proxy or a test deployment:

```
node check-proxy.mjs https://playground-proxy.preview-moodle.ucl.ac.uk/
node check-proxy.mjs <proxy address>
node check-proxy.mjs local
```

## Tests

```
npm test
```

- `tests/worker.test.js` tests every rule in `worker.js`, in Node. `npm run check` runs most of them on Cloudflare

github is not contacted. Node 22.18 or later.

The tests and lint also run on github for every push to `main` and every pull request.
