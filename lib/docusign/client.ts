import "server-only";
import { getDocusignConfig } from "./config";
import { forgetDocusignAccessToken, getDocusignAccessToken } from "./auth";

export class DocusignApiError extends Error {
  status: number;
  errorCode: string | null;
  constructor(message: string, status: number, errorCode: string | null) {
    super(message);
    this.name = "DocusignApiError";
    this.status = status;
    this.errorCode = errorCode;
  }
}

/** Binary GET (e.g. a PDF) against the account's eSignature REST API. */
export async function docusignBinary(path: string, accept = "application/pdf"): Promise<Buffer> {
  const { apiBase } = getDocusignConfig();
  const call = async (token: string) =>
    fetch(`${apiBase}/${path.replace(/^\//, "")}`, {
      headers: { Accept: accept, Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  let res = await call(await getDocusignAccessToken());
  if (res.status === 401) {
    forgetDocusignAccessToken();
    res = await call(await getDocusignAccessToken());
  }
  if (!res.ok) {
    const text = await res.text();
    let code: string | null = null;
    try {
      code = (JSON.parse(text) as { errorCode?: string }).errorCode ?? null;
    } catch {
      /* non-JSON */
    }
    throw new DocusignApiError(`DocuSign API ${res.status}${code ? ` ${code}` : ""}: ${text.slice(0, 200)}`, res.status, code);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * JSON call against the account's eSignature REST API
 * (`path` is relative to /v2.1/accounts/<id>). One retry with a fresh token on
 * 401. Errors carry DocuSign's errorCode/message — never the token.
 */
export async function docusignJson<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const { apiBase } = getDocusignConfig();
  const call = async (token: string) =>
    fetch(`${apiBase}/${path.replace(/^\//, "")}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
    });

  let res = await call(await getDocusignAccessToken());
  if (res.status === 401) {
    forgetDocusignAccessToken();
    res = await call(await getDocusignAccessToken());
  }
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const code = (body.errorCode as string | undefined) ?? null;
    const msg = (body.message as string | undefined) ?? text.slice(0, 200);
    throw new DocusignApiError(`DocuSign API ${res.status}${code ? ` ${code}` : ""}: ${msg}`, res.status, code);
  }
  return body as T;
}
