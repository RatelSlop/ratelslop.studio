# RatelSlop repositories Worker

Publieke metadata-proxy voor `https://api.ratelslop.studio/repos`. De Worker vraagt
expliciet openbare GitHub-repositories op, accepteert alleen `private: false` en
geeft alleen de velden terug die het projectenoverzicht nodig heeft. De gedeelde
edge-cache heeft een versheidsperiode van 180 seconden. De broncode schrijft geen
bezoekers-IP's of headers naar logs. De bestaande Cloudflare-dashboarddeployment
gebruikt wel Workers Logs voor onderzoek naar bots, misbruik en beveiligingsincidenten.

## Deployment

Een GitHub-push publiceert deze Worker **niet** automatisch. Deploy de gewijzigde
`index.js` afzonderlijk naar de bestaande Worker en behoud het domein
`api.ratelslop.studio`. De interne cache-key `/repos-public-v2` voorkomt dat de
nieuwe code responses van eerdere Worker-versies hergebruikt. De publieke route
blijft `/repos`. Eerder gedownloade of extern gecachte gegevens worden hierdoor
niet ingetrokken.

### Cloudflare Dashboard

1. Open de bestaande `ratelslop-repos` onder **Workers & Pages**.
2. Vervang de code via **Edit code** door [`index.js`](./index.js) en deploy.
3. Controleer Workers Logs / Observability. Het bestaande beveiligingsgebruik
   staat in de privacyverklaring. Beperk logging tot dat doel en voeg geen eigen
   logging van tokens, berichtinhoud of bezoekersheaders toe. Alleen code plakken
   past `wrangler.json` niet toe.
4. Controleer eventuele afzonderlijke Tail Workers, Logpush en externe exports;
   zet deze niet aan zonder noodzaak, passende instellingen en privacy-informatie.
5. Controleer dat het bestaande domein naar deze Worker wijst.

### Wrangler

Voer vanuit `worker/` uit met een actuele Wrangler-versie:

```sh
npx wrangler login
npx wrangler deploy
```

[`wrangler.json`](./wrangler.json) bevat `observability.enabled: false` en wijkt
daarmee af van de huidige dashboarddeployment. Een deployment met dit bestand
schakelt Workers Logs uit. Als je de bestaande beveiligingslogging ook bij een
Wrangler-deployment wilt behouden, stel dan vóór die deployment bewust
`observability.enabled: true` in en controleer de sampling en effectieve
instellingen. Deze repository past de dashboardinstellingen niet zelfstandig aan.

Workers Logs kunnen automatisch informatie over verzoeken en responses en
uitvoeringsdiagnostiek bevatten, ook zonder `console.log` in de broncode. Cloudflare
documenteert momenteel drie dagen bewaring op Workers Free en zeven dagen op
Workers Paid. Deze termijnen gelden niet automatisch voor afzonderlijke exports
of Cloudflare's eigen netwerk- en beveiligingsgegevens. Uitschakelen van Workers
Logs verwijdert niet automatisch eerder opgeslagen logs. Zie de
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

De Worker volgt geen redirects bij GitHub-verzoeken (`redirect: 'manual'`), zodat
de Authorization-header niet naar een redirectbestemming wordt doorgestuurd.
Cloudflare ondersteunt alleen `follow` en `manual`; `error` veroorzaakt daar een
runtimefout voordat het GitHub-verzoek wordt verstuurd. Zie de
[workerd-implementatie](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/http.c%2B%2B)
en Cloudflare's advies voor
[redirect-beleid](https://developers.cloudflare.com/workers/runtime-apis/request/#properties).
Een onverwachte redirect laat de repositorylijst veilig mislukken; bij een
taalverzoek wordt de primaire programmeertaal gebruikt. Deploy deze code apart
naar Cloudflare om deze beveiliging ook op de actieve Worker toe te passen.
Lokale Wrangler-bestanden `.dev.vars`, `.dev.vars.*` en `.wrangler/` worden door
`.gitignore` uitgesloten; houd tokenwaarden ook uit andere bestanden en logs.

De proxy garandeert geen anonimiteit tegenover GitHub: Cloudflare kan bij
Worker-subrequests zelf bezoekers-IP-headers toevoegen. De browser kan bij uitval
rechtstreeks naar GitHub terugvallen. Beide routes staan in de privacyverklaring.
Zie de [Cloudflare-headerdocumentatie](https://developers.cloudflare.com/fundamentals/reference/http-headers/).

## Caching en verzoekbudget

De volledige openbare response blijft 180 seconden vers. Zowel cache-misses als
cache-hits krijgen `Cache-Control: public, max-age=180, s-maxage=180`; de Worker
herstelt dit expliciet als de Cache API een langere browserduur teruggeeft.
Cache-hits behouden hun `Age`-header en gebruiken ook de oorspronkelijke `Date`,
zodat een browser de versheidsperiode niet opnieuw laat beginnen. Bij een leeftijd
van 180 seconden of meer, ongeldige `Age` of ontbrekende bruikbare leeftijd vraagt
de Worker GitHub opnieuw op. GET en HEAD gebruiken dezelfde cache; HEAD heeft geen
responsebody. Een onbeschikbare cache blokkeert geen succesvolle GitHub-response.

Controleer bij deployment ook Cloudflare **Browser Cache TTL**: gebruik
**Respect Existing Headers** en laat toepasselijke Cache Rules / Page Rules voor
`api.ratelslop.studio` de browserduur niet overschrijven. Cloudflare kan een kortere
`max-age` anders verhogen tot de ingestelde browserduur; de standaardwaarde is vier
uur. De broncode herstelt headers die uit de Cache API komen, maar voorkomt geen
latere overschrijving door platforminstellingen. Controleer daarom op het live
endpoint zowel MISS als HIT en HEAD: `max-age=180`, `s-maxage=180` en bij een HIT een
geldige `Age` kleiner dan 180. Eerder in browsers opgeslagen responses met een
langere duur worden niet ingetrokken. Zie de
[Browser Cache TTL-documentatie](https://developers.cloudflare.com/cache/how-to/edge-browser-cache-ttl/).

Een afzonderlijke interne cache (`/repos-revalidation-v1`, maximaal één uur) bevat
uitsluitend gecontroleerde openbare projectvelden, taalnamen, beperkte hexadecimale
ETags, veilige paginalinks en numerieke rate-limitinformatie. Ruwe geauthenticeerde
GitHub-responses, tokens, bezoekersheaders en foutberichten worden niet opgeslagen.
Na afloop van de drie minuten vraagt de Worker met `If-None-Match` opnieuw aan
GitHub of de gegevens veranderd zijn. Alleen een bijbehorende 304-response laat
eerder gecontroleerde gegevens hergebruiken. Geauthenticeerde 304-responses tellen
volgens GitHub niet mee voor de primaire rate limit. Zie de
[GitHub-aanbevelingen voor REST-verzoeken](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).

GitHub-verzoeken verlopen na elkaar. De totale upstream-deadline is acht seconden,
inclusief het lezen van JSON-bodies. Er zijn maximaal 40 GitHub-verzoeken per
cache-miss; samen met maximaal vier Cache API-operaties blijft dit onder de
50 subrequests van Workers Free. De repositorylijst volgt maximaal vijf pagina's
van 100 repositories. Een fout, cyclus of extra pagina laat de lijst volledig
mislukken. Bij onvoldoende tijd/budget of een mislukte taalrequest blijft de primaire
programmeertaal beschikbaar. HTTP 403/429 stopt verdere taalrequests. Zie de
[Cloudflare-limieten](https://developers.cloudflare.com/workers/platform/limits/).

Bij bevestigde throttling of een numerieke `Retry-After` pauzeert de Worker nieuwe
GitHub-verzoeken in dezelfde edge-cache. Hij gebruikt de wachttijd/resetinformatie,
met een minimum van één seconde, een terugval van 60 seconden bij ontbrekende of
verstreken resetinformatie, en een maximum van één uur. Bij langere opgegeven
wachttijden eindigt de lokale pauze dus eerder; volg als beheerder altijd GitHub's
volledige wachttijd. De foutresponse zelf blijft `no-store`; alleen de beperkte
numerieke pauze-informatie gaat in de interne cache. Een lijst die vóór een
taalrequest beschikbaar was, kan tijdens die pauze nog uit de verse responsecache
komen.

Deze caches en pauzes gelden per Cloudflare-datacenter; verschillende datacenters
en gelijktijdige misses kunnen elk GitHub opvragen. De Cache API bundelt die misses
niet automatisch. Cloudflare's afzonderlijke
[Workers Cache](https://developers.cloudflare.com/workers/cache/) kan verzoeken
bundelen en tiered caching bieden, maar vereist expliciete `cache.enabled`
deploymentconfiguratie en een geschikte Wrangler-versie. Alleen deze broncode in
het dashboard plakken activeert dat niet; het is hier niet ingeschakeld.

De homepage wacht maximaal tien seconden op de proxy. Directe GitHub-terugval
krijgt een totaalbudget van zes seconden, leest de eerste 100 repositories en
vraagt optionele talen na elkaar op, maximaal 1,5 seconde per taalrequest. Hij stopt
die taalrequests bij 403/429. Zowel Worker als browser accepteren alleen HTTP(S)
homepages zonder gebruikersnaam/wachtwoord en bouwen repositorylinks zelf op.
De GitHub REST-versie is expliciet vastgezet op `2022-11-28` om de bestaande
responsevorm te behouden; de testdependencies zijn eveneens vastgezet.

## Verificatie

### GitHub-rate-limits vaststellen

Deploy de bijgewerkte Worker en open `/repos`. Bij een mislukte repositorylijst
blijft de HTTP-status 502, maar bevat de JSON-response nu een `github`-object met
de upstream-status en uitsluitend numerieke rate-limitgegevens:

```json
{
  "error": "Failed to fetch repositories",
  "github": {
    "status": 403,
    "rate_limit": "primary",
    "limit": 60,
    "remaining": 0,
    "reset": 1790850600,
    "retry_after": null
  }
}
```

Dit is een voorbeeld, geen meting van de live Worker. `rate_limit: "primary"`
bevestigt een primaire rate limit: GitHub gaf 403/429 en nul resterende verzoeken.
`"secondary"` betekent dat GitHub een secundaire rate limit meldde.
`"unconfirmed"` betekent dat 403/429 onvoldoende informatie bevat om throttling
vast te stellen; een 403 alleen bewijst geen rate limit. Bij andere statussen is
`rate_limit` null. Ontbrekende of ongeldige numerieke headers worden null.
`reset` is een Unix-tijdstip in seconden; `retry_after` is de wachttijd in seconden.
Wacht bij throttling tot het toepasselijke reset-tijdstip en/of de aangegeven
wachttijd voorbij is voordat je opnieuw probeert. Zie de
[GitHub-documentatie](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#rate-limit-errors).

Zonder `github`-object is er geen bruikbare upstream-foutresponse: bijvoorbeeld
een netwerkfout of ongeldige JSON. Fouten bij het ophalen van programmeertalen
vallen al terug op de primaire taal en veroorzaken deze 502 niet.
De diagnostiek doet geen extra API-verzoeken, schrijft geen logs en geeft geen
ruwe foutberichten, IP-adressen, tokens of willekeurige headers terug. Foutresponses
worden niet gecachet; beperkte numerieke pauze-informatie kan wel in de hierboven
beschreven interne cache staan. De privacyverklaring beschrijft deze caching in
het Engels en Nederlands. De partijen, rechtsgrond en lokale browseropslag zijn
ongewijzigd. De voorwaarden zijn gecontroleerd; projectlicenties en aansprakelijkheid
worden door deze metadata- en betrouwbaarheidswijzigingen niet aangepast.

### Regressiecontrole

Run vanuit de repositoryroot:

```sh
npm ci
npm test
```

Gebruik Node.js 24 voor de geteste omgeving. De suites controleren de homepage,
privacy/voorwaarden en de Worker in zowel een testharness als de echte
Miniflare/workerd-runtime. Upstream-responses zijn gesimuleerd; alle gebruikte
tokenwaarden zijn herkenbare nepwaarden. De runtimecontroles omvatten redirects,
304/ETags, pagination, rate-limitpauzes, deadlines tijdens het lezen van bodies,
requestbudgetten, HEAD en cachefouten. Testdependencies worden niet door de browser
geladen en gaan niet mee in een Worker-deployment.

Controleer na deployment `/repos`: alleen publieke projectvelden, geen token of
privégegevens, en `X-Edge-Cache: MISS` gevolgd door `HIT` waar dezelfde edge-cache
wordt gebruikt. Log-instellingen zijn niet uit deze response af te leiden; bekijk
ze in het dashboard. Dit zijn technische controles, geen volledige juridische
beoordeling.
