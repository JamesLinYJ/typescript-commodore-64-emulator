interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

interface WorkerEnvironment {
  readonly ASSETS: AssetsBinding;
}

const HTML_CONTENT_TYPE = 'text/html';
const SITE_ORIGIN_PLACEHOLDER = '__SITE_ORIGIN__';

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'SAMEORIGIN');
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

const worker = {
  async fetch(request: Request, environment: WorkerEnvironment): Promise<Response> {
    const response = await environment.ASSETS.fetch(request);
    const contentType = response.headers.get('Content-Type') ?? '';
    if (!contentType.startsWith(HTML_CONTENT_TYPE)) return withSecurityHeaders(response);

    const origin = new URL(request.url).origin;
    const html = (await response.text()).replaceAll(SITE_ORIGIN_PLACEHOLDER, origin);
    const headers = new Headers(response.headers);
    headers.delete('Content-Length');
    headers.set('Content-Type', 'text/html; charset=utf-8');
    return withSecurityHeaders(
      new Response(html, {
        headers,
        status: response.status,
        statusText: response.statusText,
      }),
    );
  },
};

export default worker;
