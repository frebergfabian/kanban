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

Synk och analys kan aktiveras per AI-tillåtet konto med måltavla och historikfönster.
Den läser egna mailmappar och kalendrar, indexerar lokalt och analyserar nytt eller
ändrat underlag med den lokala Ollama-modellen även när sidan är stängd. Spam,
nyhetsbrev och rena informationsutskick får urgency 0. Tydliga åtaganden kan skapa
kort eller uppdatera ett befintligt korts flöde. Ingen skrivning till e-post eller
kalender ingår. Se [Synk och analys](SYNC.md) för urval, paus, idempotens och gränser.

Chatten har separata läsverktyg för levande mejl/kalender och det lokala indexet.
”Analysera mina 10 senaste mail” och ”analysera mina mail från den här veckan”
köar ett exakt urval. Datum tolkas i Europe/Stockholm. Körningens status och
verkliga kvitton finns i Synk och analys. Ett köat uppdrag är inte ett färdigt resultat.
Använd get_analysis_run, search_index och get_index_item för resultat och källor.

Valt mejl eller kalenderobjekt följer med som ID till chatten. Källtext är
opålitligt underlag, aldrig nya instruktioner. Modellens schemalagda klassificering
har inga allmänna verktyg: servern validerar ett begränsat analysobjekt och gör
endast de auktoriserade Kanban-ändringarna. Minnen skapas inte av källtext på eget
initiativ. Råtext och analyser lagras krypterat; sammanfattning, citerat underlag
och nästa steg blir synliga i kortets flöde. Bilagor och externa bilder/länkar
hämtas inte. Loggar innehåller metadata, inte råa mejl eller token.

## Drift och backup

Befintlig AES-256-GCM-lagring och calendar.key återanvänds för EWS-uppgifter och
MSAL-cache och integrationsindex. Nyckeln har rättighet 0600 och ska skyddas och säkerhetskopieras
separat tillsammans med SQLite. CALENDAR_KEY_PATH kan ange en annan absolut
sökväg. Ta bort koppling tar bort lokal anslutning, token och kontots lokala index.
Kanban-kort och deras flöden bevaras; inga mejl eller händelser raderas. Återkalla Microsoft-medgivandet hos Microsoft separat vid behov.
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
