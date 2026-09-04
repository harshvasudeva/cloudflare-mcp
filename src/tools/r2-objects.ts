import { z } from "zod";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  CopyObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getR2Client } from "../r2-client.js";
import { textResult, requireConfirm } from "../util.js";

const accountParam = z.string().optional().describe("Account ID; defaults to CF_ACCOUNT_ID.");
const bucketParam = z.string().describe("R2 bucket name");

/** Heuristic: treat well-known text types as inline-returnable, everything else as binary. */
function isTextual(contentType: string | undefined, key: string): boolean {
  if (contentType) {
    if (/^text\//.test(contentType)) return true;
    if (/(json|xml|javascript|yaml|csv|html|svg)/i.test(contentType)) return true;
  }
  return /\.(txt|md|json|jsonl|csv|tsv|xml|ya?ml|html?|css|js|mjs|ts|tsx|jsx|svg|log|ini|toml|sh|sql)$/i.test(key);
}

export function registerR2ObjectTools(server: McpServer): void {
  server.registerTool(
    "cf_list_r2_objects",
    {
      title: "List objects in an R2 bucket",
      description: "List files stored in an R2 bucket, optionally filtered by prefix.",
      inputSchema: {
        account: accountParam,
        bucket: bucketParam,
        prefix: z.string().optional().describe("Only list keys starting with this prefix"),
        delimiter: z.string().optional().describe("Set to '/' to list one folder level at a time"),
        max_keys: z.number().int().positive().max(1000).optional().default(200),
        continuation_token: z.string().optional().describe("Token from a previous truncated listing"),
      },
    },
    async ({ account, bucket, prefix, delimiter, max_keys, continuation_token }) => {
      const { client } = await getR2Client(bucket, "object-read-only", account);
      const out = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          Delimiter: delimiter,
          MaxKeys: max_keys,
          ContinuationToken: continuation_token,
        })
      );
      return textResult({
        bucket,
        prefixes: out.CommonPrefixes?.map((p) => p.Prefix) ?? [],
        objects: (out.Contents ?? []).map((o) => ({
          key: o.Key,
          size: o.Size,
          etag: o.ETag,
          lastModified: o.LastModified,
          storageClass: o.StorageClass,
        })),
        isTruncated: out.IsTruncated ?? false,
        nextContinuationToken: out.NextContinuationToken,
      });
    }
  );

  server.registerTool(
    "cf_get_r2_object",
    {
      title: "Download an R2 object",
      description:
        "Fetch an object from R2. Text-like files are returned inline; binary files are written to a local path " +
        "(pass save_to, or one is derived from the key) and the path is returned.",
      inputSchema: {
        account: accountParam,
        bucket: bucketParam,
        key: z.string().describe("Object key, e.g. uploads/photo.jpg"),
        save_to: z.string().optional().describe("Local file path to write the object to"),
      },
    },
    async ({ account, bucket, key, save_to }) => {
      const { client } = await getR2Client(bucket, "object-read-only", account);
      const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const bytes = Buffer.from(await out.Body!.transformToByteArray());

      if (!save_to && isTextual(out.ContentType, key)) {
        return textResult({
          bucket,
          key,
          contentType: out.ContentType,
          size: bytes.length,
          content: bytes.toString("utf8"),
        });
      }

      const path = save_to ?? (basename(key) || "r2-object.bin");
      writeFileSync(path, bytes);
      return textResult({
        bucket,
        key,
        contentType: out.ContentType,
        size: bytes.length,
        savedTo: path,
      });
    }
  );

  server.registerTool(
    "cf_put_r2_object",
    {
      title: "Upload an object to R2",
      description:
        "Upload a file to R2, either from an inline string or from a local file path. Overwrites any existing " +
        "object at that key without warning, so requires confirm=true.",
      inputSchema: {
        account: accountParam,
        bucket: bucketParam,
        key: z.string().describe("Destination object key"),
        content: z.string().optional().describe("Inline text content to upload"),
        file_path: z.string().optional().describe("Local file to upload instead of inline content"),
        content_type: z.string().optional().describe("MIME type, e.g. application/json"),
        cache_control: z.string().optional(),
        metadata: z.record(z.string()).optional().describe("Custom object metadata"),
        confirm: z.boolean().describe("Must be true — this may overwrite an existing object"),
      },
    },
    async ({ account, bucket, key, content, file_path, content_type, cache_control, metadata, confirm }) => {
      requireConfirm(confirm, `upload object "${key}" to R2 bucket "${bucket}"`);
      if (!content && !file_path) throw new Error("Provide either 'content' or 'file_path'.");
      if (content && file_path) throw new Error("Provide only one of 'content' or 'file_path'.");

      const body = file_path ? readFileSync(file_path) : Buffer.from(content!, "utf8");
      const { client } = await getR2Client(bucket, "object-read-write", account);
      const out = await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: content_type,
          CacheControl: cache_control,
          Metadata: metadata,
        })
      );
      return textResult({ bucket, key, size: body.length, etag: out.ETag });
    }
  );

  server.registerTool(
    "cf_delete_r2_object",
    {
      title: "Delete R2 object(s)",
      description: "Delete one object (key) or many (keys) from an R2 bucket. Requires confirm=true.",
      inputSchema: {
        account: accountParam,
        bucket: bucketParam,
        key: z.string().optional().describe("Single object key to delete"),
        keys: z.array(z.string()).optional().describe("Multiple object keys to delete"),
        confirm: z.boolean().describe("Must be true to actually delete"),
      },
    },
    async ({ account, bucket, key, keys, confirm }) => {
      const targets = keys?.length ? keys : key ? [key] : [];
      if (targets.length === 0) throw new Error("Provide either 'key' or 'keys'.");
      requireConfirm(confirm, `delete ${targets.length} object(s) from R2 bucket "${bucket}"`);

      const { client } = await getR2Client(bucket, "object-read-write", account);
      if (targets.length === 1) {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: targets[0] }));
      } else {
        await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: targets.map((k) => ({ Key: k })) },
          })
        );
      }
      return textResult({ bucket, deleted: targets });
    }
  );

  server.registerTool(
    "cf_copy_r2_object",
    {
      title: "Copy an R2 object",
      description:
        "Copy an object within R2, optionally into a different bucket. Overwrites any existing object at the " +
        "destination key without warning, so requires confirm=true.",
      inputSchema: {
        account: accountParam,
        bucket: bucketParam.describe("Destination bucket"),
        source_bucket: z.string().optional().describe("Source bucket; defaults to the destination bucket"),
        source_key: z.string().describe("Key to copy from"),
        key: z.string().describe("Destination key"),
        confirm: z.boolean().describe("Must be true — this may overwrite an existing object at the destination"),
      },
    },
    async ({ account, bucket, source_bucket, source_key, key, confirm }) => {
      requireConfirm(confirm, `copy to "${key}" in R2 bucket "${bucket}"`);
      const src = source_bucket ?? bucket;

      if (src === bucket) {
        // Same-bucket: a fast server-side copy. x-amz-copy-source must be
        // URL-encoded per segment — the AWS SDK does not do this for you, so
        // an unencoded '+', space, '#', '%', or non-ASCII key silently
        // resolves to the wrong object or fails to sign.
        const { client } = await getR2Client(bucket, "object-read-write", account);
        const encodedSource = `${src}/${source_key.split("/").map(encodeURIComponent).join("/")}`;
        const out = await client.send(
          new CopyObjectCommand({ Bucket: bucket, Key: key, CopySource: encodedSource })
        );
        return textResult({ from: `${src}/${source_key}`, to: `${bucket}/${key}`, result: out.CopyObjectResult });
      }

      // Cross-bucket: a credential minted for one bucket cannot read another
      // (Cloudflare's temp-access-credentials are scoped to a single bucket),
      // so CopyObject would 403 under the default credential path. Read from
      // a source-scoped client and write via a destination-scoped client
      // instead — works regardless of static keys or temp credentials.
      const { client: srcClient } = await getR2Client(src, "object-read-only", account);
      const got = await srcClient.send(new GetObjectCommand({ Bucket: src, Key: source_key }));
      const bytes = Buffer.from(await got.Body!.transformToByteArray());

      const { client: dstClient } = await getR2Client(bucket, "object-read-write", account);
      const put = await dstClient.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: got.ContentType })
      );
      return textResult({
        from: `${src}/${source_key}`,
        to: `${bucket}/${key}`,
        crossBucket: true,
        size: bytes.length,
        etag: put.ETag,
      });
    }
  );

  server.registerTool(
    "cf_head_r2_object",
    {
      title: "Get R2 object metadata",
      description: "Fetch size, content type, etag and custom metadata for an object without downloading it.",
      inputSchema: { account: accountParam, bucket: bucketParam, key: z.string() },
    },
    async ({ account, bucket, key }) => {
      const { client } = await getR2Client(bucket, "object-read-only", account);
      const out = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return textResult({
        bucket,
        key,
        size: out.ContentLength,
        contentType: out.ContentType,
        etag: out.ETag,
        lastModified: out.LastModified,
        metadata: out.Metadata,
      });
    }
  );

  server.registerTool(
    "cf_presign_r2_url",
    {
      title: "Create a presigned R2 URL",
      description:
        "Generate a temporary signed URL for downloading (GET) or uploading (PUT) an object without making the bucket public.",
      inputSchema: {
        account: accountParam,
        bucket: bucketParam,
        key: z.string(),
        operation: z.enum(["get", "put"]).optional().default("get"),
        expires_in: z.number().int().positive().max(604800).optional().default(3600).describe("Seconds until expiry"),
      },
    },
    async ({ account, bucket, key, operation, expires_in }) => {
      const { client } = await getR2Client(
        bucket,
        operation === "put" ? "object-read-write" : "object-read-only",
        account
      );
      const command =
        operation === "put"
          ? new PutObjectCommand({ Bucket: bucket, Key: key })
          : new GetObjectCommand({ Bucket: bucket, Key: key });
      const url = await getSignedUrl(client, command, { expiresIn: expires_in });
      return textResult({ bucket, key, operation, expiresIn: expires_in, url });
    }
  );
}
