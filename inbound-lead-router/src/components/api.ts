/** POSTs JSON to one of this app's routes and throws the server's one-line error on failure. */
export async function postJson<T>(url: string, body: unknown, secret: string): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(secret ? { 'x-webhook-secret': secret } : {}) },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) throw new Error(data?.error ?? `Request failed with status ${response.status}`);
  return data as T;
}
