/**
 * Thin fetch wrapper.
 *
 * Every API error comes back as `{ error, message }`, and the `message` is
 * written to be shown to a user rather than to a log. So the rule here is: if
 * the server said something, show exactly what it said. Swallowing it and
 * replacing it with "Something went wrong" would throw away the most useful
 * signal in the whole system — the server is usually telling you it refused to
 * save something, or that a key was revoked, and that deserves to be visible.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const body = (payload ?? {}) as { error?: string; message?: string };
    throw new ApiError(
      response.status,
      body.error ?? "unknown",
      body.message ?? `Request failed with ${response.status}.`,
    );
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
