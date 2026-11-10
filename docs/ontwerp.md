# Ontwerp: Energiegedrag Cockpit (campagnebeheer en firmware-uitrol vanuit de browser)

**Herkomst:** dit ontwerp bouwt voort op ideeën die zijn ontwikkeld tijdens het werk aan [NeedForHeat](https://github.com/energietransitie) bij Windesheim, waar een webportaal voor onderzoekers oorspronkelijk als afstudeeropdracht HBO-ICT was bedacht.

**Status:** ontwerp 08-11-2026. Fase 1, stap 1–4 gebouwd op 10-11-2026, nog niet uitgerold:
- beheer-API in [needforheat-server-api#22](https://github.com/energiegedrag-nl/needforheat-server-api/pull/22): `GET /admin/overview`, `GET /admin/campaigns/{id}/status`, `PATCH /admin/campaigns/{id}`, `POST /admin/campaigns/{id}/accounts`, `POST /admin/accounts/{id}/invitation`;
- apparaatvoorraad in [needforheat-server-api#23](https://github.com/energiegedrag-nl/needforheat-server-api/pull/23) (op #22): `GET /admin/inventory`, `GET /admin/inventory/{id}`, `GET /admin/inventory/mac/{mac}`, `POST /admin/inventory/flash`, `POST /admin/inventory/{id}/events`; tabellen `inventory_device` en `inventory_event`;
- webapp in deze repo: [#1](https://github.com/energiegedrag-nl/energiegedrag-cockpit/pull/1) inloggen met beheertoken, campagnes, uitnodigingen met QR, statustabel deelnemer × databron; [#2](https://github.com/energiegedrag-nl/energiegedrag-cockpit/pull/2) flashstation (Web Serial, esptool-js 0.7.0), voorraad en de firmwarespiegel `mirror/`;
- uitrol: een `cockpit`- en een `firmware-mirror`-container naast de API, achter een reverse proxy die de Cockpit alleen vanaf het LAN of via VPN doorlaat; de publieke API-route sluit `/v3/admin` uit.

Lokale kluis van proefpersonen (uitnodigen met namen en e-mail, versleuteld bij de campagnebeheerder): [kluis.md](kluis.md).

Nog open voor uitrol: een API-image met server-api #22 en #23, DNS voor `cockpit.energiegedrag.nl` en een beheertoken. Het flashstation is niet op hardware getest.

Afwijkingen van dit ontwerp:
- de inrichting van apps, apparaattypes en lijsten zit nog niet in de Cockpit (stap 2 deels);
- "te laat" gebruikt alleen `notification_threshold`, niet het cron-schema;
- het manifest maakt niet de CI van de firmware-repo's maar de spiegeltaak: die leest de bestaande release-zips, haalt de partitietabel-offset uit de `sdkconfig` bij de tag (bij de NFH-firmware `0x18000`) en de overige offsets uit bootloader-header en partitietabel. Zo hoeven de firmware-repo's niet te veranderen en werken oude releases ook. De spiegel **weigert builds met secure boot of flash-encryptie**, omdat die bootloader bij de eerste start eFuses zou branden;
- geen NVS-image per apparaat en geen Bluetooth-provisioning vanuit de browser (beide optioneel, later);
- het label wordt direct na het flashen geprint uit de console-uitvoer; de QR-inhoud (met het apparaatgeheim) wordt niet opgeslagen, dus herprinten = opnieuw wissen en flashen;
- de levenscyclus is *geflasht → toegewezen → uitgegeven → retour → gewist*; "actief" volgt uit de `device`-tabel (zelfde naam, door de app geactiveerd) en wordt niet apart bijgehouden.

## 1. Wat het portaal moet doen

Een webportaal voor "energiedokters" (eerst onderzoekers, later energieadviseurs) dat:
1. **werving** ondersteunt: intakeformulier, toestemming (pseudoniem), in-/exclusiecriteria;
2. **selectie** van deelnemers;
3. **uitrol** ondersteunt: firmware op meetapparaten zetten, uitnodiging met persoonlijke activeringslink voor de app;
4. **bewaking** geeft van start, voortgang en einde: status per campagne (nog niet gestart, loopt, sluit af, gesloten), per deelnemer (uitgenodigd, actief, gestopt) en per databron per deelnemer; meldingen (late start, ontbrekende uploads) en hulp bij herinneringen;
5. een **helpdesk** integreert.

## 2. Keuzes in het kort

| Onderwerp | Keuze | Waarom |
|---|---|---|
| Bouwen of kopen | **Kern zelf bouwen** (campagnes, apparaten, uitnodigingen, bewaking, flashen); **werving/intake, toestemming en helpdesk koppelen aan bestaande open source** | De kern is NeedForHeat-specifiek en klein; formulieren, identiteit en tickets zijn opgeloste problemen (LimeSurvey, Yivi/Keycloak, Zammad) |
| Frontend | **TypeScript, React + Vite + TanStack Query**, statisch geserveerd | Zelfde stack als de app: de **zod-schema's uit `apps/expo/src/types/api.ts` zijn herbruikbaar** (gedeeld pakket in de monorepo of eigen repo) |
| Backend | **Geen aparte backend**: de Cockpit praat met `needforheat-server-api`, die een **beheer-API** krijgt (lijsten, wijzigen, status) | De server had alleen `POST`-aanmaakroutes voor beheer; die uitbreiding is hoe dan ook nodig |
| Hosting | Statische bestanden (nginx) naast de API; host `cockpit.energiegedrag.nl`, via de reverse proxy **alleen LAN/VPN** | Geen nieuw publiek oppervlak; HTTPS is nodig voor Web Serial en Web Bluetooth (secure context) |
| Inloggen | Fase 1: beheertoken (uit een wachtwoordkluis) in `sessionStorage`, alleen via LAN/VPN. Fase 2: **OIDC** (Keycloak of Authentik; voor deelnemers later Yivi) met rollen; de server-API valideert OIDC-tokens naast de eigen JWT's | Fase 1 is genoeg voor één beheerder; fase 2 voor meerdere onderzoekers |
| Firmware in de browser | **Web Serial + `esptool-js`** (Espressif, Apache-2.0; 0.7.1 van 02-11-2026), met het manifest-formaat van **ESP Web Tools** (Apache-2.0; 10.4.0) | Officieel, onderhouden, geen installatie op de laptop |
| Provisionen vanuit de browser (optioneel) | **Web Bluetooth + `esp-idf-provisioning-web`** (MIT; security 1 via WebCrypto X25519) | Testen in het lab zonder telefoon; *geen* vervanging van de app (iOS/Safari heeft geen Web Bluetooth) |

## 3. Gebruikers en rollen

| Rol | Doet | Fase |
|---|---|---|
| Beheerder | apparaattypes, databronnen, firmware-releases, rollen | 1 |
| Campagnebeheerder (onderzoeker) | campagne opzetten, deelnemers uitnodigen, voortgang volgen, herinneren | 1 |
| Uitrol-medewerker (lab) | apparaten flashen, labelen, aan een deelnemer toewijzen, retouren wissen | 1 |
| Energieadviseur | eigen klanten volgen, alleen leesrechten op hun data | 3 |
| Deelnemer | eigen data inzien, toestemming beheren | 3 |

## 4. Functies per fase

**Fase 1: kleine campagnes (MVP)**
1. **Inrichting** (vervangt het handmatige `curl`-draaiboek): app(s), apparaattypes, cloudfeed- en energy-query-types, databronnen met handleiding-URL's en schema's, databronnenlijsten, campagnes.
2. **Deelnemers en uitnodigingen:** account aanmaken binnen een campagne; uitnodigingslink tonen, als **QR-code** printen en via `mailto:` versturen (fase 2: server-side mail, met sjabloon); status *uitgenodigd → geactiveerd → actief → gestopt*.
3. **Bewaking:** per deelnemer per databron: laatste upload, verwachte volgende upload (uit `upload_schedule`), achterstand ten opzichte van `notification_threshold`; campagnestatus; lijst "aandacht nodig". Dezelfde logica als de app (`checkMissedUpload`), maar dan op de server berekend.
4. **Flashstation** (§ 6): apparaat aan USB, firmware kiezen (passend bij de campagne), flashen, identiteit uitlezen (MAC, QR-naam), registreren in de **apparaatvoorraad**, label met QR printen.
5. **Apparaatvoorraad:** levenscyclus *voorraad → geflasht → toegewezen → verzonden → actief → retour → gewist → voorraad*, met firmwareversie en historie.

**Fase 2: meerdere onderzoekers**
- OIDC-login en rollen; audit-log van beheeracties.
- Mail en herinneringen server-side (sjablonen, planning, afmelden).
- **Eigen firmware-updatekanaal**: apparaten vragen de server om een update in plaats van de GitHub-API (die 60 verzoeken per uur per IP toestaat en waarvan de TLS-keten kan veranderen). De Cockpit bepaalt per campagne of apparaattype welke versie en voor welk percentage (gefaseerde uitrol).
- Export voor analyse (Parquet/CSV per campagne), aansluitend op de bestaande preprocessing.

**Fase 3: werving en deelnemers**
- **Intake en toestemming:** LimeSurvey (open source) voor vragenlijsten en in-/exclusie; toestemming cryptografisch vastleggen en pseudonieme login via Yivi/OIDC met pairwise identifiers. De Cockpit bewaart alleen een pseudoniem en de koppeling naar het account; **geen namen of e-mailadressen in de NeedForHeat-database** (die staan in de [kluis](kluis.md), bij de beheerder).
- **Helpdesk:** Zammad of FreeScout (open source), met een link vanuit de deelnemerspagina in de Cockpit en een "meld een probleem" in de app.
- Portaal voor deelnemers en energieadviseurs (eigen data inzien; EU Data Act).

## 5. Architectuur

```
                     LAN / VPN                                          internet
 laptop ── Chrome/Edge ──► cockpit.energiegedrag.nl ─┐            app ─► api.energiegedrag.nl/v3
   │   Web Serial (USB) ─► ESP32 op het flashstation  │                     │
   │   Web Bluetooth (opt.)                           ▼                     ▼
   │                                       reverse proxy ─► NFH-server: web (nginx, statisch: Cockpit + firmware-spiegel)
   │                                                            api (needforheat-server-api) ─► MariaDB
   │                                                                └─ /admin/* (nieuw, alleen via LAN/VPN)
   └─ firmware-binaries van dezelfde origin (/firmware/...), gespiegeld uit de GitHub-releases
```

**Uitbreiding `needforheat-server-api`** (nieuw prefix `/admin`, de reverse proxy laat dat alleen via LAN/VPN door):
- `GET/PATCH` voor app, campagne, apparaattype, databron, lijst; **soft delete** (archiveren) in plaats van verwijderen.
- `GET /admin/campaigns/{id}/status`: per account per databron de bewakingsgegevens (§ 4.3), in één aanroep.
- `POST /admin/accounts/{id}/invite` (fase 2: mail).
- **Apparaatvoorraad:** nieuwe tabel `inventory_device` (mac, device_type, firmware_version, state, account_id, history), los van `device` (dat pas ontstaat bij koppelen in de app); koppeling via de BLE-naam/MAC.
- `GET /admin/firmware`: beschikbare releases per apparaattype (uit de spiegel), met SHA-256.
- Fase 2: `GET /firmware/latest?device_type=…` voor apparaten (eigen OTA-kanaal), met per campagne vastgezette versies en uitrolpercentages.

## 6. Firmware uitrollen vanuit de browser

### Techniek (stand november 2026)

| | Web Serial (flashen) | Web Bluetooth (provisionen) |
|---|---|---|
| Chrome/Edge desktop (Windows, macOS, Linux, ChromeOS) | ✅ sinds versie 89 | ✅ |
| Chrome Android | ⚠ USB vanaf Chrome 148 (april 2026) op Android 17, **apparaatafhankelijk**; daarvoor alleen Bluetooth-RFCOMM | ✅ |
| Firefox, Safari (ook iOS) | ❌ | ❌ |

- Vereist **HTTPS** (of `localhost`) en een gebruikersactie (klik) om een poort of apparaat te kiezen.
- **Flashstation = laptop met Chrome of Edge.** Flashen vanaf een telefoon niet als eis opnemen.
- `esptool-js` schrijft images naar flash; het doet **geen eFuses** (geen `espefuse`/`espsecure`). Secure boot of flash-encryptie (nu nergens aan) vraagt een eenmalige stap met de Python-tools in het lab; ondertekende images flashen kan daarna wel vanuit de browser.

### Releasekanaal

1. **CI per firmware-repo** (GitHub Actions, al aanwezig) bouwt bij een tag per omgeving. In plaats van de huidige `TEST_SERVER`/`PRODUCTION_SERVER`-varianten: één build met `CONFIG_*_SERVER_HOSTNAME` (generic-firmware PR #2/#3), of, beter op termijn, de hostnaam in **NVS** (zie hieronder) zodat één image overal werkt.
2. Een **manifest** in ESP Web Tools-formaat (`chipFamily`, `parts` met `path` en `offset`). De offsets komen uit de build, niet met de hand: de partitietabellen wijken af van de standaard (bij de P1-lezer staat `nvs` op `0x19000`, `ota_0` op `0x20000`). In de huidige versie maakt de spiegeltaak het manifest (zie *Afwijkingen* bovenaan).
3. Een **spiegeltaak** naast de Cockpit haalt nieuwe releases op, controleert de SHA-256 en zet ze onder `https://cockpit.energiegedrag.nl/firmware/<repo>/<tag>/`. Dat geeft dezelfde origin (geen CORS-problemen met GitHub-downloads) en maakt de uitrol onafhankelijk van GitHub en upstream.

### Per-apparaatgegevens via NVS

- De firmware leest per-apparaatinstellingen uit de NVS-partitie (`nvs.csv` in de repo's: nu `twomes_storage/mac_addresses`, de statische Bluetooth-adressen voor aanwezigheidsdetectie).
- De Cockpit laat de server een **NVS-image per apparaat** maken met Espressifs `esp-idf-nvs-partition-gen` (Python, Apache-2.0) en flasht dat mee op de NVS-offset. Daarmee kunnen per huishouden de Bluetooth-adressen en, na een kleine firmwarewijziging, de **serverhostnaam** en de campagne zonder herbouwen worden meegegeven.

### Stroom op het flashstation

```
1. "Apparaat aansluiten"  → Web Serial-poortkiezer → esptool-js: chip detecteren, MAC lezen
2. Cockpit zoekt MAC in de voorraad (nieuw → aanmaken; bekend → historie tonen, waarschuwen als nog toegewezen)
3. Apparaattype en firmwareversie kiezen (voorstel uit de campagne), NVS-image laten maken
4. Flashen (bootloader, partitietabel, otadata, app, NVS) met voortgangsbalk; daarna verify (MD5 per deel, door esptool-js)
5. Herstart en seriële console in de browser: wachten op de regel met QR-payload (naam + pop) → registreren
6. Label printen (QR van het apparaat + intern voorraadnummer); optioneel direct toewijzen aan een deelnemer
7. Retour: "Wissen" = volledig flash wissen + fabrieksfirmware, voorraadstatus terug, koppeling met account verbreken
```

### Optioneel: provisionen vanuit de browser

Met Web Bluetooth en `esp-idf-provisioning-web` kan de Cockpit een apparaat in het lab zelf op wifi zetten (security 1, de pop uit stap 5) om de hele keten te testen: activatie, upload, bewaking. Voor deelnemers blijft de app de weg.

### Alternatief overwogen: Improv Wi-Fi

ESP Web Tools ondersteunt Improv (wifi instellen via serieel of BLE na het flashen). Dat vraagt firmware-ondersteuning en dubbelt met ESP unified provisioning; daarom niet in fase 1.

### Voorwaarde: ESP-IDF-upgrade

Alle firmware draait nog op ESP-IDF 4.2 (2020, buiten ondersteuning). Voor een serieuze uitrol is de upgrade naar ESP-IDF 5.5 nodig; dat is een apart traject in de firmware-repo's (proefbouw: [generic-firmware#4](https://github.com/energiegedrag-nl/needforheat-generic-firmware/pull/4)).

## 7. Datamodel (uitbreiding)

```
inventory_device(id, mac, device_type_id, firmware_version, state, account_id NULL, label, created_at)
inventory_event(id, inventory_device_id, at, actor, event, details JSON)      -- flashen, toewijzen, verzenden, retour, wissen
campaign_state(campaign_id, state, changed_at)                                -- concept, loopt, sluit af, gesloten
account_state(account_id, state, invited_at, activated_at, stopped_at)       -- uitgenodigd, actief, gestopt
firmware_release(id, device_type_id, tag, sha256, manifest_path, published_at, channel)
firmware_rollout(id, release_id, campaign_id NULL, percentage, started_at)   -- fase 2
audit_log(id, at, actor, action, object, details JSON)                         -- fase 2
```

## 8. Beveiliging en privacy

- Cockpit en `/admin/*` alleen via LAN/VPN; nooit op het publieke API-pad.
- Geen persoonsgegevens in NeedForHeat (pseudoniemen); contactgegevens alleen in de [kluis](kluis.md) bij de beheerder, of in de wervings- of helpdesktool, met een eigen bewaartermijn.
- Firmware alleen flashen na SHA-256-controle tegen het manifest; manifest en binaries van dezelfde origin.
- Uitnodigingstokens en apparaattokens nooit loggen (zoals al bij de landingspagina).
- Tokenlevensduur en het intrekken van accounts horen bij fase 2.

## 9. Aanpak

| Stap | Wat | Omvang |
|---|---|---|
| 1 | Beheer-API (`/admin`, lezen/wijzigen/status) in de server-API, met tests | 1–2 weken |
| 2 | Cockpit-skelet: login met token, inrichting, deelnemers en uitnodigingen (QR, `mailto:`) | 1–2 weken |
| 3 | Bewaking per campagne en databron | 1 week |
| 4 | Flashstation: manifest, spiegel, Web Serial-flashen, voorraad | 2 weken |
| 5 | ESP-IDF 5.5 (parallel, apart traject in de firmware-repo's, met hardwaretests) | 3–6 weken |
| 6 | Fase 2 en 3 (OIDC, mail, eigen OTA, werving, helpdesk) | afstudeeropdracht(en) |

Stap 1–4 passen goed als afstudeeropdracht HBO-ICT (zoals oorspronkelijk bedacht); stap 5 als opdracht Embedded/Elektrotechniek.

## Bronnen

- [espressif/esptool-js](https://github.com/espressif/esptool-js) (Apache-2.0)
- [ESP Web Tools](https://github.com/esphome/esp-web-tools) (Apache-2.0)
- [esp-idf-provisioning-web](https://github.com/ho-229/esp-idf-provisioning-web) (MIT)
- [Web Serial in Chrome](https://developer.chrome.com/docs/capabilities/serial); [Intent to Ship: Web Serial API on Android](https://groups.google.com/a/chromium.org/g/blink-dev/c/HBJ-uYFvkpM/m/VzlWtw4rAAAJ); [Chrome 148 Beta voor Android](https://www.notebookcheck.net/Chrome-148-Beta-for-Android-adds-Web-Serial-SharedWorker-support.1269721.0.html)
- [ESP-IDF Unified Provisioning](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/provisioning/provisioning.html)
