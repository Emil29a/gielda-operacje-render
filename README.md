# CopyPulse

CopyPulse obserwuje wyłącznie publiczne portfele `@jianswang`, `@rafaeldfl` i `@jeppekirkbonde`, zapisuje migawki i buduje dzienny dziennik otwarć, zamknięć oraz zmian pozycji. Aplikacja działa wyłącznie w trybie odczytu i nie ma funkcji wykonywania ani kopiowania transakcji. Nie generuje żadnych danych demonstracyjnych.

Karty inwestorów pokazują zdjęcia profili oraz okresowe pole `gain` zwracane przez eToro dla `CurrYear` i `LastTwoYears`. Dziennik jest pierwszą sekcją panelu, ma szybkie przełączanie ostatnich siedmiu dni, a przycisk „Odśwież teraz” pobiera nową migawkę i wraca do bieżącego dnia.

## Uruchomienie

Wymagany jest Node.js 22.13 lub nowszy.

```powershell
npm install
npm run dev
```

Bez konfiguracji aplikacja pokazuje trzy właściwe profile, ale nie wyświetla żadnych transakcji. Aby pobrać prawdziwe dane eToro:

1. Zweryfikuj konto eToro.
2. W `Settings → Trading → API Key Management` utwórz klucz z uprawnieniem Read.
3. Uzupełnij `ETORO_API_KEY` oraz `ETORO_USER_KEY` w lokalnym `.env.local`.

Klucze nigdy nie trafiają do przeglądarki — zapytania do eToro wykonują wyłącznie odczytowe trasy serwerowe. Do aplikacji należy używać klucza z uprawnieniem `Read`, bez `Write`.

## Ważne ograniczenie API

Publiczne API udostępnia bieżący portfel inwestora (`/api/v1/user-info/people/{username}/portfolio/live`), nie kompletny publiczny dziennik jego wszystkich transakcji. Dlatego:

- czas otwarcia z dokładnością do sekundy pochodzi z pola `openTimestamp` i jest oznaczony jako dokładny;
- zamknięcie jest wykrywane, gdy pozycja znika między dwiema migawkami — panel pokazuje czas wykrycia, nie zmyśloną godzinę wykonania;
- historia zaczyna być kompletna dopiero od chwili uruchomienia monitoringu;
- gdy panel jest otwarty, synchronizacja odbywa się co 5 minut; produkcyjnie warto dodatkowo wywoływać `POST /api/sync` z harmonogramu.

## Bezpieczeństwo transakcji

Aplikacja nie zawiera endpointów Copy Tradingu, przycisków kopiowania ani kodu wysyłającego zlecenia do eToro. Służy wyłącznie do odczytu publicznych danych i tworzenia lokalnego dziennika obserwacji.

Dokumentacja: [eToro Public API](https://api-portal.etoro.com/), [uwierzytelnianie](https://api-portal.etoro.com/getting-started/authentication), [publiczny portfel](https://api-portal.etoro.com/api-reference/users-info/get-user-live-portfolio).

## Dane i ryzyko

Historia jest zapisywana w Cloudflare D1. Aplikacja nie stanowi rekomendacji inwestycyjnej. Copy Trading wiąże się z możliwością utraty kapitału, a wyniki historyczne nie gwarantują przyszłych rezultatów.
