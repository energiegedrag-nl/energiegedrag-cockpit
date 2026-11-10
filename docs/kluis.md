# Lokale kluis van proefpersonen (Energiegedrag Cockpit)

**Status:** ontwerp en eerste versie 10-11-2026, nog niet uitgerold. Eerste browserproef (mock-server, 10-11):
- **Opstarten:** de kluis start nadat de worker een module-worker werd (Pyodide 314 weigert klassieke workers).
- **Navigatie:** tussen Cockpit en kluis werkt het via `config.json`.
- **Caching:** bij herladen komen alle bestanden uit de cache (304); alleen het starten van Python kost ongeveer 8 s.
- **Kluis open houden:** de uitleg en `manifest.json` openen daarom in een nieuw tabblad, en de links tussen Cockpit en kluis gebruiken vaste tabbladen (commit 385d34f). Of dat in de browser goed werkt, is nog niet bevestigd.
- **Nog niet geprobeerd:** de volledige ronde (nieuwe kluis → CSV importeren → uitnodigen → mailen → herladen en ontgrendelen) en de duur van scrypt.

Lokaal rondklikken kan met `tools/mock_server.py`.
- Cockpit: [#3](https://github.com/energiegedrag-nl/energiegedrag-cockpit/pull/3), map `kluis/`.
- Server: [needforheat-server-api#25](https://github.com/energiegedrag-nl/needforheat-server-api/pull/25).
- Vervolg in de TODO van de server-api: `cockpitvault` (mail via de mailserver van energiegedrag.nl, helpdeskalias) en `cockpitflow` (stappenplan, oefencampagne).

Hoort bij het [ontwerp van de Cockpit](ontwerp.md), fase 2 "uitnodigingen".

## 1. Doel

De campagnebeheerder makkelijker laten uitnodigen, en tegelijk de privacy van proefpersonen zo goed mogelijk beschermen met een zo klein mogelijk aanvalsoppervlak.

NeedForHeat zelf is pseudoniem: de server kent accountnummers, geen namen. Maar de beheerder moet wél weten wie achter welk nummer zit: om uit te nodigen, apparaten te sturen en vragen te beantwoorden. Die koppeling stond tot nu toe ergens in een spreadsheet. De kluis geeft haar een vaste, versleutelde plek, **alleen bij de beheerder**.

## 2. Keuzes (10-11-2026)

| Onderwerp | Keuze | Waarom |
|---|---|---|
| Techniek | Python in de browser (Pyodide 314.0.7, zelf gehost), in een Web Worker; schil in gewone JavaScript zonder bouwstap | Zelfde aanpak als AnonyMate: één Python-kern, getest in CPython, controleerbaar |
| Opslag | **SQLite** als werkbestand, en een leesbare **CSV** voor import en export | Doorzoekbaar en uitbreidbaar; tekst voor uitwisseling en eigen administratie |
| Waar | In de browser (OPFS) **en** versleuteld op de NFH-server, als back-up met versies | Laptop kwijt is niet alles kwijt; de server ziet alleen grootte en tijdstip |
| Hosting | Eigen subdomein `kluis.energiegedrag.nl` naast de Cockpit, alleen LAN/VPN | Eigen origin: de gewone Cockpit-code kan niet bij de opslag van de kluis; eigen strenge CSP |
| Eigen mailserver | Via het **eigen mailprogramma** (mailto, .eml, samenvoeg-CSV); geen mailwachtwoorden in Cockpit of server | Zie § 5 |
| Mail via energiegedrag.nl | Mag alleen als de **beheerder dat per campagne aanzet** | Niet elke campagne mag zomaar namens het domein mailen |
| Helpdesk | Een **alias per campagne** (`helpdesk-<campagne>@energiegedrag.nl`) die doorstuurt naar de beheerder | Deelnemers zien het eigen adres van de beheerder niet; de beheerder zet de alias aan of uit |
| Aanpak | Ontwerp + eerste werkende versie; mail via de eigen mailserver en de helpdeskalias daarna | Bijsturen voordat het groot wordt |

## 3. Sleutels: symmetrisch of asymmetrisch?

**Allebei, in het open formaat [age](https://age-encryption.org/v1):**

- De **inhoud** is symmetrisch versleuteld (ChaCha20-Poly1305) met een willekeurige bestandssleutel per opslag.
- Die bestandssleutel is **asymmetrisch** ingepakt (X25519) voor elke publieke sleutel die de kluis mag openen: die van de beheerder en van collega's die de beheerder toevoegt.
- De **geheime sleutel** van de beheerder wordt in de browser gemaakt. Op het apparaat staat hij versleuteld met een **wachtwoordzin** (age scrypt, 2^18). Daarnaast is er een **herstelsleutel** (het age-identiteitsbestand) die de beheerder print of offline bewaart.

Waarom niet alleen een wachtwoord (symmetrisch)?
- Een tweede beheerder toevoegen kan dan alleen door het wachtwoord te delen; intrekken vraagt een nieuw wachtwoord voor iedereen.
- Met publieke sleutels voeg je iemand toe door diens `age1…`-sleutel op te nemen, zonder geheim rond te sturen.
- Later kan een aanmeldformulier gegevens direct versleutelen voor de publieke sleutel van de beheerder, zonder dat de server ze kan lezen (werving, [ontwerp](ontwerp.md) fase 3).

Waarom age?
- Klein en controleerbaar (de implementatie in `kluis/src/kluis/age.py` is ongeveer 300 regels), met een bekende Python-bibliotheek (`cryptography`) voor de bouwstenen.
- **Interoperabel**: CI test in beide richtingen tegen de officiële `age`-tool. De beheerder kan de kluis altijd buiten de Cockpit openen: `age -d -i herstelsleutel.txt kluis.age > kluis.sqlite`. Geen vendor lock-in, en een extra controle.
- Beperking van het formaat: een bestand met een wachtwoord (scrypt) mag geen andere ontvangers hebben. Daarom versleutelt de wachtwoordzin de *sleutel*, niet de kluis. Dat is ook het patroon dat age zelf aanraadt.

## 4. Wat waarheen gaat

| Gegevens | Waar | Leesbaar voor |
|---|---|---|
| Naam, e-mail, telefoon, adres, notities, koppeling persoon ↔ account | kluis (OPFS + back-up op server) | alleen sleutelhouders |
| Geheime sleutel | OPFS, versleuteld met wachtwoordzin; herstelsleutel offline | alleen de beheerder |
| Aantal nieuwe accounts | `POST /admin/campaigns/{id}/accounts` | server |
| Accountnummers en uitnodigingslinks | antwoord van de server; daarna in de kluis | server, sleutelhouders |
| Versleutelde kluis | `PUT /admin/vaults/{uuid}` | niemand zonder sleutel; de server ziet grootte en tijdstip |
| Uitnodigingsmail | eigen mailprogramma van de beheerder | mailprovider van de beheerder |

De nginx van de kluis laat alleen vijf API-routes door; de server weigert kluisbestanden die niet met `age-encryption.org/v1` beginnen (tegen per ongeluk onversleuteld uploaden).

## 5. E-mail en geheimen

**Vraag: zijn opgeslagen SMTP-gegevens van een andere mailserver een aanvalsoppervlak?** Ja, en een gevaarlijk:

- Op de NFH-server bewaard: wie de server kraakt, kan **namens de onderzoeksinstelling mailen naar precies de proefpersonen**. Dat is ideaal voor phishing ("open deze link om je meter te koppelen"). De server wordt dan een waardevoller doelwit dan hij nu is.
- In de kluis bewaard en per verzending door de server doorgegeven: kleiner, maar het geheim komt nog steeds langs de server, en een gekraakte server kan het op dat moment onderscheppen.
- Via het **eigen mailprogramma** van de beheerder: er bestaan nergens nieuwe geheimen. Het mailprogramma heeft het account al. **Gekozen.**

Wat de Cockpit daarvoor maakt:
- `mailto`-links per persoon;
- `.eml`-concepten (`X-Unsent: 1`, openen klaar om te versturen in Outlook en Thunderbird), als zip;
- een samenvoeg-CSV voor afdruk samenvoegen of een eigen mailtool.

**Mail via energiegedrag.nl** (later, TODO `cockpitvault`):
- Alleen voor campagnes waar de beheerder het aanzet: `PUT /admin/campaigns/{id}/mail`, standaard uit.
- De server stuurt dan via een eigen verzendaccount op de mailserver van energiegedrag.nl. De server ziet ontvanger en inhoud van wat hij verstuurt, en de mailserver logt ontvangers; dat noemt `controleer.html`.
- De helpdeskalias wordt een doorstuuradres op die mailserver.

## 6. Herkenbaar anders

- De kluispagina is donker (aubergine) met een vaste, amberkleurige band ("Lokale kluis · persoonsgegevens van proefpersonen, versleuteld op dit apparaat") en een gestippeld amberkleurig kader om de inhoud.
- Een statusregel toont: Python draait lokaal, kluis open of vergrendeld, aantal sleutels, lokaal opgeslagen, back-up op server, online of offline.
- De gewone Cockpit is licht en groen; daar staat alleen een amberkleurige knop "Lokale kluis".

## 7. Waarom je het kunt vertrouwen, en hoe je het nagaat

De pagina `controleer.html` in de kluis legt dit uit voor de beheerder. Kort:

1. **Netwerk zelf bekijken:** F12 → Netwerk laat alleen de vijf verzoeken zien; bij uitnodigen staat er alleen `{"count": n}` in.
2. **Content-Security-Policy:** alleen de eigen host, geen formulieren naar buiten, geen CDN. Zowel als `<meta>` (dus deel van de gecontroleerde bestanden) als header.
3. **Versleuteling zelf controleren:** de kluis downloaden en openen met `age` en `sqlite3`.
4. **Herkomst:** CI bouwt de kluis op `main` en ondertekent `manifest.json` met `actions/attest-build-provenance`; `gh attestation verify manifest.json --repo energiegedrag-nl/energiegedrag-cockpit`.
5. **Reproduceerbaar bouwen:** `kluis/maak.py` geeft voor dezelfde commit byte voor byte dezelfde bestanden (gemeten: twee builds op Windows identiek; CI bouwt twee keer en vergelijkt). `python kluis/controleer.py https://kluis.energiegedrag.nl/` bouwt zelf en vergelijkt elk bestand met de live site.
6. **Pyodide:** vastgepind (314.0.7), runtime gecontroleerd tegen `kluis/pyodide-sha256.json` (dezelfde waarden als bij AnonyMate), pakketten tegen `pyodide-lock.json`; de browser controleert de pakketten bij het laden nog eens (`checkIntegrity`).
7. **Code:** de kern (`kluis/src/kluis`) importeert geen netwerkbibliotheek (test `test_kern.py`); de schil (`app.js`) geeft alleen JSON door.

Wat dit **niet** afdekt, en zo ook op de pagina staat:
- Een gekraakte server kan andere code uitleveren; dat zie je alleen als je controleert.
- Malware op de laptop van de beheerder kan meekijken terwijl de kluis open is.
- Exports en mailconcepten zijn onversleuteld.
- De server ziet metadata: grootte, tijdstip, aantallen.

**Verdere stap** (nog niet gebouwd): de kluis daarnaast op GitHub Pages zetten, met de API via CORS. Dan kan de partij die de NFH-server host de kluiscode niet meer stilletjes vervangen. Bewust nog niet gedaan: de API is nu alleen op het LAN bereikbaar.

## 8. Opbouw

```
kluis.energiegedrag.nl (nginx, alleen LAN/VPN)
├── index.html, app.js, kluis.css   schil: schermen, OPFS, de vijf API-verzoeken
├── worker.js                       Web Worker: Pyodide + kluis.zip (sha256 uit kluis.json)
│     └── kluis (Python)            age.py, bech32.py, db.py (SQLite), mail.py, web.py (JSON-facade)
├── pyodide/                        runtime + cryptography, cffi, pycparser, six
├── manifest.json                   elk bestand met sha256, commit, versies
└── /api/… → api:8080               alleen overview, accounts, mail, vaults
```

- Vergrendelen beëindigt de worker: sleutel en database verdwijnen uit het geheugen.
- Opslaan schrijft `kluis.age` naar OPFS en stuurt hem naar de server. De server weigert een opslag op een verouderde versie (409); dan laadt de beheerder eerst de serverversie. Samenvoegen bij gelijktijdig werken door twee beheerders zit er nog niet in.

## 9. Uitrol (nog te doen)

1. Server-api #22, #23 en #25 in een image (zelfde open punt als in het [ontwerp](ontwerp.md)).
2. Een container `kluis` naast de Cockpit:
   - build `https://github.com/energiegedrag-nl/energiegedrag-cockpit.git#main` met `dockerfile: kluis/Dockerfile` en build-arg `BUILDKIT_CONTEXT_KEEP_GIT_DIR=1`, zodat de commit in `manifest.json` komt;
   - `API_UPSTREAM: http://api:8080`.
3. Een route op `kluis.energiegedrag.nl` in de reverse proxy, alleen LAN/VPN, plus een DNS-record.
4. Eerste test in Chrome en Edge (en Firefox): Pyodide-start, OPFS, de duur van scrypt 2^18 in WebAssembly, en een volledige ronde van nieuwe kluis tot uitnodigen en mailen.

## 10. Open punten

- **Browsertest:** de kern is in CPython getest; in de browser alleen de eerste proef hierboven.
- **scrypt in de browser:** 2^18 vraagt ongeveer 256 MB en kan in WebAssembly traag zijn. Te meten; zo nodig 2^17. Openen met `age` blijft werken.
- **Samenvoegen** van gelijktijdige wijzigingen door twee beheerders.
- **Rollen** (fase 2, OIDC): nu kan iedereen met het beheertoken ook de mailinstelling per campagne zetten. Na OIDC alleen de beheerder.
- **Bewaartermijn:** wanneer de kluis van een afgelopen campagne gewist wordt (AVG); een knop "campagne afsluiten" die de persoonsgegevens verwijdert en alleen accountnummers houdt.
