# RatelSlop repositories Worker

Publieke metadata-proxy voor `https://api.ratelslop.studio/repos`. De Worker vraagt
expliciet openbare GitHub-repositories op, accepteert alleen `private: false` en
geeft alleen de velden terug die het projectenoverzicht nodig heeft. De gedeelde
edge-cache heeft een versheidsperiode van 180 seconden. Er is geen eigen logging
van bezoekers-IP's of headers; Cloudflare verwerkt wel verbindingsgegevens.

## Deployment

Een GitHub-push publiceert deze Worker **niet** automatisch. Deploy de gewijzigde
`index.js` afzonderlijk naar de bestaande Worker en behoud het domein
`api.ratelslop.studio`. De interne cache-key `/repos-public-v1` voorkomt dat de
nieuwe code eerder gecachte, ongefilterde responses hergebruikt. De publieke route
blijft `/repos`. Eerder gedownloade of extern gecachte gegevens worden hierdoor
niet ingetrokken.

### Cloudflare Dashboard

1. Open de bestaande `ratelslop-repos` onder **Workers & Pages**.
2. Vervang de code via **Edit code** door [`index.js`](./index.js) en deploy.
3. Controleer de instelling voor Workers Logs / Observability en schakel
   persistente Workers Logs uit. Alleen code plakken past `wrangler.json` niet toe.
4. Controleer eventuele afzonderlijke Tail Workers, Logpush en externe exports;
   zet deze niet aan zonder noodzaak, passende instellingen en privacy-informatie.
5. Controleer dat het bestaande domein naar deze Worker wijst.

### Wrangler

Voer vanuit `worker/` uit met een actuele Wrangler-versie:

```sh
npx wrangler login
npx wrangler deploy
```

[`wrangler.json`](./wrangler.json) bevat `observability.enabled: false`. Controleer
na deployment de effectieve accountinstellingen. Uitschakelen van Workers Logs
beëindigt niet de eigen netwerk- en beveiligingsverwerking van Cloudflare en
verwijdert niet automatisch eerder opgeslagen logs. Zie de
[Workers Logs-documentatie](https://developers.cloudflare.com/workers/observability/logs/workers-logs/).

## Optionele GitHub-authenticatie

Openbare repository- en taalgegevens kunnen zonder token worden opgevraagd.
Voeg alleen bij behoefte aan het toepasselijke authenticated rate limit een
`GITHUB_TOKEN` toe als **Worker secret**, nooit in code, gewone variabelen of
browser-JavaScript:

```sh
npx wrangler secret put GITHUB_TOKEN
```

Gebruik de minimaal benodigde leesrechten voor openbare metadata. Geef dit token
geen toegang tot privé-repositories en geen schrijfrechten; de eerdere aanbeveling
voor een classic token met `public_repo` is daarvoor te ruim. Controleer bestaande
tokens, beperk hun toegang en vervang ze indien nodig. De expliciete public-query,
filter en beperkte responsevelden blijven nodig als extra beveiliging. Zie de
[GitHub-documentatie van het endpoint](https://docs.github.com/en/rest/repos/repos#list-organization-repositories).

De proxy garandeert geen anonimiteit tegenover GitHub: Cloudflare kan bij
Worker-subrequests zelf bezoekers-IP-headers toevoegen. De browser kan bij uitval
rechtstreeks naar GitHub terugvallen. Beide routes staan in de privacyverklaring.
Zie de [Cloudflare-headerdocumentatie](https://developers.cloudflare.com/fundamentals/reference/http-headers/).

## Verificatie

Run vanuit de repositoryroot:

```sh
node --test tests/privacy-regression.test.cjs
```

Controleer na deployment `/repos`: alleen publieke projectvelden, geen token of
privégegevens, en `X-Edge-Cache: MISS` gevolgd door `HIT` waar dezelfde edge-cache
wordt gebruikt. Log-instellingen zijn niet uit deze response af te leiden; bekijk
ze in het dashboard. Dit zijn technische controles, geen volledige juridische
beoordeling.
