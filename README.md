# Klasseromplassering (nettversjon)

Statisk nettside – ingen server, ingen installasjon. Alt lagrar seg i
nettlesaren (localStorage) på eininga du brukar.

## Køyre lokalt
Opne `index.html` i ein nettlesar, eller (for å unngå enkelte
nettlesarbegrensingar på lokale filer):
```
python3 -m http.server 8000
```
og gå til `http://localhost:8000`.

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
- Fleire klassar, med standardklasse
- Språkbyte: nynorsk / bokmål / engelsk
- Utsjånad: fargetema, avrunding, bakgrunnsbilete, uskarpheit/gjennomsikt
  på pultar, skalering av grensesnitt og tekst
- PNG-eksport (direkte i nettlesaren, ingen bibliotek nødvendig)
