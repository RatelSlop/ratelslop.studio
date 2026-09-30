# RatelSlop Repositories Cloudflare Worker

Edge caching proxy for `ratelslop.studio`. Solves GitHub client-side rate limits by caching aggregated repositories and programming languages at the Cloudflare Edge with a 3-minute TTL.

## Deployment Options

### Optie 1: Via Cloudflare Dashboard (Zonder installatie)
1. Ga naar [Cloudflare Dashboard](https://dash.cloudflare.com/) > **Workers & Pages** > **Create application** > **Create Worker**.
2. Noem de worker `ratelslop-repos` en klik op **Deploy**.
3. Klik op **Edit code** en plak de inhoud van [`index.js`](./index.js) erin.
4. Klik op **Deploy**.
5. (Optioneel, maar aanbevolen): Ga naar **Settings** > **Variables and Secrets** en voeg een Secret toe genaamd `GITHUB_TOKEN` met een GitHub Personal Access Token (classic, `public_repo` scope) voor 5.000 requests/uur.
6. Koppel een Custom Domain (bijv. `api.ratelslop.studio`) onder **Settings** > **Domains & Routes** > **Add Custom Domain**, of gebruik de gratis `*.workers.dev` URL.

### Optie 2: Via Wrangler CLI
In de `worker` map:
```bash
# Inloggen bij Cloudflare (eenmalig)
npx wrangler login

# Optioneel: token toevoegen als secret
npx wrangler secret put GITHUB_TOKEN

# Deployen naar Cloudflare
npx wrangler deploy
```
