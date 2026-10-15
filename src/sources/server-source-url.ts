export function serverSourceUrl(url: string, currentOrigin: string): string {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return url;
  }

  if (target.protocol !== 'https:' || target.origin === currentOrigin) return url;
  return `/api/source?${new URLSearchParams({ url: target.toString() }).toString()}`;
}
