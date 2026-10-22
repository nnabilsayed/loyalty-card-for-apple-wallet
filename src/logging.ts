/**
 * What goes in the server log. A card code is the key to a card and a phone number is personal data,
 * so neither is ever written out in full.
 */

const SERIAL_LIKE = /^[A-Za-z0-9_-]{22}$/;

function shorten(segment: string): string {
  return `${segment.slice(0, 6)}…`;
}

/** Hides card codes in the path and phone numbers in the query of a request URL. */
export function redactUrl(url: string): string {
  const queryAt = url.indexOf("?");
  const path = queryAt === -1 ? url : url.slice(0, queryAt);
  const query = queryAt === -1 ? "" : url.slice(queryAt);

  const cleanPath = path
    .split("/")
    .map((segment) => {
      if (SERIAL_LIKE.test(segment)) return shorten(segment);
      if (segment.endsWith(".pkpass") && SERIAL_LIKE.test(segment.slice(0, -".pkpass".length))) {
        return `${shorten(segment.slice(0, -".pkpass".length))}.pkpass`;
      }
      return segment;
    })
    .join("/");

  const cleanQuery = query.replace(/([?&]phone=)[^&]*/g, "$1%5Bredacted%5D");
  return cleanPath + cleanQuery;
}

interface LoggableRequest {
  method: string;
  url: string;
  ip?: string;
}

/** Request log lines carry the method, the redacted URL and the address. Never headers or cookies. */
export function requestSerializer(req: LoggableRequest) {
  return { method: req.method, url: redactUrl(req.url), remoteAddress: req.ip };
}
