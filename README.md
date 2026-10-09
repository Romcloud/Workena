# Workena

Responzívna evidencia práce pre nezávislé firmy. Projekt používa Next.js App Router, TypeScript, PostgreSQL a Prisma. Každá chránená operácia načíta členstvo zo serverovej relácie a všetky firemné dáta obmedzuje identifikátorom firmy získaným z databázy — klient neposiela dôveryhodné ID firmy.

## Požiadavky

- Node.js 20 alebo novší a npm
- PostgreSQL 14 alebo novší
- Google OAuth klient
- S3-kompatibilné súkromné objektové úložisko (napr. AWS S3 alebo lokálny MinIO)

## Lokálny vývoj

1. Nainštalujte závislosti: `npm install`
2. Skopírujte `.env.example` do `.env` a doplňte lokálne údaje. `.env` sa nesmie commitovať.
3. Spustite Docker Desktop a v koreňovom adresári projektu spustite PostgreSQL kontajner:

   ```sh
   docker compose up -d db
   ```

   Ak terminál vypíše `docker: command not found`, na macOS použite Docker CLI priamo z Docker Desktop:

   ```sh
   PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH" docker compose up -d db
   ```

   Compose vytvorí lokálnu databázu `workena` na `localhost:5432`. V `.env` nastavte:

   ```dotenv
   DATABASE_URL="postgresql://workena:workena_local_only@localhost:5432/workena?schema=public"
   ```

   Používateľ a heslo v `compose.yaml` sú určené výhradne na lokálny vývoj. Dáta pretrvajú reštart kontajnera v Docker volume `workena_postgres_data`.
4. V Google Cloud Console vytvorte OAuth 2.0 Web klienta. Nastavte autorizovaný redirect URI na `http://localhost:3000/api/auth/callback/google`; jeho Client ID a Client Secret vložte do `AUTH_GOOGLE_ID` a `AUTH_GOOGLE_SECRET`.
5. Vygenerujte `AUTH_SECRET`, napríklad príkazom `openssl rand -base64 32`. Pri produkcii nastavte verejnú `AUTH_URL` na HTTPS adresu aplikácie.
6. Nastavte S3 bucket, región a prístupové údaje v `S3_*`. Bucket musí zostať súkromný; prístup k fotografiám aplikácia poskytuje cez autorizovaný endpoint.
7. Aplikujte pripravenú počiatočnú migráciu a spustite vývojový server:

   ```sh
   npm run db:migrate
   npm run dev
   ```

8. Otvorte `http://localhost:3000`, prihláste sa Google účtom a založte firemný priestor.

Docker Desktop je databázový kontajner, nie poskytovateľ Google OAuth. Chyba Google `invalid_client` znamená, že `AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET` nie sú platné: vytvorte OAuth klienta v Google Cloud Console, nastavte presný callback URI uvedený vyššie a reštartujte `npm run dev` po zmene `.env`. Predtým nastavené lokálne zástupné údaje na prihlásenie nefungujú.

Zastavenie databázy bez odstránenia dát: `docker compose stop db`. Zastavenie a odstránenie kontajnera bez odstránenia dát: `docker compose down`. Odstránenie databázových dát je samostatná deštruktívna operácia: `docker compose down -v`.

Na naplnenie lokálnej databázy ukážkovými záznamami spustite:

```sh
SEED_DEMO_DATA=true npm run db:seed
```

Seed beží iba pri explicitnom povolení, mimo produkcie a ak `DATABASE_URL` smeruje na `localhost`. Vytvorí ukážkovú firmu, vlastníka, zamestnanca a záznamy v stavoch čaká na schválenie/schválené/vrátené. Účty s adresami `*.invalid` sú iba testovacie dáta a nemožno sa nimi prihlásiť cez Google.

Voliteľne možno nastaviť `GOOGLE_WORKSPACE_DOMAIN`; vtedy sa prihlásia iba účty overené Googlom, ktoré patria do uvedenej Workspace domény. Bez tejto premennej sa dá prihlásiť Google účtom a obmedzenie domény nastavuje vlastník zvlášť pre danú firmu.

## Pozvánky a roly

Vlastník alebo vedúci môže vytvoriť e-mailovú pozvánku. Jej náhodný token sa ukladá iba ako SHA-256 hash a odkaz platí sedem dní. Prístup sa udelí až prihlásenému Google účtu s rovnakou e-mailovou adresou. Vlastník môže pozývať vedúcich; vedúci iba zamestnancov. Základný model priraďuje jeden používateľský účet do jednej firmy.

## Fotografie

Podporované sú JPEG, PNG a WebP do limitu `UPLOAD_MAX_BYTES` (predvolene 8 MiB, maximálne 25 MiB); na jeden záznam možno pridať najviac 10 fotografií. Server overuje MIME typ aj signatúru súboru. Obsah sa ukladá do S3-kompatibilného úložiska, v databáze je iba metadátový záznam. Kľúče sú oddelené podľa firmy/záznamu; čítanie prechádza autentifikovaným endpointom a kontrolou členstva. Endpoint predpokladá S3 API `PutObject`/`GetObject`/`DeleteObject` a podporuje vlastný `S3_ENDPOINT` aj `S3_FORCE_PATH_STYLE=true` (napr. MinIO).

## Migrácie a produkčné nasadenie

- Lokálne nové migrácie: `npm run db:migrate`
- Produkčné migrácie: `npm run db:deploy`
- Produkčné zostavenie: `npm run build`
- Spustenie: `npm start`

Repozitár obsahuje počiatočnú schému a migráciu poznámky vedúceho pri vrátenom zázname v `prisma/migrations`. Pri každej ďalšej zmene `prisma/schema.prisma` vytvorte a skontrolujte migráciu lokálne, commitnite migráciu spolu so zmenou schémy a pri nasadení aplikujte iba `npm run db:deploy`. Produkčné prostredie nikdy neinicializujte cez `prisma migrate dev` ani seed skriptom.

Pred nasadením skopírujte `.env.production.example` do správcu tajomstiev hostingovej platformy (nie do repozitára) a doplňte hodnoty:

- PostgreSQL s TLS; `DATABASE_URL` nesmie byť dostupná v klientskom kóde.
- `AUTH_URL=https://workena.eu` a silný `AUTH_SECRET`, napr. výstup `openssl rand -base64 32`.
- Google OAuth Web klient s presným callbackom `https://workena.eu/api/auth/callback/google`; povoľte len požadované domény/účty cez `GOOGLE_WORKSPACE_DOMAIN`, ak je to potrebné.
- Súkromný S3 bucket. Na AWS použite IAM/workload rolu; pri inom poskytovateľovi nastavte oba S3 kľúče. Dajte aplikácii iba potrebné oprávnenia `GetObject`, `PutObject` a `DeleteObject`; nikdy nezverejňujte bucket.
- HTTPS terminácia a dôveryhodná konfigurácia proxy/hostingu. Nastavte limity, zálohy a obnovu databázy podľa prevádzkových požiadaviek.

Pri nasadení vykonajte v poradí `npm run db:deploy`, `npm run build` a `npm start` (alebo ekvivalentné kroky platformy). Pred produkčným použitím doplňte e-mailovú službu na doručovanie pozvánok; zatiaľ sa odkaz po vytvorení zobrazí vlastníkovi/vedúcemu, ktorý ho distribuuje bezpečným kanálom.

## Rozšíriteľnosť

`EntryStatus` a polia `reviewedAt`/`reviewedById` podporujú schvaľovanie a vrátenie záznamu na opravu; zamestnanec môže vrátený záznam upraviť a znova odoslať.

## Bezpečnostné poznámky

- Firemné ID v serverových operáciách pochádza iba z overeného členstva, nie z formulára.
- Záznamy zamestnanca sú vždy obmedzené na jeho vlastné záznamy; správa tímu vyžaduje rolu vlastníka/vedúceho.
- Pozvánky majú expiráciu, jednorazové prijatie a kontrolu e-mailu/domény.
- Upload kontroluje pôvod požiadavky, prístup k záznamu, veľkosť, typ a signatúru súboru.
- Citlivé hodnoty sú iba v premenných prostredia; chybové odpovede nevracajú tajomstvá poskytovateľa.
