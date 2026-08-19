# CopyPulse — przekazanie projektu drugiemu AI

Ten plik jest instrukcją instalacji i dokumentem przekazania kontekstu. Najpierw przeczytaj go w całości, a dopiero później zmieniaj kod.

## 1. Cel projektu

CopyPulse to polski, lokalny panel informacyjny obserwujący publiczne dane trzech inwestorów eToro:

- `@jianswang` — Jian Lim;
- `@rafaeldfl` — Rafael Lopez;
- `@JeppeKirkBonde` — Jeppe Kirk Bonde.

Aplikacja pobiera publiczne portfele i historię dostępną w API eToro, pokazuje transakcje wybranego dnia, aktualne otwarte pozycje, wyniki inwestorów, liczbę kopiujących i pomocnicze zmiany kursu.

Najważniejsza zasada: wszystko ma być zgodne z danymi eToro. Nie wolno tworzyć danych demonstracyjnych, domyślać się brakujących transakcji, godzin, kursów, wyników ani rynków.

## 2. Bezpieczeństwo

Projekt jest wyłącznie do odczytu:

- nie ma funkcji Copy Tradingu;
- nie ma endpointu wykonującego transakcje;
- nie wolno dodawać przycisków kupna, sprzedaży ani kopiowania;
- do eToro należy używać wyłącznie klucza z uprawnieniem `Read`;
- kluczy nie wolno wkleić do kodu, commita, instrukcji ani wiadomości;
- klucze zapisuje się wyłącznie w lokalnym `.env.local`.

Archiwum celowo nie zawiera `.env.local`. Jeżeli użytkownik wklei klucze na czacie, poleć ich unieważnienie i wygenerowanie nowych.

## 3. Instalacja na nowym komputerze

Wymagania:

- Windows, macOS albo Linux;
- Node.js `22.13.0` lub nowszy;
- npm;
- dostęp do internetu dla instalacji paczek i API eToro.

Po rozpakowaniu ZIP przejdź do katalogu projektu i wykonaj:

```powershell
node --version
npm install
Copy-Item .env.example .env.local
```

Na macOS/Linux ostatnie polecenie zastąp:

```bash
cp .env.example .env.local
```

Użytkownik musi sam uzupełnić `.env.local`:

```dotenv
ETORO_API_KEY=TU_KLUCZ_API
ETORO_USER_KEY=TU_KLUCZ_UZYTKOWNIKA
```

Uruchomienie:

```powershell
npm run dev
```

Następnie otwórz `http://localhost:3000`.

Kontrola projektu:

```powershell
npm test
npm run lint
```

`npm test` najpierw buduje całą aplikację, a następnie uruchamia testy HTML. Nie uznawaj zmiany za zakończoną, jeżeli build lub testy nie przechodzą.

## 4. Co drugie AI ma zrobić jako pierwsze

1. Przeczytaj `README.md` i ten plik w całości.
2. Przejrzyj `package.json`, `app/Dashboard.tsx`, `app/globals.css`, wszystkie trasy w `app/api/` oraz pliki w `lib/`.
3. Zrozum typy w `lib/types.ts` i schemat danych w `db/schema.ts` oraz `lib/store.ts`.
4. Sprawdź, jak `lib/etoro.ts` mapuje odpowiedzi API, zanim zmienisz nazwy pól lub obliczenia.
5. Uruchom `npm install`, `npm test` i dopiero potem aplikację.
6. Po skonfigurowaniu kluczy sprawdź `/api/dashboard?date=RRRR-MM-DD` i porównaj kilka pozycji z oficjalnym eToro.
7. Zachowaj istniejące zmiany użytkownika. Nie wykonuj `git reset --hard`, nie usuwaj plików i nie podmieniaj całego interfejsu bez wyraźnej prośby.

## 5. Mapa architektury

- `app/Dashboard.tsx` — cały interaktywny panel: kalendarz, dziennik, „W skrócie”, filtry i modale inwestorów.
- `app/globals.css` — kompletny wygląd desktopowy i mobilny.
- `app/api/dashboard/route.ts` — składa dane panelu, łączy migawki, bieżący portfel i publiczną historię.
- `app/api/sync/route.ts` — ręczna synchronizacja wyłącznie do odczytu.
- `app/api/investors/route.ts` — dane obserwowanych inwestorów.
- `lib/etoro.ts` — klient publicznego API eToro i mapowanie odpowiedzi.
- `lib/sync.ts` — synchronizacja profili, pozycji i wykrytych zmian.
- `lib/store.ts` — zapis i odczyt z Cloudflare D1.
- `lib/tracked-investors.ts` — lista trzech śledzonych kont.
- `lib/time.ts` — daty w strefie `Europe/Warsaw`.
- `lib/types.ts` — wspólne typy danych.
- `db/schema.ts` i `drizzle/` — schemat oraz migracje bazy.
- `tests/rendered-html.test.mjs` — obecne testy bezpieczeństwa i renderowania.

Projekt używa React 19, TypeScript, vinext/Vite, Cloudflare Workers, D1 i Drizzle ORM.

## 6. Aktualne reguły interfejsu

- Dziennik zmian jest pierwszą główną sekcją strony.
- Widoczne daty mają format `dd.mm.rrrr`.
- Kalendarz jest własnym polskim komponentem: polskie miesiące, dni tygodnia i przycisk „Dzisiaj”.
- Pasek `Wszyscy / inwestorzy` znajduje się pod listą dziennika zmian.
- Wyniki inwestorów pokazują pola eToro `CurrYear` i `LastTwoYears`.
- Kupno jest oznaczane na czerwono.
- Sprzedaż jest oznaczana na niebiesko.
- Short jest oznaczany oddzielnie na fioletowo; nie wolno przedstawiać go jako zwykłej sprzedaży.
- Long nie ma osobnej etykiety.
- „W skrócie” grupuje operacje według dnia, instrumentu i rodzaju operacji.
- Powtarzające się operacje tego samego inwestora na tym samym instrumencie i tego samego dnia są łączone wizualnie.
- Kafelki „W skrócie” są wyraźnie czerwone dla kupna i niebieskie dla sprzedaży.
- Kliknięcie kafelka „W skrócie” otwiera osobny modal z listą właściwych inwestorów, liczbą kopiujących, godziną, wynikiem od początku roku i za dwa lata.
- Modal ma wyszukiwarkę, ponieważ lista docelowo może zawierać ponad 50 inwestorów.
- Kliknięcie inwestora otwiera jego publiczny portfel.
- W portfelu sekcja „Ostatnio handlowane” jest większa i bardziej widoczna niż lista otwartych pozycji.
- Nieaktywne strzałki przewijania są ukryte; pojedyncze kliknięcie przesuwa o jeden kafelek.
- Suwaki poziome pozostają dostępne na telefonie.

Nie zmieniaj powyższych zachowań przypadkowo podczas kolejnych poprawek.

## 7. Reguły prawdziwości danych

- Instrument identyfikuje `instrumentId`, nie sam symbol. Ma to znaczenie, gdy ta sama spółka jest notowana na kilku rynkach.
- Nazwa rynku i kurs muszą odpowiadać dokładnie instrumentowi zwróconemu przez eToro.
- Logo spółki pochodzi z metadanych instrumentu eToro.
- `netProfit` jest wynikiem pozycji raportowanym przez eToro; nie zastępuj go prostą zmianą ceny.
- Pomocnicza zmiana kursu jest liczona osobno z kursu otwarcia i bieżącego albo zamknięcia.
- Dla zamkniętej pozycji używaj kursu i czasu zamknięcia zwróconego przez historię eToro.
- Gdy bieżący kurs pochodzi z poprzedniej sesji, interfejs musi informować, że rynek jest jeszcze zamknięty.
- Strefa czasu aplikacji to `Europe/Warsaw`.
- Publiczna historia może być chwilowo niedostępna. Wtedy pokaż uczciwy komunikat zamiast uzupełniać brakujące rekordy.
- Historia migawek lokalnych nie jest kompletna sprzed pierwszego uruchomienia monitoringu, ale endpoint publicznej historii eToro może zwracać prawdziwe wcześniejsze otwarcia i zamknięcia.

## 8. Grupowanie zdarzeń

W interfejsie zdarzenia są grupowane kluczem złożonym z:

- użytkownika;
- dnia w Warszawie;
- `instrumentId`;
- rodzaju zdarzenia (`OPEN`, `CLOSE`, `UPDATE`);
- kierunku (`buy` albo `short`).

Nie grupuj różnych rynków tylko dlatego, że mają podobny symbol. Nie łącz kupna ze sprzedażą ani longa z shortem.

## 9. Czego nie ma w archiwum

- `.env.local` i kluczy API;
- `node_modules`;
- plików buildu: `.next`, `.vinext`, `build`, `dist`;
- lokalnego stanu `.wrangler` i lokalnej bazy D1;
- logów i katalogu `.git`.

Na nowym komputerze zależności i lokalna baza zostaną utworzone ponownie. Źródła, migracje i `package-lock.json` są dołączone.

## 10. Zalecany komunikat startowy dla drugiego AI

Możesz przekazać drugiemu AI następujące polecenie:

> Przejmujesz rozwój projektu CopyPulse z załączonego ZIP. Najpierw przeczytaj w całości `PRZEKAZANIE_DLA_AI.md` i `README.md`, przeanalizuj architekturę oraz uruchom testy. Nie zmieniaj jeszcze kodu. Następnie przedstaw mi krótko: jak działa pobieranie danych eToro, jak powstaje dziennik, gdzie są najważniejsze komponenty UI, jakie są ograniczenia prawdziwości danych i czy projekt uruchomił się poprawnie. Pamiętaj, że aplikacja jest wyłącznie do odczytu, kupno jest czerwone, sprzedaż niebieska, short fioletowy, a brakujących danych nie wolno wymyślać. Po tym będziemy kontynuować rozwój.

## 11. Stan w chwili przekazania

- Data przygotowania paczki: `18.08.2026`.
- Polecenie `npm test` przechodzi: build oraz 3 testy zakończone powodzeniem.
- Projekt działa lokalnie pod `http://localhost:3000` po skonfigurowaniu zależności i kluczy.
- Śledzone profile: Jian Lim, Rafael Lopez i Jeppe Kirk Bonde.

