# Kalender: Exchange Online och Exchange on-prem

Öppna Kalender i sidhuvudet och välj Kalenderkonton. Varje anslutning använder
kontots huvudkalender. Månad och agenda samlar kontona; kontofiltret visar en
kalender i taget. Tider visas i Europe/Stockholm med sommar-/vintertid. För heldag
är slutdatumet exklusivt: 14–15 november betyder en heldag den 14:e.

## Privat: Microsoft 365 / Exchange Online

1. Öppna https://entra.microsoft.com → Identity → Applications → App registrations → New registration.
2. Namnge appen Kanban Calendar. Välj kontotyper som omfattar ditt konto:
   egen tenant för Microsoft 365, eller även personliga Microsoft-konton för
   Outlook.com. Ingen redirect URI behövs för device code-inloggningen.
3. Under Authentication → Advanced settings: aktivera Allow public client flows.
4. API permissions → Microsoft Graph → Delegated permissions → Calendars.ReadWrite.
   Använd inte Application permissions. Godkänn administratörsmedgivande om
   din tenant kräver det. Ingen client secret behövs.
5. Kopiera Application (client) ID till Kanban. Tenant kan vara tenantens UUID,
   organizations (arbetskonton), consumers (personliga Microsoft-konton) eller
   common (båda, om appregistreringen tillåter det).
6. Lägg till kontot, öppna Microsoft-länken som visas och ange koden. Välj rätt
   Microsoft-konto. Lösenord och MFA anges endast hos Microsoft.

Microsofts MSAL hanterar device code och förnyar åtkomsttoken via sin beständiga
cache. Offlineåtkomst ingår i MSAL:s standard-OIDC-scopes. Organisationspolicy
kan blockera public client/device code; då behöver IT tillåta appen. Ingen
inloggningskod läggs i AI-kontext eller loggar.

## Jobb: Exchange on-prem via EWS

Be IT om EWS-adress (vanligen https://mail.foretaget.se/EWS/Exchange.asmx),
autentisering och tillåtelse att ansluta appen. NTLM är standard. Basic stöds bara
över verifierad HTTPS när EWS uttryckligen tillåter det. Användarnamn kan vara
DOMÄN\användare eller UPN, beroende på serverns konfiguration.

Kanban-servern behöver nå EWS, eventuellt via VPN, och ha curl med NTLM-stöd.
För företagets egen CA: installera rotcertifikatet i serverns betrodda CA-lager.
TLS-verifiering stängs aldrig av. Omdirigeringar följs inte och uppgifterna går
inte via proxy. EWS-inloggningen testas innan kontot sparas. Stöd kräver Exchange
2013 SP1-kompatibelt EWS eller senare. Kerberos, ADFS/HMA och webbläsarformulär
stöds inte av denna anslutning. Om jobbet enbart tillåter dessa behövs en
IT-godkänd anslutningsväg. Byt EWS-lösenord genom att ta bort och återansluta kontot.

## Manuella skrivningar och begränsningar

Du kan skapa, läsa, ändra och radera egna fristående bokningar från gränssnittet.
Skrivningar går direkt till Exchange; inget påstås vara sparat när Exchange
inte kan nås. Radering kräver en andra bekräftelse. Samtidiga ändringar skyddas
med Graph ETag respektive EWS ChangeKey. Efter ett nätfel vid sparande: läs in
kalendern innan du försöker igen, eftersom Exchange kan ha hunnit spara.

Möten med deltagare och återkommande händelser/instanser visas. Ändra dem i
Outlook för att behålla mötesinbjudningar, serier och möteslänkar. Denna version
skickar inga inbjudningar och skapar inga serier. Andra kalenderfoldrar och delade
kalendrar ingår inte i denna version.

## AI har endast läsåtkomst

AI:n har tre kalenderverktyg: list_calendar_accounts, list_calendar_events och
get_calendar_event. Inget av dem kan skriva, radera, ändra konton eller bekräfta
något. AI:n har inga generiska HTTP-, shell- eller SQL-verktyg. Skrivgränsen finns
i serverns tillåtna verktygslista, utöver instruktionerna till modellen.

Calendars.ReadWrite behövs för dina manuella skrivningar. AI:n får aldrig token
eller lösenord. Avmarkera "AI får läsa denna kalender" per konto för att utesluta
kontot även från AI-läsning och kontext. Kalendertext är opålitlig data och får
inte styra andra verktyg eller sparas som minne utan en uttrycklig användarbegäran.
Kalenderläsningar loggas med antal/felstatus, manuella ändringar med konto-ID och
operation. Händelsetexter och hemligheter loggas inte som kalenderverktygsresultat.

## Drift, åtkomst och backup

Kanban är en gemensam LAN-installation. De som kan använda installationen kan
läsa anslutna kalendrar och göra manuella ändringar. Anslut bara konton om dessa
personer är behöriga. Använd en betrodd anslutning till Kanban vid anslutning.

Kontoinställningar, lösenord och MSAL-cache krypteras med AES-256-GCM i tabellen
calendar_accounts i befintlig SQLite. calendar.key ligger bredvid databasen med
filrättighet 0600. CALENDAR_KEY_PATH kan ange en annan absolut sökväg. Hemligheter
sparas inte i Git, webbläsarlagring, AI-minne eller loggar. Ta säker backup av både
SQLite och nyckeln; skydda dem separat. En saknad nyckel ersätts inte om konton
redan finns. Ta bort koppling raderar lokal anslutning och lokala token, aldrig
Exchange-händelser. Återkalla appmedgivandet i Microsoft separat om du också vill
återkalla Microsoft-sessioner. Påbörja ny device code-inloggning efter en omstart.

Händelser lagras inte lokalt utan läses direkt från Exchange. Vyn uppdateras varje
minut när sidan är synlig. Fel visas per konto även om andra konton fungerar.
Graph läser högst fem sidor om 100 händelser, EWS högst 500. Begränsade resultat
markeras tydligt. AI-läsningar har dessutom sidindelning i verktygsresultatet.

## Microsofts referenser

- Graph kalenderläsning: https://learn.microsoft.com/en-us/graph/api/calendar-list-calendarview?view=graph-rest-1.0
- Graph skrivningar: https://learn.microsoft.com/en-us/graph/api/event-update?view=graph-rest-1.0
- MSAL device code: https://learn.microsoft.com/en-us/entra/msal/javascript/node/acquire-token-requests
- EWS autentisering: https://learn.microsoft.com/en-us/exchange/client-developer/exchange-web-services/authentication-and-ews-in-exchange
- EWS kalenderläsning: https://learn.microsoft.com/en-us/exchange/client-developer/web-service-reference/finditem-operation
- EWS skrivningar: https://learn.microsoft.com/en-us/exchange/client-developer/web-service-reference/createitem-operation-calendar-item
