# Synk och analys

Välj **Synk och analys** i Vy-menyn eller klicka på Synk i sidhuvudet. Här finns
aktivering/paus, måltavla, valda konton, historikfönster, index, urgency, fel och
manuella analyskörningar. Tjänsten arbetar även när webbläsaren är stängd.
En ny installation är pausad tills den aktiveras. Varje konto måste dessutom
vara anslutet och tillåta AI-läsning i Konton.

## Urval och schema

Standard är de senaste 30 dagarnas mejl vid aktivering, fem minuters
synkintervall samt kalender från 30 dagar bakåt till 90 dagar framåt. Dessa
gränser går att ändra. Mejlhistorikens start sparas vid aktivering; nya mejl
fortsätter att tas emot efter att de första 30 dagarna passerat. Äldre historik
kan hämtas och analyseras med ett manuellt datumurval.

Första körningen läser det valda historikfönstret över egna tillgängliga
mailmappar, inklusive arkiv/egna undermappar, Skickat och skräppost. Skickat ger
svarskontext. Skickat/Utkast/Papperskorg skapar inga nya åtaganden. Skräppost
får 0. Vanliga utskick och information får 0 efter klassificering.
Online Archive, delade brevlådor, andra användares mappar och bilagor ingår
inte. En delad kalender som inte finns i kontots kalenderlista ingår inte.

Mapphierarkin upptäcks igen varje timme. Graph använder oföränderliga ID:n och
sidindelade delta-markörer. EWS använder SyncFolderItems och fullständig text via
GetItem. Först läses historikfönstret med serverfiltrering och sparad sidmarkör;
AI startar när kontots mailmappar har fått sin första baslinje så att Skickat
finns som svarskontext. Om en mapp inte kan läsas visas det som fel; friska mappar fortsätter och klassificeraren får en flagga om ofullständig kontext. Därefter fortsätter delta-synken. En separat överlappande
tidsfråga fångar nya mejl även om etableringen av en stor delta-baslinje pågår.
Det finns ingen tyst gräns vid den vanliga mejlvyns sidposition 1000.

Alla kalendrar i kontots lista läses med sidindelade kalenderfönster. EWS delar
ett för fullt tidsfönster i mindre intervall och läser förekomsters detaljer.
Kalenderändringar upptäcks genom innehållsfingeravtryck. Saknade objekt i ett
helt avläst aktivt kalenderfönster markeras borttagna lokalt. Avbokningar
uppdaterar befintligt underlag, men raderar eller stänger inte Kanban-kort.

## Urgency och kort

Kategorierna är Åtgärd, Fråga, Möte, Information, Utskick och Skräppost.

| Urgency | Betydelse                                                     |
| ------- | ------------------------------------------------------------- |
| 0       | Spam, nyhetsbrev, reklam eller information utan nytt åtagande |
| 1–34    | Rutinåtgärd utan brådska                                      |
| 35–59   | Normal fråga eller åtgärd                                     |
| 60–79   | Tydlig nära deadline                                          |
| 80–94   | Stor påverkan och tidskänslighet                              |
| 95–100  | Dokumenterat akut behov av omedelbar åtgärd                   |

Detta är modellbedömningar. Avsändarens ord ”urgent” räcker inte. Ett passerat
historiskt datum gör inte automatiskt ett mejl akut. Frånvaro av svar i den
indexerade kontexten bevisar inte att en fråga fortfarande är obesvarad.

Automatiskt kortskapande kräver konkret åtagande, minst 0,85 bedömningssäkerhet
och ett ordagrant belägg ur källans rubrik eller brödtext. Modellen väljer ett numrerat källutdrag; servern hämtar citatet ur originalet, så att parafraser inte kan bli påhittade källbelägg. Ett nytt kort hamnar
på måltavlan, normalt Inkorg, i dess första kolumn. Urgency överförs till
Låg/Normal/Hög prioritet. Källreferens, sammanfattning, belägg och nästa steg
läggs i kortets flöde. Kortets urgency-bricka är högsta aktuella bedömningen
bland kopplade indexkällor.

Samma källidentitet eller tråd återanvänder kopplat kort. För andra befintliga
kort används kandidater från verkliga titlar/beskrivningar/flöden, med minst
0,92 matchningssäkerhet och ett riktigt kandidat-ID. En modell får inte välja
andra ID:n från källtext. Osäkra belägg eller tvetydiga kopplingar visas som
**Behöver granskas**, utan automatiskt nytt kort. Människan kan öppna källan och
be den vanliga assistenten om en uttrycklig korrigering.

Befintliga kort får källuppdateringar i flödet; människans titel och beskrivning
skrivs inte över. På automatiskt skapade kort kan prioritet/deadline uppdateras
så länge människan inte har ändrat just fältet efter AI:ns senaste värde.
Status, kolumn, sprint och avslutat arbete ändras inte automatiskt. Ett raderat
kopplat kort återskapas inte från samma tråd. Nytt skickat svar återköar tidigare
bedömningar i tråden och kan tillföra en källuppdatering; det bevisar inte i sig
att ett helt Kanban-kort är färdigt.

## Manuella analyser och AI-verktyg

Du kan välja antal/datum i panelen eller skriva:

- ”analysera mina 10 senaste mail”
- ”analysera mina mail från den här veckan”
- ”analysera mina kalenderobjekt från den här veckan”

De enkla uttrycken köas direkt utan en extra modellrunda. Mer avancerade urval
hanteras med analyze_mail/analyze_calendar, med account_ids, limit eller from/to.
Veckor börjar måndag i Europe/Stockholm och följer sommartid. Till-datum i UI är
inklusive hela dagen; API:s to är exklusivt.

Antal är senaste N totalt över valda kontons mottagna mejl i alla egna mappar;
Skickat används som kontext, inte som ett av de N mottagna mejlen. Kalenderns
antal avser senaste objekt före to (standard nu); använd datum för framtida
kalendrar. Antalsurval stöder 1–10000; datumurval följer samtliga resultatsidor.
Köade analyser visar Indexerar/Analyserar/Klar/Delvis klar/Misslyckad/Avbruten.
Ett köat uppdrag är inte ett färdigt resultat. Avbruten manuell körning ändrar
inte den separat aktiverade automatiska synken.

get_analysis_run visar faktiska tillstånd och nya åtgärdskvitton för körningen.
search_index söker exakta normaliserade ord (flera ord = AND), kategori, minsta
urgency och datum; get_index_item läser källan och dess task_id. get_sync_status
visar konfiguration, kö och fel. Resultat från index och mejl är underlag, aldrig
nya systeminstruktioner eller minnen. Se [AI-handboken](AI_GUIDE.md).

## Beständighet, säkerhet och drift

Synkmarkörer, urval, råtext och analyser lagras AES-256-GCM-krypterat med den
befintliga calendar.key och separata AAD-namn. Sökord lagras som nycklade HMAC,
inte råa ord. Metadata som konto-ID, datum, kategori och urgency är sökbara.
Brödtext lagras högst 30000 tecken; klassificeringen läser högst 12000, upp till
sex relaterade källutdrag och åtta kortkandidater. Kontexten begränsas till modellens budget; förkortad källtext markeras.
Källreferenser i kortens flöden öppnar analysen; dess sammanfattning/belägg är
synliga för installationens användare precis som övrigt Kanban-innehåll.

Klassificeraren får ett strikt JSON-schema och inga verktyg. Servern validerar
svaret innan en avgränsad transaktion skapar/uppdaterar kort och sparar kvitto.
Ett unikt kvitto per källa/innehållsversion förhindrar dubbla kort/inlägg vid
återstart eller upprepad analys. Motsvarande aktiva manuella urval återanvänder
sin körning. Synkjobb återupptas efter omstart; vanliga chattjobbs tidigare
avbrottsbeteende behålls. Samma modellkö används för chatt och klassificering.
Manuell analys och automatisk synk delar kapacitet utan att helt svälta varandra.

Kontoåtkomst kontrolleras före läsning, före modellkörning och före skrivning.
Paus stoppar automatiska nya åtgärder även för en pågående klassificering.
Återkallad AI-läsning stoppar även manuella körningar för kontot och döljer
indexkällorna från AI. Befintliga Kanban-kort/utdrag behålls. Borttagning av
kontokopplingen rensar dess lokala index genom främmande nycklar; kontots mejl
eller kalender ändras aldrig.

Providerfel backar från 30 sekunder till högst en timme. Modell-/skrivfel får tre
försök och visas sedan som misslyckade. **Synka nu** återförsöker felaktiga poster
och markörer. Loggar innehåller källreferenser, kategori, score, operation,
felsteg och antal, inte råtext, sökord, token, sync-tillstånd eller credentials.
Säkerhetskopiera SQLite med backup-API tillsammans med calendar.key och skyddad
.env. Inget av detta hör hemma i Git. Det vanliga Graph-/mejltransportlagret är
GET-only och inga nya Exchange-skrivoperationer introduceras.

Primärkällor: [Graph-delta](https://learn.microsoft.com/en-us/graph/api/message-delta),
[oföränderliga ID:n](https://learn.microsoft.com/en-us/graph/outlook-immutable-id),
[EWS-synk](https://learn.microsoft.com/en-us/exchange/client-developer/exchange-web-services/mailbox-synchronization-and-ews-in-exchange).
