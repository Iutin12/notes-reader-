declare module "cloudflare:workers" {
  export const env: {
    DB?: D1Database;
  };
}

interface D1Database {
  prepare(query: string): unknown;
}

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}
