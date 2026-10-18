/** Reverse proxies may return an HTML error document instead of an API error. */
export function httpErrorMessage(status: number, contentType: string, body: string, fallback = `HTTP ${status}`): string {
  if (/text\/html|application\/xhtml/i.test(contentType) || /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(body)) {
    return fallback;
  }
  return body || `HTTP ${status}`;
}
