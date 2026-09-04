import { S3Client } from "@aws-sdk/client-s3";
import { cfFetch, resolveAccountId } from "./cloudflare.js";

/**
 * R2 object operations are not part of the Cloudflare REST API — they run over
 * the S3-compatible endpoint with SigV4. We get credentials one of two ways:
 *
 *  1. Static keys: R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY both set. Used
 *     directly, no extra API call per request.
 *  2. Temp credentials: R2_ACCESS_KEY_ID set alone. Cloudflare's
 *     temp-access-credentials endpoint requires `parentAccessKeyId` — it is
 *     NOT optional, confirmed against Cloudflare's API reference — so
 *     R2_ACCESS_KEY_ID must be present either way; there is no path that
 *     needs zero R2-specific configuration.
 *
 * `parentAccessKeyId` is a non-secret identifier (the id of an existing R2
 * API token), so exposing it as a plain env var alongside CF_API_TOKEN is
 * fine even without the matching secret.
 */

export type R2Permission = "object-read-only" | "object-read-write" | "admin-read-only" | "admin-read-write";

type CachedClient = { client: S3Client; expiresAt: number };

const clientCache = new Map<string, CachedClient>();
const TTL_SECONDS = 3600;
const REFRESH_MARGIN_MS = 60_000;

function endpointFor(accountId: string): string {
  // R2 API tokens hand you a ready-made S3 endpoint (jurisdiction-specific, e.g.
  // *.eu.r2.cloudflarestorage.com); prefer it when set instead of guessing.
  return process.env.R2_S3_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`;
}

async function mintTempCredentials(
  accountId: string,
  bucket: string,
  permission: R2Permission
): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string }> {
  const parentAccessKeyId = process.env.R2_ACCESS_KEY_ID;
  if (!parentAccessKeyId) {
    throw new Error(
      "R2 object operations need R2_ACCESS_KEY_ID set in .env — Cloudflare's temporary-credentials endpoint " +
        "requires it. Get it from an R2 API token at dash.cloudflare.com → R2 → Manage API Tokens. Set " +
        "R2_SECRET_ACCESS_KEY too if you'd rather sign directly than mint a new short-lived credential per bucket."
    );
  }

  const resp = await cfFetch<{ accessKeyId: string; secretAccessKey: string; sessionToken: string }>(
    `/accounts/${accountId}/r2/temp-access-credentials`,
    { method: "POST", body: { bucket, permission, ttlSeconds: TTL_SECONDS, parentAccessKeyId } }
  );
  return resp.result;
}

/** Returns an S3Client scoped to one bucket, reusing it until its credentials near expiry. */
export async function getR2Client(
  bucket: string,
  permission: R2Permission = "object-read-write",
  account?: string
): Promise<{ client: S3Client; accountId: string }> {
  const accountId = await resolveAccountId(account);
  const cacheKey = `${accountId}:${bucket}:${permission}`;

  const cached = clientCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + REFRESH_MARGIN_MS) {
    return { client: cached.client, accountId };
  }

  const staticKey = process.env.R2_ACCESS_KEY_ID;
  const staticSecret = process.env.R2_SECRET_ACCESS_KEY;

  let client: S3Client;
  let expiresAt: number;

  if (staticKey && staticSecret) {
    client = new S3Client({
      region: "auto",
      endpoint: endpointFor(accountId),
      credentials: { accessKeyId: staticKey, secretAccessKey: staticSecret },
    });
    expiresAt = Number.MAX_SAFE_INTEGER; // static keys do not expire
  } else {
    const creds = await mintTempCredentials(accountId, bucket, permission);
    client = new S3Client({
      region: "auto",
      endpoint: endpointFor(accountId),
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
      },
    });
    expiresAt = Date.now() + TTL_SECONDS * 1000;
  }

  clientCache.set(cacheKey, { client, expiresAt });
  return { client, accountId };
}
