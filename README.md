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

Pred nasadením aktuálnej verzie spustite v **Supabase → SQL Editor → New query** nepoužité migrácie v tomto poradí: [`20261010000100_employee_data_visibility.sql`](./supabase/migrations/20261010000100_employee_data_visibility.sql), [`20261010000200_employee_history_and_access.sql`](./supabase/migrations/20261010000200_employee_history_and_access.sql), [`20261010000300_attendance.sql`](./supabase/migrations/20261010000300_attendance.sql), [`20261010000400_work_orders.sql`](./supabase/migrations/20261010000400_work_orders.sql), [`20261010000500_work_order_reports_and_photos.sql`](./supabase/migrations/20261010000500_work_order_reports_and_photos.sql), [`20261010000600_reports_and_vehicle_trips.sql`](./supabase/migrations/20261010000600_reports_and_vehicle_trips.sql), [`20261010000700_bank_transfer_payments.sql`](./supabase/migrations/20261010000700_bank_transfer_payments.sql), [`20261010000800_work_entries_to_attendance.sql`](./supabase/migrations/20261010000800_work_entries_to_attendance.sql), [`20261010000900_resume_attendance_on_login.sql`](./supabase/migrations/20261010000900_resume_attendance_on_login.sql) a [`20261010001000_repair_vehicle_trip_rpc.sql`](./supabase/migrations/20261010001000_repair_vehicle_trip_rpc.sql). Každú migráciu spustite v danom Supabase projekte iba raz; spustite len tie, ktoré ste ešte nespustili. Opravnú migráciu 010 spustite po migrácii 006 aj v projekte, kde bola 006 už úspešne aplikovaná; znovu vytvorí funkciu `create_vehicle_trip` a obnoví cache API. Úvodnú schému znovu nespúšťajte.

Následne, ak ešte neboli spustené, aplikujte v poradí aj [`20261010001100_attendance_edits_and_multi_assignee_orders.sql`](./supabase/migrations/20261010001100_attendance_edits_and_multi_assignee_orders.sql), [`20261011000100_employee_work_orders_and_absences.sql`](./supabase/migrations/20261011000100_employee_work_orders_and_absences.sql), [`20261011001000_delete_attendance_shift.sql`](./supabase/migrations/20261011001000_delete_attendance_shift.sql), [`20261011002000_platform_admin_licensing.sql`](./supabase/migrations/20261011002000_platform_admin_licensing.sql), [`20261011003000_admin_delete_company.sql`](./supabase/migrations/20261011003000_admin_delete_company.sql), [`20261011004000_plan_limits_billing_attachments_trips.sql`](./supabase/migrations/20261011004000_plan_limits_billing_attachments_trips.sql), [`20261011220900_accountant_role.sql`](./supabase/migrations/20261011220900_accountant_role.sql), [`20261013000100_customers_and_work_order_details.sql`](./supabase/migrations/20261013000100_customers_and_work_order_details.sql), [`20261102000100_employee_types_join_requests_and_scheduling.sql`](./supabase/migrations/20261102000100_employee_types_join_requests_and_scheduling.sql), [`20261102000200_gopay_sandbox_test_payments.sql`](./supabase/migrations/20261102000200_gopay_sandbox_test_payments.sql), [`20261103000100_pro_trial_and_recurring_billing.sql`](./supabase/migrations/20261103000100_pro_trial_and_recurring_billing.sql) a napokon [`20261103000200_work_order_workflow.sql`](./supabase/migrations/20261103000200_work_order_workflow.sql). Každú spustite iba raz a až po jej predchádzajúcich migráciách.

Žiadosti používateľa o vstup do firmy posielajú vedeniu e-mail cez Supabase Edge Function. Po aplikovaní najnovšej migrácie nasaďte aktualizovanú funkciu príkazom `supabase functions deploy send-email`; konfigurácia `RESEND_API_KEY` musí byť v Supabase nastavená.

### GoPay sandbox – príprava na schválenie

GoPay testovací checkout používa iba oficiálne sandbox API `https://gw.sandbox.gopay.com/api/`; neodosiela reálne platby a nikdy neaktivuje platený plán. Sandbox požiadavka testuje mesačné opakovanie (prvá testovacia platba prebehne hneď, ďalšia podľa GoPay sandboxu). Pred zapnutím si vyžiadajte sandbox GoID, Client ID a Client Secret od GoPay integrácie (`integrace@gopay.cz`; [oficiálny postup integrácie](https://help.gopay.com/en/knowledge-base/integration-of-payment-gateway/integration-of-payment-gateway-1/how-do-i-integrate-the-payment-gateway)).

Po prijatí údajov:

1. Aplikujte migráciu `20261102000200_gopay_sandbox_test_payments.sql` iba raz.
2. V **Supabase → Project Settings → Edge Functions → Secrets** nastavte `GOPAY_GOID`, `GOPAY_CLIENT_ID` a `GOPAY_CLIENT_SECRET`. Nikdy ich nedávajte do `VITE_*`, frontendového kódu ani GitHub Pages variables. Supabase URL a service-role kľúč funkcia načíta zo serverového prostredia.
3. Nasaďte `supabase functions deploy gopay-test`.
4. Až po nastavení sandbox údajov a nasadení funkcie nastavte v **GitHub → Settings → Secrets and variables → Actions → Variables** `VITE_GOPAY_TEST_MODE=true` a spustite nový deploy. Predvolené `false` ponecháva testovací checkout vypnutý.
5. Prihláste sa ako vlastník firmy, v **Môj profil** zvoľte plán, zobrazte platobné údaje a otvorte **Testovať mesačné GoPay opakovanie**. Návrat z brány zobrazí overený stav; aj stav `PAID` zostáva iba testovacím záznamom a nemení licenciu.

Testovacie platby sa ukladajú oddelene od žiadostí bankového prevodu. Tabuľku môže čítať alebo meniť iba Edge Function cez serverový service-role kľúč; stav sa načíta z GoPay API, nie z parametrov vrátených prehliadačom. Produkčné GoPay URL ani zapnutie reálneho účtovania nie sú súčasťou tejto testovacej integrácie. GoPay musí najskôr prideliť údaje a schváliť obchodné miesto.

Vlastník môže každej firme aktivovať jednorazovú 30-dňovú skúšku Pro bez platobnej karty. Po uplynutí sa plán automaticky vráti na Free; skúška nespúšťa účtovanie. Expiráciu zabezpečuje databázová úloha cez `pg_cron`, ktorá sa spúšťa každých päť minút. Po skúške si firma môže samostatne objednať platený plán. Predplatné GoPay sa zatiaľ testuje iba v sandboxe; produkčné opakované platby nie sú aktívne a vyžadujú schválenie GoPay, produkčné údaje, dohodnutý proces zrušenia a dokončenie produkčnej integrácie.

Zamestnanci majú prístup iba k vlastným údajom; odobraté členstvá sa archivujú a vedúci si zachovajú históriu. Dochádzka eviduje zmeny a prestávky. Pri ukončení zmeny po 6 hodinách (po 4,5 hodine pri označenom mladistvom) sa interného zamestnanca bez zaznamenanej prestávky systém opýta na obed: odpoveď Áno odpočíta 30 minút, odpoveď Nie ponechá celý čas a pridá poznámku. Externý zamestnanec sa eviduje ako zamestnanec, ale toto automatické odpočítanie sa naňho nevzťahuje; externý účtovník bez práva zamestnanca si dochádzku neeviduje. Zamestnaný účtovník môže mať súčasne práva účtovníka aj zamestnanca. Pracovné záznamy sa zlúčili s kartou Dochádzka. Nový používateľ môže pri prvom prihlásení firmu založiť alebo vyhľadať a požiadať o členstvo; žiadosť sa odošle vedeniu e-mailom a vlastník/vedúci ju schváli alebo odstráni v časti Tím. Zákazky možno prideliť viacerým zamestnancom; zamestnanec ich môže prijať alebo odmietnuť a odmietnuté zákazky sa vlastníkovi/vedúcemu zobrazia na opätovné pridelenie. Zákazka má stavy Rozpracované, Zamerané, Pracuje sa a Dokončené. Obchodník po označení zákazky ako Zamerané ju nájde v podkarte Vybavené. Karta Zákazky zobrazuje role-relevantné podkarty, kalendár a kompaktný zoznam s filtrovaním podľa termínu alebo dátumu pridelenia; vytvorenie zákazky je v okne s dátumom a časom použiteľným aj na mobile. Po prijatí zákazky môže zamestnanec upraviť termín a čas. V prehľade sú jeho aktívne zákazky zoradené od najbližšieho termínu. Člen s právom **Zamestnanec** môže byť vrátane vlastníka zahrnutý do dochádzky, zákaziek a jázd. Právo **Obchodník** sprístupní vlastnú databázu zákazníkov; vlastník môže prepínať medzi databázami obchodníkov. Zákazníkov možno filtrovať, exportovať do Excel-kompatibilného CSV alebo vytlačiť/uložiť ako PDF. Pri vytvorení firmy sú fakturačný názov, IČO, DIČ a fakturačná adresa povinné. Aplikácia si zapamätá naposledy otvorenú kartu a firmu v tomto prehliadači; pri prepnutí na inú kartu alebo aplikáciu zostáva otvorený pracovný priestor zachovaný.

Návrhové ceny Basic 19 €, Pro 39 € a Team 69 € mesačne sú konečné sumy vrátane DPH 23 %; rozpis DPH: 19 € = 15,45 € + 3,55 €, 39 € = 31,71 € + 7,29 € a 69 € = 56,10 € + 12,90 €. Ide o návrh, nie o aktívnu ponuku na objednanie. Aktuálny bezplatný plán povoľuje najviac 2 aktívnych zamestnancov. Majiteľ môže vytvoriť žiadosť o bankový prevod a zobraziť lokálne vygenerovaný QR kód vo formáte SPAYD; pri platbe musí v bankovej aplikácii overiť údaje príjemcu, sumu a variabilný symbol. Záznam žiadosti je oddelený od stavu predplatného. Po overení pripísanej platby z výpisu účtu ju môže potvrdiť iba správca Workena priamo v Supabase SQL Editore, napríklad:

```sql
update public.payment_requests
set status = 'CONFIRMED', reviewed_at = now()
where variable_symbol = '<VARIABILNY_SYMBOL>'
  and status = 'PENDING';
```

Na zamietnutie sa použije rovnaký príkaz s `status = 'REJECTED'`. Klientská aplikácia nemá oprávnenie meniť stav žiadosti; potvrdenie prevodu samo osebe nemení plán ani oprávnenia firmy. Pred spustením skutočných platených plánov treba nakonfigurovať ich dostupné funkcie a aktiváciu. Bankové údaje a obsah QR sa generujú priamo v prehliadači a neposielajú sa QR službe tretej strany.

Návrh slovenských obchodných podmienok sa zobrazuje cez verejný odkaz **Obchodné podmienky**. Text je pracovný návrh a pred zverejnením alebo používaním ako záväznej zmluvy vyžaduje kontrolu slovenským advokátom; osobitne treba pripraviť zmluvu o spracúvaní osobných údajov a zaznamenanie súhlasu pri registrácii/objednávke.

Na verejnej stránke sú zobrazené identifikačné a kontaktné údaje, informácie o službe, cenové návrhy, obchodné podmienky a pracovný návrh zásad ochrany osobných údajov. Platené návrhové ceny 19 €, 39 € a 69 € sú konečné sumy s DPH 23 %, nejde však o aktívnu ponuku. IČ DPH prevádzkovateľa je SK1121595376. Právne/prevádzkové miesta označené v dokumentoch treba pred používaním doplniť a skontrolovať. GoPay sandbox checkout zostáva vypnutý, kým GoPay neposkytne testovacie údaje a nenasadí sa Supabase funkcia.

Dodané originálne GoPay, Mastercard, Visa a 3D Secure podklady sú v [`public/bannerr3D/`](./public/bannerr3D/). GoPay SVG a odvodené PNG logá GoPay/Mastercard sa zobrazujú na verejnej stránke; pôvodné AI/EPS vektorové súbory sú zachované a Visa/EPS podklady sú dostupné na stiahnutie. Sandbox checkout je pripravený v zdrojovom kóde, ale zostáva vypnutý do získania testovacích údajov a nasadenia funkcie. Produkčné GoPay platby nie sú aktívne; samotné zobrazenie loga neznamená, že je daná platobná metóda zapojená.

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
- RLS je zapnuté na aplikačných tabuľkách vrátane dochádzky a zákaziek. Členstvo, rola vlastníka/vedúceho a priradenie zákazky sa overujú v databázových politikách a funkciách, nie len v Reacte.
- Priame vkladanie alebo zmena členstiev nie sú povolené. Databázové funkcie kontrolujú oprávnenie pri založení firmy, pridaní/odstránení člena, schválení a opätovnom odoslaní záznamu.
- Buckety `work-photos` a `work-order-photos` sú súkromné. Storage politiky povoľujú prístup iba k cestám obsahujúcim správne ID firmy aj pracovného záznamu alebo priradenej zákazky; aplikácia obrázky zobrazuje cez časovo obmedzené podpísané URL.
- Neprihlásená rola `anon` nemá prístup k aplikačným tabuľkám ani k fotografiám.

## Kontrolný zoznam pred spustením

- [ ] SQL migrácia je úspešne spustená v Supabase.
- [ ] Google provider je zapnutý a callback URL presne zodpovedá Supabase projektu.
- [ ] Produkčné Vite premenné sú nastavené pred zostavením; kód neobsahuje `service_role` key.
- [ ] `npm run build` vytvoril `dist/index.html`, `dist/assets/` a `dist/.htaccess`.
- [ ] Obsah `dist/` vrátane skrytého `.htaccess` je nahratý do správneho webového adresára.
- [ ] HTTPS certifikát pokrýva produkčnú doménu a Supabase URL Configuration povoľuje túto adresu.
