import { ArrowLeft } from "lucide-react";

type TermsOfServiceProps = {
  onBack: () => void;
};

export function TermsOfService({ onBack }: TermsOfServiceProps) {
  return (
    <main className="terms-page">
      <header className="terms-header">
        <button className="back-link button-quiet" onClick={onBack}><ArrowLeft size={15} /> Späť na Workenu</button>
        <span className="eyebrow">WORKENA · NÁVRH NA PRÁVNU KONTROLU</span>
        <h1>Obchodné podmienky</h1>
        <p>Verzia návrhu: 10. októbra 2026</p>
      </header>
      <div className="terms-draft-notice" role="note">
        Tento text je pracovný návrh, nie právne stanovisko ani záruka maximálnej ochrany. Pred zverejnením ho dajte skontrolovať slovenskému advokátovi, najmä pravidlá predplatného, spotrebiteľské práva, ochranu údajov a zodpovednosť.
      </div>
      <article className="terms-content">
        <section>
          <h2>1. Prevádzkovateľ</h2>
          <p>Poskytovateľom služby Workena (ďalej len „Poskytovateľ“) je:</p>
          <address>
            Roman Chlebovec - ROVOLT<br />
            IČO: 57875189<br />
            Miesto podnikania: MPČĽ 3053/11, 058 01 Poprad, Slovenská republika<br />
            Zápis: Okresný úrad Poprad, číslo živnostenského registra 740-47346<br />
            E-mail: <a href="mailto:info@rovolt.sk">info@rovolt.sk</a>
          </address>
        </section>
        <section>
          <h2>2. Rozsah podmienok a služba</h2>
          <p>
            Tieto podmienky upravujú používanie webovej aplikácie Workena a súvisiacich funkcií na evidenciu pracovných záznamov, dochádzky, zákaziek, fotografií, jázd a reportov. Konkrétne funkcie, dostupnosť, cena, fakturačné obdobie a spôsob platby sa určujú podľa aktuálnej ponuky zobrazenej pri objednávke.
          </p>
          <p>
            Pred zverejnením treba zabezpečiť, aby používateľ tieto podmienky dostal pred registráciou alebo objednávkou a aby sa jeho súhlas zaznamenal; samotné umiestnenie odkazu na stránke nemusí preukazovať uzavretie zmluvy. Ak používateľ koná za firmu, musí byť oprávnený konať v jej mene; zmluvnou stranou je v takom prípade firma. Ak používateľ koná ako spotrebiteľ, jeho kogentné zákonné práva zostávajú zachované.
          </p>
        </section>
        <section>
          <h2>3. Účet a oprávnenia používateľov</h2>
          <ul>
            <li>Používateľ uvedie pravdivé a aktuálne údaje a chráni prihlasovacie údaje pred zneužitím.</li>
            <li>Majiteľ firmy zodpovedá za správne nastavenie členov, rolí a prístupov vo firemnom priestore a za včasné odobratie prístupov osobám, ktoré ich už nemajú mať.</li>
            <li>Používateľ nesmie obchádzať prístupové obmedzenia, zasahovať do služby, narúšať jej bezpečnosť ani ju používať v rozpore s právnymi predpismi alebo právami tretích osôb.</li>
            <li>Poskytovateľ môže primerane obmedziť účet pri dôvodnom bezpečnostnom riziku alebo závažnom porušení podmienok; ak je to možné, používateľa vopred informuje a umožní nápravu.</li>
          </ul>
        </section>
        <section>
          <h2>4. Firemné údaje a ochrana súkromia</h2>
          <p>
            Firma si ponecháva práva k údajom a obsahu, ktoré do Workeny vloží. Firma zodpovedá za to, že má právny základ na ich vloženie a spracúvanie vrátane údajov zamestnancov, fotografií a údajov o polohe alebo jazdách, a že dotknutým osobám poskytla potrebné informácie.
          </p>
          <p>
            Ak Poskytovateľ spracúva osobné údaje v mene firmy, strany musia pred takým spracúvaním uzavrieť zmluvu o spracúvaní osobných údajov podľa článku 28 GDPR. Tieto obchodné podmienky takú zmluvu ani informačnú povinnosť firmy voči zamestnancom nenahrádzajú. Podrobnosti o spracúvaní Poskytovateľom musia byť uvedené v samostatných zásadách ochrany osobných údajov.
          </p>
          <p>
            Používateľ nahráva iba obsah, ktorý je oprávnený používať. Poskytovateľ môže odstrániť obsah, ktorého uchovávanie je podľa zákona zakázané alebo ktorý predstavuje odôvodnené bezpečnostné riziko, a podľa okolností o tom informuje firmu.
          </p>
        </section>
        <section>
          <h2>5. Dostupnosť a zmeny služby</h2>
          <p>
            Poskytovateľ vyvíja službu s primeranou odbornou starostlivosťou. Nepretržitá dostupnosť, bezchybnosť ani konkrétne výsledky používania nie sú zaručené, pokiaľ nie sú výslovne dohodnuté. Funkcie môžu vyžadovať internet, kompatibilný prehliadač alebo služby tretích strán. Plánovanú údržbu a podstatné zmeny sa Poskytovateľ pokúsi oznámiť primerane vopred.
          </p>
          <p>
            Firma zodpovedá za vlastné exporty a uchovanie kópií údajov, ktoré potrebuje. Pred zrušením účtu alebo priestoru má využiť dostupné exporty. Konkrétne lehoty uchovávania a výmazu údajov musia byť uvedené v zásadách ochrany osobných údajov a zmluve o spracúvaní.
          </p>
        </section>
        <section>
          <h2>6. Balíky, cena a platby</h2>
          <p>
            Balík, jeho funkcie, cena, mena, dĺžka obdobia a prípadné dane sa riadia údajmi zobrazenými v záväznej objednávke pred jej potvrdením. Návrhové alebo testovacie ceny nie sú ponukou, kým ich Poskytovateľ výslovne neoznačí ako dostupné na objednanie.
          </p>
          <p>
            Platba je splatná spôsobom a v lehote uvedenými pri objednávke. Samotné zobrazenie platobných údajov, vytvorenie QR kódu alebo odoslanie potvrdenia používateľom neznamená prijatie platby ani aktiváciu plateného balíka. Aktivácia nastane až po potvrdení platby Poskytovateľom alebo platobnou bránou podľa zobrazeného procesu.
          </p>
          <p>
            Opakované predplatné a automatické obnovovanie vzniknú iba vtedy, ak sú pred dokončením objednávky jasne uvedené obdobie, cena, pravidlá obnovy a spôsob ukončenia a používateľ s nimi výslovne súhlasí. Zmenu ceny alebo podstatných vlastností aktívneho predplatného Poskytovateľ oznámi vopred; práva zákazníka ukončiť zmluvu podľa zákona zostávajú zachované.
          </p>
        </section>
        <section>
          <h2>7. Ukončenie používania</h2>
          <p>
            Používateľ môže prestať službu používať a požiadať o zrušenie účtu e-mailom na <a href="mailto:info@rovolt.sk">info@rovolt.sk</a>. Pri platenom predplatnom sa uplatní spôsob ukončenia a fakturačné obdobie oznámené pri objednávke; ukončením sa neobchádzajú zákonné práva na odstúpenie alebo výpoveď.
          </p>
          <p>
            Poskytovateľ môže ukončiť službu alebo zmluvu z vážneho dôvodu, najmä pri závažnom alebo opakovanom porušovaní podmienok, nezákonnom používaní alebo ukončení prevádzky služby. Ak je to možné, poskytne predtým oznámenie a primeranú lehotu na nápravu. Vyporiadanie zaplatených súm sa riadi objednávkou a príslušnými právnymi predpismi.
          </p>
        </section>
        <section>
          <h2>8. Duševné vlastníctvo</h2>
          <p>
            Workena, jej rozhranie, softvér a súvisiace materiály patria Poskytovateľovi alebo jeho poskytovateľom licencií. Počas používania služby získava zákazník nevýhradné, neprenosné oprávnenie používať ju na vlastné interné účely v rozsahu objednaného balíka. Tým nie sú dotknuté práva zákazníka k jeho vlastným údajom.
          </p>
        </section>
        <section>
          <h2>9. Zodpovednosť</h2>
          <p>
            Každá strana zodpovedá za škodu v rozsahu stanovenom právnymi predpismi. Nič v týchto podmienkach nevylučuje ani neobmedzuje zodpovednosť, ktorú podľa práva nemožno vylúčiť alebo obmedziť, vrátane zodpovednosti za úmyselne spôsobenú škodu, ublíženie na zdraví alebo kogentných spotrebiteľských práv.
          </p>
          <p>
            V rozsahu dovolenom právom Poskytovateľ nezodpovedá za škodu spôsobenú nesprávnymi alebo nezákonne spracúvanými údajmi vloženými zákazníkom, nesprávnym nastavením prístupov zákazníkom, výpadkom internetového pripojenia alebo služieb tretích strán mimo primeranej kontroly Poskytovateľa, ani za rozhodnutia zákazníka založené na reportoch bez ich nezávislej kontroly.
          </p>
        </section>
        <section>
          <h2>10. Podpora a reklamácie</h2>
          <p>
            Otázky, oznámenia o bezpečnostnom incidente, sťažnosti a reklamácie možno poslať na <a href="mailto:info@rovolt.sk">info@rovolt.sk</a>. Uveďte názov firmy, prihlasovací e-mail, opis problému a požadovaný spôsob riešenia; neposielajte heslá ani citlivé platobné údaje. Poskytovateľ vybaví podanie v zákonných lehotách a podľa pravidiel uplatniteľných na konkrétneho zákazníka.
          </p>
        </section>
        <section>
          <h2>11. Rozhodné právo a riešenie sporov</h2>
          <p>
            Tieto podmienky sa riadia právnym poriadkom Slovenskej republiky. Spory sa strany pokúsia vyriešiť dohodou; tým nie je dotknuté právo obrátiť sa na príslušný súd ani kogentné pravidlá o príslušnosti a ochrane spotrebiteľa. Informácie o prípadnom mimosúdnom riešení spotrebiteľských sporov poskytne Poskytovateľ podľa právnych predpisov účinných v čase podania.
          </p>
        </section>
        <section>
          <h2>12. Zmeny podmienok</h2>
          <p>
            Poskytovateľ môže podmienky meniť z právnych, bezpečnostných alebo prevádzkových dôvodov. O podstatnej zmene informuje zákazníka primerane vopred a uvedie dátum účinnosti. Ak zákazník so zmenou nesúhlasí, môže pred jej účinnosťou ukončiť používanie služby alebo predplatné spôsobom dovoleným právom. Pokračovanie v používaní po účinnosti zmien sa posudzuje podľa uplatniteľných právnych predpisov a okolností súhlasu zákazníka.
          </p>
        </section>
      </article>
      <footer className="terms-footer">
        <button className="back-link button-quiet" onClick={onBack}><ArrowLeft size={15} /> Späť na Workenu</button>
        <span>Roman Chlebovec - ROVOLT · IČO 57875189</span>
      </footer>
    </main>
  );
}
