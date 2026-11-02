import { ArrowLeft } from "lucide-react";

type PrivacyPolicyProps = {
  onBack: () => void;
};

export function PrivacyPolicy({ onBack }: PrivacyPolicyProps) {
  return (
    <main className="terms-page">
      <header className="terms-header">
        <button className="back-link button-quiet" onClick={onBack}><ArrowLeft size={15} /> Späť na Workenu</button>
        <span className="eyebrow">WORKENA · NÁVRH NA DOPLNENIE A PRÁVNU KONTROLU</span>
        <h1>Ochrana osobných údajov</h1>
        <p>Pred zverejnením treba doplniť označené informácie a overiť právne základy, lehoty a sprostredkovateľov.</p>
      </header>
      <article className="terms-content">
        <section>
          <h2>1. Prevádzkovateľ</h2>
          <address>
            Roman Chlebovec — obchodné označenie ROVOLT<br />
            IČO: 57875189 · DIČ: 1121595376<br />
            IČ DPH: [DOPLNIŤ CELÉ IČ DPH]<br />
            MPČĽ 3053/11, 058 01 Poprad, Slovensko<br />
            E-mail: <a href="mailto:info@rovolt.sk">info@rovolt.sk</a><br />
            Telefón: <a href="tel:+421904826557">0904 826 557</a>
          </address>
        </section>
        <section>
          <h2>2. Aké údaje Workena spracúva</h2>
          <p>Podľa použitých funkcií aplikácia môže obsahovať:</p>
          <ul>
            <li>identifikačné a prihlasovacie údaje účtu, napríklad meno, e-mail a identifikátor od poskytovateľa prihlásenia Google;</li>
            <li>firemné a fakturačné údaje a údaje o členstve, pracovnej roli a oprávneniach;</li>
            <li>pracovné záznamy, dochádzku, prestávky, neprítomnosti, zákazky, pracovné výkazy, fotografie a prílohy;</li>
            <li>údaje o zákazníkoch, kontaktné údaje, dopyty a približné ceny vložené používateľom;</li>
            <li>údaje o jazdách a adresách použité pri výpočte trasy;</li>
            <li>údaje o žiadostiach na licenciu, napríklad zvolený balík, suma a variabilný symbol. Aplikácia v súčasnosti nespracúva údaje o platobnej karte cez GoPay.</li>
          </ul>
          <p>Do pracovných záznamov môžu používatelia vložiť osobné údaje ďalších osôb. Prevádzkovateľ firmy musí týmto osobám poskytnúť vlastné informácie o spracúvaní.</p>
        </section>
        <section>
          <h2>3. Účely použitia</h2>
          <p>Údaje sa používajú na prihlásenie a správu účtu, prevádzku firemných priestorov a ich funkcií, evidenciu dochádzky a pracovných záznamov, zákazky a kontakty, reporty, jazdy, vybavenie žiadostí o licenciu, zasielanie prevádzkových e-mailov a podporu používateľov.</p>
        </section>
        <section>
          <h2>4. Právne základy a doby uchovávania</h2>
          <p className="legal-placeholder">[DOPLNIŤ právny základ pre každý účel spracúvania vrátane rozlíšenia medzi prevádzkovateľom Workena a firmou, ktorá vkladá údaje svojich zamestnancov a zákazníkov.]</p>
          <p className="legal-placeholder">[DOPLNIŤ konkrétne lehoty uchovávania jednotlivých kategórií údajov a postup ich výmazu.]</p>
        </section>
        <section>
          <h2>5. Poskytovatelia služieb a príjemcovia</h2>
          <p>Aplikácia používa Supabase na autentifikáciu, databázu a úložisko; Google na prihlásenie; Resend na transakčné e-maily; a služby OpenStreetMap Nominatim a OSRM pri vyhľadávaní adries a výpočte trás. Webová stránka je publikovaná cez GitHub Pages.</p>
          <p className="legal-placeholder">[OVERIŤ aktuálne sprostredkovateľské zmluvy, umiestnenie a prenosy údajov, subdodávateľov a lehoty uchovávania u každého poskytovateľa. Pri výpočte trasy sa príslušné adresy odosielajú mapovým službám.]</p>
        </section>
        <section>
          <h2>6. Práva dotknutých osôb</h2>
          <p>Žiadosť týkajúcu sa osobných údajov možno poslať na <a href="mailto:info@rovolt.sk">info@rovolt.sk</a>. Dotknutá osoba môže podľa okolností a platných právnych predpisov uplatniť právo na prístup, opravu, vymazanie, obmedzenie spracúvania, námietku, prenosnosť alebo odvolanie súhlasu; môže sa tiež obrátiť na Úrad na ochranu osobných údajov Slovenskej republiky.</p>
          <p className="legal-placeholder">[DOPLNIŤ postup overenia totožnosti žiadateľa a kontaktné údaje dozorného orgánu; právne overiť použiteľnosť jednotlivých práv podľa účelu a roly prevádzkovateľa.]</p>
        </section>
        <section>
          <h2>7. Zabezpečenie a úložisko v prehliadači</h2>
          <p>Workena využíva prihlásenie cez Google a ukladá prihlasovaciu reláciu a vybrané nastavenia pracovného priestoru v prehliadači. Konkrétne technické a organizačné bezpečnostné opatrenia a doby uchovávania lokálnych údajov treba doplniť pred právnym schválením.</p>
          <p className="legal-placeholder">[DOPLNIŤ informácie o cookies a ďalších technológiách úložiska, ak sa používajú, a o tom, či web používa analytiku alebo marketingové nástroje.]</p>
        </section>
        <section>
          <h2>8. Kontakt</h2>
          <p>Otázky k ochrane osobných údajov: <a href="mailto:info@rovolt.sk">info@rovolt.sk</a>, telefón <a href="tel:+421904826557">0904 826 557</a>.</p>
        </section>
      </article>
      <footer className="terms-footer">
        <button className="back-link button-quiet" onClick={onBack}><ArrowLeft size={15} /> Späť na Workenu</button>
        <a href="#obchodne-podmienky">Obchodné podmienky</a>
      </footer>
    </main>
  );
}
