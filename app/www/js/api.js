// Calls to the Supabase Edge Functions and direct uploads to signed URLs.

export class ApiError extends Error {
  constructor(status, code, data = {}) {
    super(`${status} ${code}`);
    this.status = status; // 0 = network failure
    this.code = code;
    this.data = data;
  }
  get isNetwork() {
    return this.status === 0;
  }
}

export function createApi(config) {
  const headers = {
    "content-type": "application/json",
    "x-booth-key": config.boothKey ?? "",
    apikey: config.publishableKey ?? "",
  };

  async function call(name, { method = "POST", body, timeoutMs = 20_000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(`${config.functionsUrl}/${name}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        cache: "no-store",
      });
    } catch {
      throw new ApiError(0, "network");
    } finally {
      clearTimeout(timer);
    }
    let data = {};
    try {
      data = await res.json();
    } catch {
      // empty or non-JSON body
    }
    if (!res.ok) throw new ApiError(res.status, data.error ?? "http_error", data);
    return data;
  }

  return {
    createUpload: (body) => call("create-upload", { body }),
    completeUpload: (body) => call("complete-upload", { body }),
    listFrames: () => call("list-frames", { method: "GET" }),
    manageFrames: (action, pin, extra = {}) => call("manage-frames", { body: { action, pin, ...extra } }),

    async putSigned(signedUrl, blob, type) {
      let res;
      try {
        res = await fetch(signedUrl, {
          method: "PUT",
          headers: { "content-type": type, "x-upsert": "true", apikey: config.publishableKey ?? "" },
          body: blob,
        });
      } catch {
        throw new ApiError(0, "network");
      }
      if (!res.ok) throw new ApiError(res.status, "upload_failed");
    },
  };
}
