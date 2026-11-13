# Kanban

En lokal Kanban- och Scrum-app med en AI-assistent via Ollama. React, TypeScript och Vite i gränssnittet, Express och SQLite på servern. Ingen moln-AI eller API-nyckel behövs.

## Funktioner

- Flera Kanban-tavlor med egna kolumner, mål och AI-instruktioner.
- Kort med beskrivning, prioritet, deadline och ett beständigt flöde av inlägg, uppdateringar och automatiska händelser.
- Dra kort mellan kolumner eller flytta dem i kortdialogen. Kortens flöden följer med mellan tavlor.
- Scrum-tavlor under ett masterkort i Kanban, med backlog, sprintmål, datum och start/avslut av sprintar. Masterkortet visar framsteg och en länk till undertavlan.
- En beständig AI-jobbkö. Chatten minimeras till headern när arbetet börjar och öppnas igen vid frågor. Lägg till fler jobb, ändra köordning och avbryt jobb.
- Sökbar chatthistorik, källmärkta minnen och tekniska lärdomar som AI:n kan använda i senare jobb.
- Sökbara loggar över modellrundor, verktygsanrop, resultat, fel och HTTP-anrop.
- Separat mänsklig bekräftelse för radering av kort och tavlor. AI:n kan begära radering men kan inte själv godkänna den.

## Kom igång

Node.js 20.19+, 22.12+ eller 24 samt npm krävs. Om `better-sqlite3` behöver kompileras krävs även Python 3, `make` och en C++-kompilator.

```bash
git clone https://github.com/frebergfabian/kanban.git
cd kanban
npm ci
cp .env.example .env
```

Anpassa `.env` till din Ollama-server:

```dotenv
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=qwen3:8b
HOST=127.0.0.1
PORT=3000
```

Modellen behöver stöd för verktygsanrop. Installera exempelvis standardmodellen på Ollama-servern:

```bash
ollama pull qwen3:8b
```

Starta appen från repots rot:

```bash
npm start
```

Öppna [http://localhost:3000](http://localhost:3000). `npm start` bygger och startar hela appen på en port. Avsluta med Ctrl+C.

För åtkomst från andra datorer i ditt LAN, sätt `HOST=0.0.0.0` och öppna `http://<serverns-IP>:3000`. Ollama-adressen nås från appservern, så webbläsaren behöver inte ha direkt åtkomst till Ollama.

Appen är avsedd för en betrodd lokal dator eller ett betrott LAN och har ingen egen användarinloggning. Exponera den inte direkt mot internet. Servern kontrollerar Host och ursprung för skrivande API-anrop, men detta ersätter inte autentisering.

## Inställningar

| Variabel | Standard | Betydelse |
| --- | --- | --- |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama-serverns adress. |
| `OLLAMA_MODEL` | `qwen3:8b` | Modell med stöd för verktygsanrop. |
| `HOST` | `127.0.0.1` | Adress som webbservern lyssnar på. |
| `PORT` | `3000` | Webbserverns port. |
| `DATABASE_PATH` | `./data/kanban.sqlite` | SQLite-fil; relativ sökväg räknas från repots rot. |
| `OLLAMA_TIMEOUT_MS` | `120000` | Tidsgräns per Ollama-anrop, 1000–300000 ms. |

`.env.example` är en mall. Din `.env`, databaser, loggar, lokala testartefakter, byggfiler och `node_modules` ignoreras av Git.

## Använd tavlor och kort

Välj tavla i listan ovanför kolumnerna. **Ny tavla** skapar en Kanban- eller Scrum-tavla. Tavlans **···** öppnar namn, mål och AI-instruktioner. Ge instruktioner som hjälper assistenten att skapa användbart arbete, exempelvis: ”Dela upp i små verifierbara steg och dokumentera hinder i kortets flöde.”

**Ny kolumn** lägger till egna steg, exempelvis Granskning eller Blockerat. Kolumnens inställning för färdigstatus avgör om kort räknas som klara; namnet i sig gör det inte.

**Ny uppgift**, eller kolumnens **+**, skapar ett kort. Öppna kortet för att redigera fält, välja tavla/kolumn eller publicera en anteckning eller uppdatering. Manuella inlägg märks **Du**, AI-inlägg **AI-assistent**. Skapande, flytt och fältändringar loggas automatiskt. Fältredigering sparar bara ändrade fält så att samtidiga, orelaterade AI-ändringar inte skrivs över.

Tangentbord för dragning: fokusera kortets grepp, tryck mellanslag, använd piltangenterna och släpp med mellanslag. Escape avbryter.

## Scrum under ett masterkort

Öppna ett kort på en Kanban-tavla och välj **Skapa Scrum-tavla**. Masterkortets beskrivning används som utgångspunkt. Det kan ha en kopplad Scrum-tavla, som får Backlog, Att göra, Pågår, Granskning och Klart. En fristående Scrum-tavla kan också kopplas från masterkortets dialog.

Skapa en sprint med mål och valfria datum. Öppna backlogkorten och välj sprint, välj sedan sprinten i visningsmenyn och starta den. Nya kort i den vyn tilldelas vald sprint. Bara en sprint kan vara aktiv per tavla.

När en sprint avslutas bevaras även ofärdiga kort i den för historik. De kan återföras till backlog via kortets sprintval. Masterkortets status ändras inte automatiskt. Det visar antal klara underkort och länkar till Scrum-tavlan, som i sin tur har en länk tillbaka.

Masterkort får flyttas mellan Kanban-tavlor och behåller kopplingen. Radering eller flytt in i Scrum blockeras medan kopplingen finns. Frikoppla undertavlan i dess inställningar vid behov.

## AI-jobb, historik och minne

AI-panelen har **Chatt**, **Historik**, **Minne** och **Loggar**. Klicka **Fråga AI om kortet** i kortdialogen för att ge assistenten valt kort som kontext. Aktiv tavla och sprint följer också med varje nytt jobb.

Jobben körs ett i taget på servern. När modellen börjar utföra arbetet minimeras chatten till en indikator mitt i headern. Klicka indikatorn för att öppna samtalet eller **+** för att lägga till ett nytt jobb. Kön låter dig ändra ordning på väntande jobb, avbryta jobb och öppna resultat. Jobben fortsätter efter omladdning och stängd flik.

Vid serveromstart återupptas väntande jobb. Ett påbörjat jobb markeras avbrutet och körs inte om automatiskt, för att undvika dubbla ändringar. Redan sparade steg, kvitton och loggar bevaras. En databas kan bara ha en aktiv köarbetare.

Samtal och jobb sparas automatiskt i SQLite. AI:n får relevanta minnen och tidigare resultat och kan söka äldre samtal. Varaktiga preferenser, fakta och beslut får källhänvisningar till användarmeddelanden. Du kan själv lägga till, rätta och glömma minnen. Verktygsfel ger beständiga tekniska lärdomar. Detta förbättrar kontext och återkoppling; modellen tränas inte om automatiskt.

Loggar visar bland annat tider/tokenantal för modellrundor, verktygsargument och resultat, fel och jobbstatus. Kända hemlighetsfält och vanliga tokenmönster maskeras. Lägg inte lösenord eller API-nycklar i chattar, kort eller minnen.

Exempel:

- ”Skapa en tavla för Debian-servern med fem verifierbara installationssteg.”
- ”Skapa en Scrum-tavla under det valda masterkortet med tre backlogkort.”
- ”Planera en sprint med de befintliga korten och starta den.”
- ”Kom ihåg att jag vill ha korta svenska svar och tydliga kriterier för klart.”
- ”Sök i våra tidigare samtal om backup och föreslå nästa steg. Ändra ingenting.”
- ”Läs loggarna för det misslyckade jobbet och förklara vad som gick fel.”

Assistenten har 31 explicita verktyg med strikt validering. Den kan planera och ändra innehåll i appen, men inte köra shell, SQL, godtycklig kod eller externa administrationstjänster. Se [hela AI-handboken](docs/AI_GUIDE.md) och [instruktionerna som används i modellrundorna](docs/AI_PLAYBOOK.md).

## Radering och beständiga data

**Ta bort tavla** finns i tavlans inställningar. Radering visar antal kort och kräver en separat bekräftelse; tavlans kort, sprintar och flöden tas då bort tillsammans. Tavlor med kopplade undertavlor eller aktiva/väntande AI-jobb skyddas. Om den sista tavlan raderas skapas en ny tom tavla.

AI:n kan begära radering med ett riktigt kort- eller tavle-ID, men har inget verktyg för att själv bekräfta begäran. Bekräftelser blir ogiltiga om objektet ändras. Historik och loggar bevaras även när en tavla raderas och ska läsas som historiskt underlag.

SQLite-databasen migreras automatiskt vid start. Befintliga kort, ID:n, datum, positioner och flöden bevaras vid migrering av tidigare versioner. Säkerhetskopiera databasen före uppgradering. När servern är stoppad kan du kopiera SQLite-filen; vid backup under drift behövs en SQLite-medveten backup så att WAL-data följer med.

## Utveckling och verifiering

```bash
npm run dev    # Express och Vite i utvecklingsläge
npm run check  # TypeScript-kontroll
npm test       # Automatiska tester med tillfälliga databaser och testad modelltransport
npm run build  # Verifiera och bygg klient och server
npm run serve  # Kör färdig byggning
```

GitHub Actions kör installation, typkontroll, tester och byggning på Node.js 22 och 24 för pull requests och ändringar på `main`. CI behöver varken Ollama, lösenord eller tillgång till någon lokal databas.

Valfria integrationstester mot din konfigurerade Ollama-server:

```bash
npm run test:ollama
npm run test:scrum:ollama
npm run test:work:ollama
```

Dessa använder databaser i minnet och ändrar inte dina befintliga tavlor. De verifierar verkliga verktygsanrop, Scrum samt minne och historik mellan olika samtal.

## Kodstruktur

| Sökväg | Innehåll |
| --- | --- |
| `src/` | React-gränssnitt, kortflöden, Scrum, AI-panel och jobbkö i headern. |
| `server/` | Express-API, SQLite-lagring, Ollama-verktyg, kö, minne och loggar. |
| `shared/schema.ts` | Gemensamma typer och strikt Zod-validering för API och verktyg. |
| `docs/` | AI-handbok och arbetsinstruktioner. |
| `tests/` | Automatiska tester och valfria Ollama-integrationstester. |
