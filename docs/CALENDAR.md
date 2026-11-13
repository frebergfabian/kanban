# E-post och kalender

Välj E-post eller Kalender i sidhuvudets Vy-meny. Konton öppnar gemensamma
anslutningar. Microsoft 365 används för både e-post och kalender. Exchange
on-prem ligger kvar som en separat EWS-anslutning; befintliga konton återanvänds.

## Användaren: anslut Microsoft-konto

Klicka Anslut Microsoft-konto, välj konto och godkänn läsåtkomst hos Microsoft.
Inget Client ID, tenant, lösenord eller client secret anges i plattformens
användarformulär. Efter inloggningen återvänder du till E-post. Samma anslutning
används i kalendern. Om serverns appkonfiguration saknas visas det i Konton;
administratören behöver då slutföra engångsinställningen nedan.

Alla som har tillgång till denna gemensamma LAN-installation kan läsa anslutna
konton. Anslut bara konton som installationens användare är behöriga att läsa.
AI-läsning kan stängas av per konto i Konton. Det påverkar både e-post och kalender.

## Administratören: serverkonfiguration för Microsoft 365

Skapa en Web-appregistrering i https://entra.microsoft.com. Välj kontotyper som
omfattar dina användare: egen tenant, flera organisationer eller även personliga
Microsoft-konton. Konfigurera exakt denna callback som Web redirect URI:

    https://DIN-KANBAN-ADRESS/api/microsoft/callback

Sätt serverns miljövariabler (eller skyddad .env, filrättighet 0600):

    MICROSOFT_CLIENT_ID=<Application (client) ID>
    MICROSOFT_CLIENT_SECRET=<client secret-värdet, inte secret ID>
    MICROSOFT_TENANT_ID=common
    MICROSOFT_REDIRECT_URI=https://DIN-KANBAN-ADRESS/api/microsoft/callback

Registrera delegerade Microsoft Graph-behörigheter Mail.Read, Calendars.Read och
User.Read. Inga Application permissions eller skrivbehörigheter används. Ge
administratörsmedgivande om organisationens policy kräver det. Appen använder
confidential-client authorization code flow med PKCE, state och nonce. MSAL lägger
även till standard-OIDC-scopes för inloggning och offlineåtkomst. Public client-
flöden och device codes används inte längre. Client secret stannar på servern.
Rotera hemligheten innan den löper ut och starta om tjänsten efter ändrad miljö.

HTTPS-adressen måste nå Kanban via en TLS-terminerande proxy med korrekt Host och
ett betrott certifikat. Microsoft tillåter HTTP endast för lokal utveckling med
localhost/loopback. Serverns befintliga LAN-IP över HTTP kan därför inte användas
som produktionscallback. Klick från LAN-adressen går först till den konfigurerade
HTTPS-adressen så att OAuth-sessionens cookie hör till rätt värd. Callbackadressen
hämtas aldrig från ett användarformulär eller en godtycklig redirect-parameter.

Token förnyas med MSAL:s krypterade beständiga cache och rätt homeAccountId.
Vid förnyad inloggning till samma konto återanvänds kopplingen och dess AI-val.
Tidigare kalenderanslutningar med användarspecifika appinställningar eller
Calendars.ReadWrite-cache kopplas från lokalt och behöver anslutas igen med den
nya serverappen. On-prem-uppgifter ändras inte. Tidigare Microsoft-medgivanden
kan återkallas i Microsoft om de gamla bredare behörigheterna inte längre behövs.

## Exchange on-prem

Befintliga EWS-konton används direkt även för e-post. Lägg vid behov till ett
nytt konto i Konton → Lägg till Exchange on-prem. Ange EWS-adress, användarnamn,
lösenord och NTLM eller Basic över verifierad HTTPS. Servern behöver nå EWS,
eventuellt via VPN. För intern CA: installera rotcertifikatet i serverns betrodda
CA-lager. Ingen TLS-bypass eller omdirigering används. curl med NTLM-stöd krävs.
EWS 2013 SP1-kompatibelt API eller senare krävs. Kerberos/ADFS/HMA stöds inte av
anslutningen. Fråga IT om organisationen bara tillåter sådan autentisering.
Ett tillåtet kalenderkonto kan fortfarande sakna rätt till e-post; läsfelet visas
när e-post öppnas. Byt lösenord genom att ta bort och ansluta kopplingen igen.

## Vad kan läsas och skrivas?

E-post: läs och sök i Inkorg eller Skickat på valt konto, med Visa fler för nästa
sida. Sökningen är avgränsad till vald mapp. Graph/EWS tolkar sökord och stödjer
bland annat from:/subject:-uttryck enligt respektive servers söksyntax. Söksyntax
och indexering kan skilja sig mellan servrar. Resultat är inga bevis för att ett
mejl saknas i andra mappar. Arkiv, delade brevlådor och andra mappar ingår inte.
Listningen är begränsad till 1000 sidpositioner. Mejldetaljer visas som säker text;
HTML körs inte, externa bilder/länkar och bilagor hämtas inte. Text över 30000
tecken förkortas tydligt. Inga funktioner finns för att skicka, ändra, radera,
flytta eller markera mejl som lästa/olästa. En läsning ändrar inte lässtatus.

Kalender: månad/agenda för kontots huvudkalender. Europe/Stockholm används med
sommar-/vintertid. Microsoft 365-kalendern är helt skrivskyddad, även manuellt.
Befintlig on-prem-kalender kan fortfarande hantera egna fristående bokningar
manuellt; möten och återkommande serier ändras i Outlook. Radering kräver en extra
bekräftelse. Samtidiga on-prem-ändringar skyddas med ChangeKey. Heldagars slutdatum
är exklusivt: 14–15 november betyder en heldag den 14:e. Graph läser högst 500
händelser, EWS 500, med markering av begränsat resultat.

## AI, källor och analys

Inga automatiska analyser, AI-scheman eller bakgrundsskanningar startas.
E-post läses när vyn öppnas, söks eller uppdateras. Kalenderns synliga vy kan
uppdatera händelselistan varje minut; detta startar ingen AI-analys.

Öppna ett mejl och be AI:n exempelvis: "Sammanfatta det här och jämför med mitt
valda Kanban-kort." Valda mejlets konto och ID följer med jobbet; AI:n läser
själva källan med get_mail. Användaren kan rensa vald källa i AI-panelen. AI:n kan
också söka på begäran med list_mail_accounts, search_mail och get_mail samt läsa
kalender med list_calendar_accounts, list_calendar_events och get_calendar_event.
Kanban-verktygen används för att förstå relaterade kort. Kalender/mejltext är
opålitligt underlag, aldrig instruktioner eller tillstånd att ändra tavlor/minnen.
AI:n får aldrig token eller inloggningsuppgifter. Den har inga mejlskrivverktyg
och ingen kalenderförändring. Den kan ge ett textutkast i chatten om du ber om det.
Ett beställt AI-jobbs meddelande och sammanfattning sparas i befintlig chatthistorik;
råa mejl och bilagor synkroniseras inte till en lokal databas. AI:n ska inte spara
mejlinnehåll som varaktigt minne utan en uttrycklig begäran.

## Drift och backup

Befintlig AES-256-GCM-lagring och calendar.key återanvänds för EWS-uppgifter och
MSAL-cache. Nyckeln har rättighet 0600 och ska skyddas och säkerhetskopieras
separat tillsammans med SQLite. CALENDAR_KEY_PATH kan ange en annan absolut
sökväg. Ta bort koppling tar bara bort lokal anslutning och token; inga mejl eller
händelser raderas. Återkalla Microsoft-medgivandet hos Microsoft separat vid behov.
OAuth-state är kortlivad, engångs och bunden till en HttpOnly/SameSite-cookie.
Efter omstart eller tio minuter behöver en påbörjad inloggning startas om.
Loggar innehåller operation, kontoreferens och antal/status; inga råa mejlkroppar,
söktexter, authorization codes eller token loggas av integrationsverktygen.

## Microsofts dokumentation

- https://learn.microsoft.com/en-us/entra/msal/javascript/node/acquire-token-requests
- https://learn.microsoft.com/en-us/entra/identity-platform/reply-url
- https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/graph/search-query-parameter
- https://learn.microsoft.com/en-us/graph/api/calendar-list-calendarview?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/exchange/client-developer/web-service-reference/finditem-operation
- https://learn.microsoft.com/en-us/exchange/client-developer/web-service-reference/getitem-operation
