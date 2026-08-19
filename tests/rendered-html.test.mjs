import assert from "node:assert/strict";
import test from "node:test";

async function request(path = "/", init) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: { accept: "text/html", host: "localhost", ...init?.headers },
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

async function render() {
  return request();
}

test("renderuje panel Giełda Operacje po polsku", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<html[^>]*lang="pl"/i);
  assert.match(html, /Giełda Operacje/);
  assert.match(html, /Transakcje i zmiany/);
  assert.match(html, /Odśwież teraz/);
  assert.match(html, /Obserwowani inwestorzy/);
  assert.match(html, /od początku roku/i);
  assert.match(html, /ostatnie 2 lata/i);
  assert.match(html, /Szybka zmiana daty/);
  assert.doesNotMatch(html, /czas z eToro|Tylko odczyt|Tryb tylko do odczytu/i);
  assert.ok(html.indexOf("Dziennik zmian") < html.indexOf("Profile i wyniki"));
  assert.doesNotMatch(html, /Trzy portfele|Dzienny radar Copy Trading|API mówi „teraz”|Zmień osoby|Losuj nową trójkę|Tryb demo|Przygotuj kopiowanie|KOPIUJĘ ŚWIADOMIE/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Starter Project/i);
});

test("dodaje właściwe metadane społecznościowe", async () => {
  const html = await (await render()).text();
  assert.match(html, /Giełda Operacje — dziennik zmian eToro/);
  assert.match(html, /og\.png/);
  assert.match(html, /Bieżący dziennik zmian obserwowanych inwestorów eToro\./);
});

test("nie udostępnia endpointów kopiowania transakcji", async () => {
  for (const path of ["/api/copy", "/api/copy/eligibility"]) {
    const response = await request(path, { method: "POST" });
    assert.equal(response.status, 404, `${path} powinien być niedostępny`);
  }
});
