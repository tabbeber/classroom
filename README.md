# Klasseromplassering (nettversjon)

Statisk nettside – ingen server, ingen installasjon. Alt lagrar seg i
nettlesaren (localStorage) på eininga du brukar.

Denne programvara er i stor grad vibe-koda med Claude.

## Hoste på nett
Last opp dei fem filene (`index.html`, `style.css`, `core.js`, `i18n.js`,
`app.js`) til t.d. GitHub Pages, Netlify eller Cloudflare Pages. Ingen
byggjesteg, ingen bakgrunnstenester.

## Viktig om lagring
Data (klassar, elevar, historikk, innstillingar) lagrar seg i
nettlesaren sin localStorage – bunde til denne eininga/nettlesaren.
Bytter du eining, bruk **Last ned fil** / **Last opp fil** (Klasse-fana)
for å flytte ein klasse over. Ingen elevdata blir sende til nokon
server.

## Struktur
- `index.html` – sidestruktur, fire faner
- `style.css` – tema (CSS-variablar), utsjånad
- `core.js` – datamodell, algoritme, localStorage
- `i18n.js` – tekstar (nynorsk/bokmål/engelsk)
- `app.js` – all appstyring, teikning, drag, dialogar

## Funksjonar
Same funksjonalitet som skrivebordsversjonen (bordgrupper, svarteliste,
kjønnsvekting, historikk, soner, vend visning), pluss:
- Fire faner: Klasse, Klasserom, Plassering, Innstillingar
- **Rom skilt frå klasse**: eit rom (bordgrupper/soner) kan brukast av
  fleire klassar, og du kan byte rom for ei klasse når som helst
  (Klasserom-fana). Slettar du eit rom som er i bruk, får dei råka
  klassane automatisk eit nytt, tomt rom.
- Nye rom kan autofyllast med parbord ut frå elevtalet
- Slå saman/skil ut bordgrupper (Ctrl+klikk fleire plassar)
- Fleire klassar, med standardklasse
- Språkbyte: nynorsk / bokmål / engelsk
- Fullstendige tema (lys/mørk/Catppuccin), fargeval, bakgrunnsbilete,
  uskarpheit/gjennomsikt på pultar, skalering av grensesnitt/tekst,
  manuell pultstorleik
- Endre storleik på/minimer elevliste- og historikkpanelet
- PNG-eksport med gjeldande tema/bakgrunnsbilete, og valfri
  dato/tid/veke/klassenamn på biletet
