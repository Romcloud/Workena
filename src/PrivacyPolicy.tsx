import { ArrowLeft } from "lucide-react";

type PrivacyPolicyProps = {
  onBack: () => void;
};

export function PrivacyPolicy({ onBack }: PrivacyPolicyProps) {
  return (
    <main className="terms-page">
      <header className="terms-header">
        <button className="back-link button-quiet" onClick={onBack}><ArrowLeft size={15} /> Späť na Workenu</button>
        <span className="eyebrow">WORKENA · INFORMÁCIE O SPRACÚVANÍ ÚDAJOV</span>
        <h1>Ochrana osobných údajov</h1>
        <p>Informácie o spracúvaní osobných údajov pri používaní webovej stránky a aplikácie Workena.</p>
      </header>
      <article className="terms-content">
        <section>
          <h2>1. Prevádzkovateľ</h2>
          <p>Prevádzkovateľom webovej stránky <strong>workena.eu</strong> a prevádzkovateľom osobných údajov v rozsahu uvedenom nižšie je:</p>
          <address>
            <strong>Roman Chlebovec – ROVOLT</strong><br />
            IČO: 57875189<br />
            DIČ: 1121595376<br />
            IČ DPH: SK1121595376<br />
            Adresa: MPČĽ 3053/11, 058 01 Poprad, Slovensko<br />
            E-mail: <a href="mailto:info@rovolt.sk">info@rovolt.sk</a><br />
            Telefón: <a href="tel:+421904826557">0904 826 557</a>
          </address>
          <p>Otázky o spracúvaní osobných údajov a žiadosti týkajúce sa vašich práv nám môžete poslať na <a href="mailto:info@rovolt.sk">info@rovolt.sk</a> alebo poštou na uvedenú adresu.</p>
        </section>
        <section>
          <h2>2. Aké údaje spracúvame a prečo</h2>
          <p>Pri používaní Workeny spracúvame podľa využitých funkcií najmä:</p>
          <ul>
            <li>meno a priezvisko, e-mail, identifikátor účtu a údaje od poskytovateľa prihlásenia Google;</li>
            <li>údaje o firme a fakturácii, členstve, pracovnej roli a oprávneniach;</li>
            <li>dochádzku, prestávky, pracovné záznamy, neprítomnosti, zákazky, fotografie, prílohy a záznamy jázd;</li>
            <li>údaje o zákazníkoch, kontaktné údaje, dopyty a približné ceny, ktoré do aplikácie vloží používateľ;</li>
            <li>údaje potrebné na vybavenie otázky, žiadosti o licenciu, platobnej požiadavky alebo reklamácie služby;</li>
            <li>pri zapnutom GoPay sandboxe testovacie číslo objednávky, identifikátor platby, zvolený balík, sumu a stav platby.</li>
          </ul>
          <p>Údaje používame na správu účtu a firemného priestoru, poskytovanie funkcií aplikácie, komunikáciu, vybavenie požiadaviek a plnenie právnych povinností. Workena je digitálna služba; fyzické doručovanie tovaru sa cez aplikáciu neuskutočňuje.</p>
          <p>Pri testovacej platbe cez GoPay zadávate platobné údaje priamo v prostredí GoPay. Workena údaje platobnej karty nezískava ani neukladá. Testovací checkout sa používa iba po zapnutí GoPay sandboxu; testovacia platba nevytvorí ostrú objednávku ani neaktivuje platený plán.</p>
          <p>Do pracovných záznamov môžu používatelia vložiť osobné údaje svojich zamestnancov a zákazníkov. V rozsahu týchto firemných údajov určuje účel a prostriedky spracúvania príslušná firma ako prevádzkovateľ; poskytovateľ Workeny ich spracúva podľa pokynov firmy. Firma zodpovedá za poskytnutie informácií dotknutým osobám a za svoj právny základ spracúvania.</p>
        </section>
        <section>
          <h2>3. Právny základ spracúvania</h2>
          <p>Podľa okolností spracúvame údaje na týchto právnych základoch:</p>
          <ul>
            <li>plnenie zmluvy a vykonanie opatrení pred jej uzatvorením, napríklad správa účtu a poskytovanie objednanej služby;</li>
            <li>plnenie zákonných povinností, najmä vedenie a uchovávanie účtovných a daňových dokladov;</li>
            <li>oprávnený záujem, napríklad zabezpečenie a ochrana webovej stránky alebo uplatňovanie a obhajoba právnych nárokov;</li>
            <li>súhlas, ak je potrebný, napríklad pri nepovinných cookies alebo zasielaní marketingových oznámení.</li>
          </ul>
          <p>Ak spracúvanie vychádza zo súhlasu, môžete ho kedykoľvek odvolať. Odvolanie nemá vplyv na zákonnosť spracúvania pred jeho odvolaním. Pri údajoch zamestnancov a zákazníkov vložených firmou určuje právny základ spracúvania táto firma.</p>
        </section>
        <section>
          <h2>4. Príjemcovia údajov</h2>
          <p>Údaje sprístupňujeme iba v rozsahu potrebnom na príslušný účel. Môžu ich spracúvať poskytovatelia technickej prevádzky a hostingu webu, Supabase (autentifikácia, databáza a úložisko), Google (prihlásenie), Resend (transakčné e-maily), OpenStreetMap Nominatim a OSRM (vyhľadávanie adries a výpočet trás) a GoPay pri zapnutom testovacom platobnom toku. Údaje môžeme poskytnúť účtovníkovi alebo orgánom verejnej moci, ak to vyžaduje zákon. Webová stránka je publikovaná cez GitHub Pages.</p>
          <p>Pri vyhľadávaní adresy alebo výpočte trasy sa príslušné adresy odosielajú použitým mapovým službám. Pri GoPay platbe sa platobné údaje zadávajú a spracúvajú v prostredí GoPay podľa jeho vlastných zásad ochrany osobných údajov.</p>
          <p className="legal-placeholder">[Pred spustením produkčných platieb overiť aktuálne sprostredkovateľské zmluvy, umiestnenie a prenosy údajov, subdodávateľov a podmienky GoPay. Pri spracúvaní údajov zamestnancov a zákazníkov firmy uzavrieť potrebnú zmluvu o spracúvaní osobných údajov.]</p>
        </section>
        <section>
          <h2>5. Doba uchovávania</h2>
          <p>Údaje o objednávkach a účtovné doklady uchovávame po dobu vyžadovanú právnymi predpismi. Účtovné doklady sa spravidla uchovávajú desať rokov nasledujúcich po roku, ktorého sa týkajú, podľa <a href="https://www.slov-lex.sk/ezbierky/pravne-predpisy/SK/ZZ/2002/431/20260601" target="_blank" rel="noreferrer">§ 35 zákona o účtovníctve</a>.</p>
          <p>Údaje z bežnej komunikácie a podpory uchovávame po dobu potrebnú na vybavenie požiadavky a následne len v rozsahu potrebnom na ochranu právnych nárokov alebo splnenie zákonnej povinnosti. Údaje spracúvané na základe súhlasu uchovávame do jeho odvolania alebo do naplnenia účelu, podľa toho, čo nastane skôr.</p>
          <p className="legal-placeholder">[Doplniť konkrétne lehoty uchovávania účtov, pracovných záznamov, zákazníckych údajov, testovacích platieb a prevádzkových záznamov a postup ich výmazu.]</p>
        </section>
        <section>
          <h2>6. Cookies a technické údaje</h2>
          <p>Workena používa technické úložisko prehliadača na prihlasovaciu reláciu a vybrané nastavenia pracovného priestoru. Aplikácia aktuálne nepoužíva analytické ani reklamné nástroje; ak sa doplnia, ich poskytovatelia, účely a doba platnosti sa uvedú v informáciách o cookies a nepovinné cookies sa budú používať podľa vašej voľby.</p>
        </section>
        <section>
          <h2>7. Vaše práva</h2>
          <p>V prípadoch stanovených právnymi predpismi máte právo požiadať o prístup k svojim údajom, ich opravu, vymazanie alebo obmedzenie spracúvania. Máte tiež právo namietať proti spracúvaniu založenému na oprávnenom záujme, právo na prenosnosť údajov, ak sú splnené zákonné podmienky, a právo odvolať súhlas.</p>
          <p>Žiadosť môžete poslať na <a href="mailto:info@rovolt.sk">info@rovolt.sk</a>. Máte tiež právo podať sťažnosť na <strong>Úrad na ochranu osobných údajov Slovenskej republiky</strong>; kontaktné informácie sú na <a href="https://dataprotection.gov.sk/sk/kontakt/" target="_blank" rel="noreferrer">dataprotection.gov.sk</a>.</p>
        </section>
        <section>
          <h2>8. Automatizované rozhodovanie</h2>
          <p>Nevykonávame automatizované individuálne rozhodovanie ani profilovanie s právnymi alebo podobne významnými účinkami.</p>
        </section>
        <section>
          <h2>9. Zmeny a kontakt</h2>
          <p>Aktuálne znenie týchto informácií zverejňujeme na webovej stránke <strong>workena.eu</strong>. Ak sa zmení spôsob spracúvania osobných údajov, tieto informácie aktualizujeme.</p>
          <p>Otázky o ochrane osobných údajov a žiadosti týkajúce sa vašich práv: <a href="mailto:info@rovolt.sk">info@rovolt.sk</a> alebo Roman Chlebovec – ROVOLT, MPČĽ 3053/11, 058 01 Poprad, Slovensko; telefón <a href="tel:+421904826557">0904 826 557</a>.</p>
          <p><strong>Dátum aktualizácie: 2. novembra 2026</strong></p>
        </section>
      </article>
      <footer className="terms-footer">
        <button className="back-link button-quiet" onClick={onBack}><ArrowLeft size={15} /> Späť na Workenu</button>
        <a href="#obchodne-podmienky">Obchodné podmienky</a>
      </footer>
    </main>
  );
}
