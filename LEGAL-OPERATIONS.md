# Beheerpunten voor privacy en voorwaarden

Beoordelingsdatum: 30 september 2026. Dit bestand legt vast welke feiten nog door
de beheerders moeten worden bevestigd. Een bijgewerkte privacyverklaring of ToS
bewijst op zichzelf geen volledige naleving.

## Nog te bevestigen

- **AVG-toepasselijkheid en verantwoordelijke(n):** beoordeel eerst per
  verwerking of de uitzondering voor uitsluitend persoonlijke of huishoudelijke
  activiteiten geldt (artikel 2 lid 2 sub c en overweging 18 AVG). Ook online
  activiteiten en hobby's kunnen daaronder vallen. Openbare toegankelijkheid is
  op zichzelf geen volledige beoordeling; het ontbreken van inkomsten evenmin.
  Betrek de daadwerkelijke doelen, bezoekersverwerking via hosting en Worker, en
  de aard van supportcorrespondentie bij die beoordeling. De publieke hub toont
  particuliere hobbyprojecten zonder commercieel doel; dat is relevante context,
  geen automatische vrijstelling voor iedere verwerking.
  Voor verwerkingen waarop de AVG van toepassing is, bepaal wie de doelen en
  middelen daadwerkelijk bepaalt en vermeld diens echte identiteit en
  contactgegevens in `privacy/index.html`, zowel in de initiële HTML als in
  `TRANSLATIONS.en` en `.nl`. Een contributor is niet automatisch verantwoordelijke.
  Waar deze informatieplicht geldt, vervangen de creatieve naam RatelSlop en
  alleen een contactmail de identiteit niet. Bij gezamenlijke verantwoordelijkheid
  moeten ook de onderlinge verantwoordelijkheden passend worden geregeld. Zie
  [AVG, artikelen 2, 13 en 26 en overweging 18](https://eur-lex.europa.eu/eli/reg/2016/679/oj),
  de [uitleg van de BfDI over de huishoudelijke uitzondering](https://www.bfdi.bund.de/SharedDocs/Downloads/DE/Broschueren/INFO1.pdf?__blob=publicationFile&v=27)
  en de [Hessische toezichthouder over providerlogs op eenvoudige websites](https://datenschutz.hessen.de/infothek/haeufig-gestellte-fragen).
- **Duitse aanbiedersinformatie:** beoordeel de daadwerkelijke publieke
  projecthub en afzonderlijke diensten onder
  [§ 5 DDG](https://www.gesetze-im-internet.de/ddg/__5.html) en
  [§ 18 MStV](https://www.gesetze-bayern.de/Content/Document/MStV-18).
  Niet-commercieel of hobby betekent niet automatisch uitsluitend persoonlijk of
  familiair. Omgekeerd bewijst openbare toegankelijkheid op zichzelf geen
  Impressumplicht. De uitzondering voor uitsluitend persoonlijke of familiale
  doeleinden moet apart worden beoordeeld; zie de
  [uitleg van de Landesanstalt für Medien NRW](https://www.medienanstalt-nrw.de/aufsicht/transparenz-im-internet.html).
  Als een plicht geldt, moeten naam, adres en overige toepasselijke
  gegevens werkelijk gemakkelijk vindbaar worden gepubliceerd. De voorwaardelijke
  uitleg in de ToS vervult zo'n plicht niet. Laat de toepasselijkheid en een
  eventueel geschikt bereikbaar adres gericht beoordelen; publiceer geen
  verzonnen identiteit of adres.
- **Werkelijke providerinstellingen en overeenkomsten:** verifieer de
  Cloudflare-accountvoorwaarden, toepasselijke verwerkersafspraken en eventuele
  subverwerkers/doorgiftewaarborgen. Controleer dezelfde rollen en voorwaarden voor
  GitHub Pages en de gebruikte Gmail-dienst; neem niet aan dat een particuliere
  Gmail-mailbox dezelfde afspraken heeft als Google Workspace. De bevestigde
  mailroute is Cloudflare Email Routing naar Gmail; het privé-e-mailadres hoeft
  daarvoor niet publiek te worden gemaakt.
- **Bewaring en verzoeken:** voer het beschreven bewaarbeleid daadwerkelijk uit.
  Beoordeel supportcorrespondentie na afhandeling en verwijder wat niet meer nodig
  is, rekening houdend met aantoonbare verplichtingen of geschillen. Leg passende
  interne controles en termijnen vast. Controleer de bereikbaarheid van
  `support@ratelslop.studio` en handel privacyverzoeken binnen de AVG-termijnen af.
- **Gerechtvaardigd belang:** documenteer voor verwerkingen waarop de AVG van
  toepassing is doel, noodzakelijkheid en afweging voor hosting,
  projectmetadata-verzoeken en supportmail (AVG artikel 6 lid 1 sub f).
  Alleen de rechtsgrond in de privacyverklaring noemen is geen volledige afweging.

## Technische correcties in de repository

- De Worker vraagt `type=public` op, filtert `private === false` vóór taalverzoeken
  en caching, en publiceert alleen benodigde projectvelden. De nieuwe cache-key
  omzeilt responses uit de eerdere ongefilterde implementatie.
- Browser-API-verzoeken gebruiken `credentials: 'omit'` en
  `referrerPolicy: 'no-referrer'`. Dit verhindert geen runtime-headers die
  Cloudflare zelf aan subrequests toevoegt.
- Projectgegevens gebruiken geen applicatie-localStorage meer. Thema en taal
  worden pas na een expliciete keuze opgeslagen, met een zichtbaar bericht bij de
  bediening; geblokkeerde opslag verhindert de bediening niet. Oude projectcache-
  entries worden niet meer gebruikt en kunnen via het wissen van sitegegevens
  worden verwijderd. Gewone HTTP-caching blijft mogelijk.
- Privacy en ToS beschrijven hosting, proxy, directe fallback, supportmail,
  rechten, projectlicenties en wettelijke aansprakelijkheidsuitzonderingen in
  Engels en Nederlands. De eerdere ongefundeerde adresvrijstelling is verwijderd.
- Wrangler schakelt persistente observability in de gewenste configuratie uit.
  De daadwerkelijk gedeployde Worker, accountinstellingen en eventueel aanwezige
  exports moeten afzonderlijk worden gecontroleerd; zie [worker/README.md](worker/README.md).

## Bij volgende wijzigingen

Controleer nieuwe providers, verzoeken, opslagdoeleinden, licenties en zelfstandige
projecten opnieuw. Houd beide talen én de initiële HTML gelijk. Externe projecten
hebben een eigen beoordeling nodig op basis van hun echte werking. Een gewone
link maakt de hub niet automatisch verantwoordelijk voor iedere externe dienst,
maar een ander domein neemt verantwoordelijkheid voor zelf beheerde diensten
evenmin weg.

De lokale regressietests controleren gegevensfilters, caching, browseropslag,
uitvalgedrag en de synchronisatie van de juridische teksten. Ze kunnen de
identiteit, contracten, mailboxpraktijk, Cloudflare-accountinstellingen of de
toepasselijkheid van wettelijke informatieplichten niet vaststellen.
