import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import {
  FetchHttpHandler,
  type FetchHttpHandlerOptions,
} from "@smithy/fetch-http-handler";
import { type HttpRequest, HttpResponse } from "@smithy/protocol-http";
import { buildQueryString } from "@smithy/querystring-builder";
import type { HttpHandlerOptions } from "@smithy/types";
import { type RequestUrlParam, requestUrl } from "obsidian";
import type { RemoteFileInfo, SaveJeSettings } from "./types";

const MIME_MAP: Record<string, string> = {
  md: "text/markdown; charset=utf-8",
  canvas: "application/json; charset=utf-8",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  html: "text/html; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/m4a",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  zip: "application/zip",
};

export function lookupMimeType(filename: string): string {
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex !== -1) {
    const ext = filename.slice(dotIndex + 1).toLowerCase();
    if (MIME_MAP[ext]) {
      return MIME_MAP[ext];
    }
  }
  return "application/octet-stream";
}

/**
 * Converts Buffer or ArrayBufferView to standard ArrayBuffer.
 */
function toArrayBuffer(b: ArrayBufferView): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/**
 * Obsidian-native HTTP handler for AWS SDK v3.
 * Uses Obsidian's requestUrl to bypass CORS limitations on desktop and mobile.
 */
class ObsHttpHandler extends FetchHttpHandler {
  constructor(options?: FetchHttpHandlerOptions) {
    super(options);
  }

  async handle(
    request: HttpRequest,
    { abortSignal }: HttpHandlerOptions = {}
  ): Promise<{ response: HttpResponse }> {
    if (abortSignal?.aborted) {
      const abortError = new Error("Request aborted");
      abortError.name = "AbortError";
      return Promise.reject(abortError);
    }

    let path = request.path;
    if (request.query) {
      const queryString = buildQueryString(request.query);
      if (queryString) {
        path += `?${queryString}`;
      }
    }

    const { port, method } = request;
    const url = `${request.protocol}//${request.hostname}${
      port ? `:${port}` : ""
    }${path}`;

    const body =
      method === "GET" || method === "HEAD" ? undefined : request.body;

    const transformedHeaders: Record<string, string> = {};
    for (const key of Object.keys(request.headers)) {
      const keyLower = key.toLowerCase();
      if (keyLower === "host" || keyLower === "content-length") {
        continue;
      }
      transformedHeaders[keyLower] = request.headers[key];
    }

    let contentType: string | undefined;
    if (transformedHeaders["content-type"]) {
      contentType = transformedHeaders["content-type"];
    }

    let transformedBody: any = body;
    if (ArrayBuffer.isView(body)) {
      transformedBody = toArrayBuffer(body);
    }

    const param: RequestUrlParam = {
      url,
      method,
      headers: transformedHeaders,
      body: transformedBody,
      contentType,
    };

    const rsp = await requestUrl(param);

    const headersLower: Record<string, string> = {};
    for (const key of Object.keys(rsp.headers)) {
      headersLower[key.toLowerCase()] = rsp.headers[key];
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(rsp.arrayBuffer));
        controller.close();
      },
    });

    return {
      response: new HttpResponse({
        statusCode: rsp.status,
        headers: headersLower,
        body: stream,
      }),
    };
  }
}

/**
 * Automatically extracts region from IDrive e2 endpoint if possible (e.g. abcd.sg01.idrivee2-8.com -> sg01)
 */
export function inferRegionFromEndpoint(endpoint: string): string {
  const clean = endpoint.replace(/^https?:\/\//, "").trim();
  const parts = clean.split(".");
  if (parts.length >= 3) {
    // Check if second part looks like a region (e.g. sg01, us01, fra01)
    if (/^[a-z]{2,3}\d{2}$/i.test(parts[1])) {
      return parts[1].toLowerCase();
    }
  }
  return "us-east-1";
}

/**
 * Normalizes endpoint URL to include https://
 */
export function normalizeEndpoint(endpoint: string): string {
  let ep = endpoint.trim();
  if (!ep.startsWith("http://") && !ep.startsWith("https://")) {
    ep = `https://${ep}`;
  }
  return ep.replace(/\/+$/, "");
}

/**
 * Normalizes prefix to end with a trailing slash if non-empty
 */
export function normalizePrefix(prefix: string): string {
  let p = prefix.trim().replace(/^\/+/, "");
  if (p && !p.endsWith("/")) {
    p = `${p}/`;
  }
  return p;
}

export class IDriveS3Service {
  private client: S3Client;
  private settings: SaveJeSettings;
  private prefix: string;

  constructor(settings: SaveJeSettings) {
    this.settings = settings;
    this.prefix = normalizePrefix(settings.remotePrefix);

    const endpoint = normalizeEndpoint(settings.endpoint);
    const region =
      settings.region.trim() || inferRegionFromEndpoint(settings.endpoint);

    this.client = new S3Client({
      region,
      endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: settings.accessKeyId.trim(),
        secretAccessKey: settings.secretAccessKey.trim(),
      },
      requestHandler: new ObsHttpHandler(),
    });

    // Add cache-control header
    this.client.middlewareStack.add(
      (next) => (args: any) => {
        if (args.request?.headers) {
          args.request.headers["cache-control"] = "no-cache";
        }
        return next(args);
      },
      { step: "build" }
    );
  }

  /**
   * Test connection to IDrive e2 bucket.
   */
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      if (!this.settings.endpoint.trim()) {
        return { ok: false, message: "Endpoint URL is required." };
      }
      if (!this.settings.accessKeyId.trim() || !this.settings.secretAccessKey.trim()) {
        return { ok: false, message: "Access Key ID and Secret Access Key are required." };
      }
      if (!this.settings.bucketName.trim()) {
        return { ok: false, message: "Bucket name is required." };
      }

      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.settings.bucketName.trim(),
          MaxKeys: 1,
        })
      );

      const status = res.$metadata.httpStatusCode;
      if (status === 200) {
        return {
          ok: true,
          message: `Successfully connected to bucket "${this.settings.bucketName.trim()}" on IDrive e2!`,
        };
      }
      return {
        ok: false,
        message: `Connected with unexpected HTTP status: ${status}`,
      };
    } catch (err: any) {
      return {
        ok: false,
        message: `Connection failed: ${err.message || String(err)}`,
      };
    }
  }

  /**
   * List all objects in the bucket (filtered by prefix).
   */
  async listAllObjects(): Promise<RemoteFileInfo[]> {
    const results: RemoteFileInfo[] = [];
    let continuationToken: string | undefined = undefined;

    do {
      const res: ListObjectsV2CommandOutput = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.settings.bucketName.trim(),
          Prefix: this.prefix || undefined,
          ContinuationToken: continuationToken,
        })
      );

      if (res.Contents) {
        for (const item of res.Contents) {
          if (!item.Key || item.Key.endsWith("/")) {
            // Skip folder markers
            continue;
          }

          // Strip remote prefix to get relative vault path
          let relativeKey = item.Key;
          if (this.prefix && relativeKey.startsWith(this.prefix)) {
            relativeKey = relativeKey.slice(this.prefix.length);
          }

          const mtime = item.LastModified ? item.LastModified.getTime() : 0;

          results.push({
            key: relativeKey,
            rawKey: item.Key,
            size: item.Size ?? 0,
            mtime,
            etag: item.ETag ? item.ETag.replace(/^"|"$/g, "") : undefined,
          });
        }
      }

      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);

    return results;
  }

  /**
   * Download a single file from S3 as ArrayBuffer.
   */
  async downloadFile(relativeKey: string): Promise<ArrayBuffer> {
    const rawKey = this.prefix ? `${this.prefix}${relativeKey}` : relativeKey;

    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.settings.bucketName.trim(),
        Key: rawKey,
      })
    );

    if (!res.Body) {
      throw new Error(`Empty body returned for "${rawKey}"`);
    }

    if (typeof (res.Body as any).transformToByteArray === "function") {
      const u8 = await (res.Body as any).transformToByteArray();
      return toArrayBuffer(u8);
    } else if (res.Body instanceof ReadableStream) {
      return await new Response(res.Body).arrayBuffer();
    } else if (res.Body instanceof Blob) {
      return await res.Body.arrayBuffer();
    }

    throw new Error(`Unsupported body type for "${rawKey}"`);
  }

  /**
   * Upload a file to S3 with correct content-type and mtime metadata.
   * Automatically uses 5MB multipart chunking and parallel uploads for files >= 5MB.
   */
  async uploadFile(
    relativeKey: string,
    data: ArrayBuffer,
    mtime?: number,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<{ etag?: string }> {
    const rawKey = this.prefix ? `${this.prefix}${relativeKey}` : relativeKey;
    const contentType = lookupMimeType(relativeKey);

    const metadata: Record<string, string> = {};
    if (mtime) {
      metadata.mtime = String(mtime);
    }

    const isMultipartEnabled = this.settings.enableMultipartUpload ?? true;
    const chunkSizeMb = this.settings.multipartChunkSizeMb ?? 5;
    const chunkSize = Math.max(5, chunkSizeMb) * 1024 * 1024;
    const concurrency = this.settings.multipartConcurrency ?? 4;
    const u8 = new Uint8Array(data);

    // If multipart is disabled or file is smaller than chunk size, use single fast PUT
    if (!isMultipartEnabled || data.byteLength < chunkSize) {
      const res = await this.client.send(
        new PutObjectCommand({
          Bucket: this.settings.bucketName.trim(),
          Key: rawKey,
          Body: u8,
          ContentType: contentType,
          ContentLength: data.byteLength,
          Metadata: metadata,
        })
      );

      onProgress?.(data.byteLength, data.byteLength);

      return {
        etag: res.ETag ? res.ETag.replace(/^"|"$/g, "") : undefined,
      };
    }

    // For files >= chunkSize, use Multipart Upload with configured chunk size and concurrency
    const parallelUpload = new Upload({
      client: this.client,
      queueSize: concurrency,
      partSize: chunkSize,
      leavePartsOnError: false,
      params: {
        Bucket: this.settings.bucketName.trim(),
        Key: rawKey,
        Body: u8,
        ContentType: contentType,
        Metadata: metadata,
      },
    });

    if (onProgress) {
      parallelUpload.on("httpUploadProgress", (progress) => {
        if (progress.loaded !== undefined && progress.total !== undefined) {
          onProgress(progress.loaded, progress.total);
        }
      });
    }

    const doneResult = (await parallelUpload.done()) as any;
    return {
      etag: doneResult.ETag ? doneResult.ETag.replace(/^"|"$/g, "") : undefined,
    };
  }

  /**
   * Delete a file from S3.
   */
  async deleteFile(relativeKey: string): Promise<void> {
    const rawKey = this.prefix ? `${this.prefix}${relativeKey}` : relativeKey;

    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.settings.bucketName.trim(),
        Key: rawKey,
      })
    );
  }
}
