/**
 * Returns true when `url` is a Google Maps page on https://www.google.com,
 * with the path `/maps` or `/maps/...`.
 */
export function isMapsUrl(url: string | undefined): boolean {
  if (url === undefined) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.origin === "https://www.google.com" &&
    (parsed.pathname === "/maps" || parsed.pathname.startsWith("/maps/"))
  );
}
