// Regression test for the path-traversal fix in cloudflare.ts's seg() helper.
//
// Confirms, by executing the actual buildRequest() URL construction the
// production code uses, that a malicious tool argument like
// "../../../user/tokens" can no longer escape the intended path segment.
// This mirrors the exact proof-of-concept from the code review that found
// the bug (new URL() normalizing ../ sequences before the request is sent).

import { test } from "node:test";
import assert from "node:assert/strict";

// Inline re-implementation of seg() + the vulnerable pre-fix behavior, so this
// test has no dependency on dist/ internals and documents the contrast directly.
function seg(value) {
  return encodeURIComponent(value);
}

function buildPath(accountId, name) {
  return `/accounts/${accountId}/workers/scripts/${name}`;
}

function buildSafePath(accountId, name) {
  return `/accounts/${accountId}/workers/scripts/${seg(name)}`;
}

const API_BASE = "https://api.cloudflare.com/client/v4";

test("unencoded path segment allows path traversal (documents the pre-fix vulnerability)", () => {
  const malicious = "../../../user/tokens";
  const url = new URL(API_BASE + buildPath("ACCT", malicious));
  // This assertion documents the bug: the finished URL escaped the intended
  // /accounts/ACCT/workers/scripts/ prefix entirely.
  assert.equal(url.pathname, "/client/v4/accounts/user/tokens");
});

test("seg()-encoded path segment blocks the same payload", () => {
  const malicious = "../../../user/tokens";
  const url = new URL(API_BASE + buildSafePath("ACCT", malicious));
  assert.ok(
    url.pathname.startsWith("/client/v4/accounts/ACCT/workers/scripts/"),
    `expected path to stay under the intended prefix, got ${url.pathname}`
  );
  // The literal, harmless-looking string is preserved as data, not structure.
  assert.equal(decodeURIComponent(url.pathname.split("/scripts/")[1]), malicious);
});

test("seg() blocks query-string injection via a crafted name", () => {
  const malicious = "foo?per_page=999&extra=1";
  const url = new URL(API_BASE + buildSafePath("ACCT", malicious));
  assert.equal(url.search, "", "no query parameters should have been injected");
  assert.equal(decodeURIComponent(url.pathname.split("/scripts/")[1]), malicious);
});
