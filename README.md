# Workena

Workena je statická jednostránková aplikácia v Reacte, TypeScripte a Vite. Prihlásenie, PostgreSQL a súkromné fotografické úložisko poskytuje Supabase; po zostavení beží aplikácia na bežnom webhostingu bez Node.js servera a bez lokálnej databázy.

## Požiadavky

- Node.js 20 alebo novší a npm iba na lokálny vývoj a zostavenie
- Supabase projekt
- Google OAuth 2.0 Web application klient
- Webglobe Start alebo iný Apache webhosting s podporou `.htaccess`

## 1. Vytvorenie Supabase projektu

1. V [Supabase Dashboard](https://supabase.com/dashboard) vytvorte projekt a počkajte, kým bude databáza dostupná.
2. Otvorte **SQL Editor → New query**, vložte celý obsah súboru [`supabase/migrations/202610090001_initial_schema.sql`](./supabase/migrations/202610090001_initial_schema.sql) a spustite ho ako vlastník projektu.
3. Migrácia vytvorí tabuľky `companies`, `memberships`, `work_entries` a `photos`, zapne RLS, pridá zabezpečené databázové funkcie a vytvorí súkromný Storage bucket `work-photos` s limitom 8 MiB na obrázok. SQL spustite iba raz; pri ďalších zmenách použite nové migračné súbory.
4. V **Project Settings → API** skopírujte Project URL a verejný **anon/publishable key**. Kľúč `service_role` do prehliadačovej aplikácie nikdy nekopírujte.

## 2. Google OAuth a Supabase Auth

1. V [Google Cloud Console](https://console.cloud.google.com/) vytvorte alebo vyberte projekt.
2. Nakonfigurujte **OAuth consent screen**. Ak je aplikácia v režime testovania, pridajte testovacie Google účty. Pre verejné prihlasovanie dokončite požiadavky na publikovanie aplikácie.
3. Vytvorte poverenie **OAuth client ID → Web application**.
4. Do poľa **Authorized redirect URIs** v Google klientovi zadajte presnú callback URL zo Supabase, pričom `<project-ref>` nahraďte referenciou svojho projektu: `https://<project-ref>.supabase.co/auth/v1/callback`. Táto URL nie je URL webhostingu.
5. V Supabase otvorte **Authentication → Providers → Google**, zapnite Google a vložte **Client ID** a **Client Secret** z Google. Tajný kľúč zostáva výhradne v nastavení Supabase.
6. V **Authentication → URL Configuration** nastavte **Site URL** na produkčnú adresu, napríklad `https://workena.eu`. Do **Redirect URLs** pridajte aj `https://workena.eu/**`; pri lokálnom vývoji pridajte `http://localhost:5173/**`.

Po prvom prihlásení cez Google môže vlastník vytvoriť firemný priestor. Vedúci môže pridávať zamestnancov a vlastník aj ďalších vedúcich podľa e-mailu. Pozvaný používateľ musí pred pridaním aspoň raz dokončiť Google prihlásenie; aplikácia zatiaľ neposiela pozvánkové e-maily.

## 3. Lokálny vývoj a zostavenie

1. Naklonujte repozitár a nainštalujte závislosti:

   ```sh
   npm install
   ```

2. Vytvorte lokálny `.env` zo vzorového súboru a vložte údaje svojho projektu:

   ```sh
   cp .env.example .env
   ```

   ```dotenv
   VITE_SUPABASE_URL=https://<project-ref>.supabase.co
   VITE_SUPABASE_ANON_KEY=<verejny-anon-alebo-publishable-kluc>
   ```

   `.env` je v `.gitignore` a nesmie sa commitovať. Vo Vite sú premenné s prefixom `VITE_` súčasťou klientského balíka: Supabase anon/publishable kľúč je verejný zámerne a jeho oprávnenia obmedzujú RLS politiky. Nikdy sem nevkladajte `service_role`, Google Client Secret ani databázové heslo.

3. Spustite vývojový server:

   ```sh
   npm run dev
   ```

4. Vytvorte produkčný balík:

   ```sh
   npm run build
   ```

   Výsledkom je samostatná statická stránka v `dist/`. Lokálna PostgreSQL, Prisma, Node.js server ani API backend sa pri jej prevádzke nepoužívajú. Node.js je potrebný len na zostavenie projektu.

## 4. Nasadenie cez GitHub Pages

Repozitár obsahuje workflow `.github/workflows/deploy.yml`, ktorý zostaví aplikáciu a publikuje `dist/` na GitHub Pages po každom pushi do vetvy `main`. Workflow sa dá spustiť aj ručne cez **GitHub → Actions → Deploy static site → Run workflow**.

Pred prvým nasadením:

1. V **GitHub → Settings → Secrets and variables → Actions → Variables** pridajte:
   - `VITE_SUPABASE_URL` — Project URL Supabase.
   - `VITE_SUPABASE_ANON_KEY` — verejný Supabase anon/publishable kľúč. Je určený pre prehliadač; nikdy sem nevkladajte `service_role`.
2. V **GitHub → Settings → Pages → Build and deployment** nastavte **Source** na **GitHub Actions**.
3. Súbor `public/CNAME` nastavuje vlastnú doménu `workena.eu`. V **Settings → Pages → Custom domain** overte rovnakú hodnotu.
4. V DNS správe domény nastavte apex A záznamy pre GitHub Pages na `185.199.108.153`, `185.199.109.153`, `185.199.110.153` a `185.199.111.153`. Odporúčané AAAA záznamy sú `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153` a `2606:50c0:8003::153`. Odstráňte konfliktné A/AAAA záznamy pre apex. Ak používate aj `www`, nastavte mu CNAME na `Romcloud.github.io`.
5. Vráťte sa do **Settings → Pages** a zapnite **Enforce HTTPS**, keď GitHub Pages vystaví certifikát pre doménu. V Supabase **Authentication → URL Configuration** povoľte `https://workena.eu/**`.
6. Po zlúčení zmien do `main` otvorte **Actions** a počkajte, kým prejdú kroky build aj deploy. Ak workflow zlyhá, otvorte jeho log; nasadenie zastane aj vtedy, keď GitHub Actions variables vyššie chýbajú.

Zostavený `dist/` neobsahuje `.env.local`; workflow vloží premenné pri zostavení. Publishable/anon kľúč je súčasťou verejného JavaScript balíka a bezpečnosť dát zaisťujú RLS politiky Supabase.

Pred nasadením aktuálnej verzie spustite v **Supabase → SQL Editor → New query** migrácie v tomto poradí: [`20261010000100_employee_data_visibility.sql`](./supabase/migrations/20261010000100_employee_data_visibility.sql), potom [`20261010000200_employee_history_and_access.sql`](./supabase/migrations/20261010000200_employee_history_and_access.sql). Ak ste už prvú migráciu spustili, spustite iba druhú. Každú migráciu spustite v danom Supabase projekte iba raz; úvodnú schému znovu nespúšťajte. Zamestnanci majú prístup iba k vlastným údajom; odobraté členstvá sa archivujú a vedúci si zachovajú históriu.

Bezplatný plán povoľuje najviac 2 aktívnych zamestnancov. Workena Pro je uvedená za 50 € ročne; online platby ani automatická aktivácia Pro zatiaľ nie sú zapnuté.

Vedúci môže mesačný prehľad vytlačiť alebo uložiť ako PDF cez **Vytlačiť / uložiť PDF** a následnú voľbu **Uložiť ako PDF** v dialógu tlače prehliadača.

Workenu možno pridať na plochu telefónu: v **Safari na iPhone/iPade** vyberte **Zdieľať → Pridať na plochu**, v **Chrome na Androide** otvorte ponuku a vyberte **Nainštalovať aplikáciu** alebo **Pridať na plochu**. Aplikácia používa samostatnú ikonu a zobrazí sa bez panela prehliadača. Offline sa načíta len statická aplikácia; prihlásenie a firemné údaje vyžadujú internet.

## 5. Nahratie na Webglobe Start

1. Pred zostavením skontrolujte, že `.env` obsahuje **produkčný** `VITE_SUPABASE_URL` a `VITE_SUPABASE_ANON_KEY`. Potom spustite `npm run build`. Zmena týchto hodnôt po zostavení vyžaduje nové zostavenie a nahratie.
2. V administrácii Webglobe priraďte k webhostingu doménu `workena.eu` a zapnite HTTPS/SSL certifikát pre doménu. Kým DNS alebo certifikát nie sú pripravené, stránka nemusí byť dostupná cez HTTPS.
3. Vo FTP/SFTP alebo Správcovi súborov otvorte koreňový **webový adresár priradený k doméne** v konfigurácii Webglobe.
4. Nahrajte **obsah priečinka `dist/`**, nie samotný priečinok. V koreňovom webovom adresári musí byť `index.html`, podadresár `assets/` a skrytý súbor `.htaccess`. Pri FTP zapnite zobrazenie skrytých súborov a overte, že `.htaccess` sa skutočne preniesol.
5. `.htaccess` presmeruje neexistujúce cesty jednostránkovej aplikácie na `index.html`; reálne súbory a adresáre ponechá bez zmeny. Vyžaduje Apache `mod_rewrite`.
6. V Supabase **Authentication → URL Configuration** skontrolujte, že produkčná doména zostala v Site URL aj Redirect URLs.
7. Otvorte `https://workena.eu`, prihláste sa Google účtom a založte firemný priestor. Funkčnosť dát a fotografií možno následne overiť v aplikácii aj v Supabase Dashboard.

## Ochrana firemných údajov

- Každý pracovný záznam aj fotografia sú naviazané na `company_id`; tabuľka fotografií má zároveň zložený cudzí kľúč, ktorý nedovolí priradiť fotografiu k záznamu inej firmy.
- RLS je zapnuté na všetkých štyroch aplikačných tabuľkách. Členstvo, rola vlastníka/vedúceho, autor záznamu a jeho stav sa overujú v databázových politikách, nie len v Reacte.
- Priame vkladanie alebo zmena členstiev nie sú povolené. Databázové funkcie kontrolujú oprávnenie pri založení firmy, pridaní/odstránení člena, schválení a opätovnom odoslaní záznamu.
- Bucket `work-photos` je súkromný. Storage politiky povoľujú prístup iba k cestám obsahujúcim správne ID firmy aj pracovného záznamu; aplikácia obrázky zobrazuje cez časovo obmedzené podpísané URL.
- Neprihlásená rola `anon` nemá prístup k aplikačným tabuľkám ani k fotografiám.

## Kontrolný zoznam pred spustením

- [ ] SQL migrácia je úspešne spustená v Supabase.
- [ ] Google provider je zapnutý a callback URL presne zodpovedá Supabase projektu.
- [ ] Produkčné Vite premenné sú nastavené pred zostavením; kód neobsahuje `service_role` key.
- [ ] `npm run build` vytvoril `dist/index.html`, `dist/assets/` a `dist/.htaccess`.
- [ ] Obsah `dist/` vrátane skrytého `.htaccess` je nahratý do správneho webového adresára.
- [ ] HTTPS certifikát pokrýva produkčnú doménu a Supabase URL Configuration povoľuje túto adresu.
