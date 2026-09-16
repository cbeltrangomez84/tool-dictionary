# Write your first dictionary

A dictionary is one JSON file. This guide writes one with three tools for a
fictional weather API, checks it, and searches it. The finished file is
[`spec/examples/city-weather.dictionary.json`](../spec/examples/city-weather.dictionary.json).

## 1. The header

```json
{
  "toolDictionary": "0.1",
  "id": "city-weather",
  "title": "City weather",
  "summary": "Current conditions and short forecasts for any city.",
  "version": 1,
  "generatedAt": "2026-09-16T00:00:00.000Z",
```

`summary` is what an agent is told it has access to — the served system prompt
literally reads *"You have access to a tool dictionary covering* ‹summary›". Write
it for that sentence. `version` is a counter you bump when the content changes;
the server derives an ETag from the bytes, so you never have to keep the two in
sync by hand.

## 2. Where the credential goes — not what it is

```json
  "defaults": {
    "baseUrl": "https://api.weather.example",
    "auth": { "kind": "caller", "in": "header", "name": "x-api-key", "value": "{{WEATHER_API_KEY}}" },
    "variables": { "WEATHER_API_KEY": { "secret": true, "description": "Issued in the console." } }
  },
```

A dictionary never contains a key. It says *this API wants a header called
`x-api-key`, and the caller has the value under the name `WEATHER_API_KEY`*. The
executor — your backend, not the dictionary service — fills it in. Every
`{{VARIABLE}}` used anywhere in the file must be declared in `variables`, and a
secret one may only appear in `auth.value`; the validator rejects anything else.

## 3. The index

```json
  "synonyms": { "forecast": ["outlook", "prediction"] },
  "index": {
    "nodes": [
      { "path": "weather", "title": "Weather", "summary": "What it is like outside, now and soon.",
        "sampleQueries": ["is it raining in Lisbon", "will it snow this weekend"] }
    ]
  },
```

The index is what an agent sees when a search misses. It is never empty: a bad
query returns these categories with their `sampleQueries`, so the agent's next
search is one that works. Write sample queries the way a person would actually
ask, and make sure each one really does land on a tool — the test below checks.

## 4. The entries

```json
  "entries": [
    {
      "name": "current_conditions",
      "title": "Current conditions",
      "summary": "Temperature, sky and wind in a city right now.",
      "path": "weather",
      "keywords": ["now", "right now", "temperature", "is it raining", "how hot", "how cold"],
      "input": { "type": "object", "properties": { "city": { "type": "string", "description": "City name, optionally with country." } }, "required": ["city"] },
      "returns": "An object with tempC, sky, windKph and observedAt.",
      "call": { "type": "http", "method": "GET", "urlTemplate": "/v1/current", "query": { "city": "{city}" } },
      "relations": [
        { "type": "pairs_with", "target": "forecast_daily", "reason": "what comes next, once you know what it is like now", "weight": 0.6 }
      ]
    },
```

Three things to get right, in order of how much they matter:

**Keywords are the point.** The search matches the user's words against
`title`, `summary`, `keywords` and `aliases`. The document already says
*temperature*; a person says *how hot is it*. Write the phrases, not the nouns.

**Relations carry the correction.** `pairs_with`, `narrower`, `broader`,
`alternative`, `prerequisite`, `enables`, `successor`, `predecessor`,
`same_data_other_source`. You write one direction; the server materializes the
inverse. The `reason` is shown to the agent verbatim, so write it as the sentence
you would say to a colleague who just picked the wrong tool.

**`returns` is one sentence about the shape.** Not the schema — the agent needs
to know whether the answer to *"is it raining"* is in this tool's output before
it calls it.

The other two entries — `forecast_daily` and `forecast_hourly` — are in the
finished file; `forecast_daily` declares `forecast_hourly` as `narrower`, and
that is the whole graph.

## 5. Check it

```bash
npm run build
node -e '
  const { validateDictionary } = require("./dist");
  const d = require("./spec/examples/city-weather.dictionary.json");
  console.log(JSON.stringify(validateDictionary(d), null, 1));
'
```

```json
{ "ok": true, "errors": [], "warnings": [] }
```

Errors are the schema plus the cross-reference rules of spec §17.1: every
`path` names an index node, every relation `target` exists, every `{param}` in a
URL is an input, every `{{VARIABLE}}` is declared. Warnings are quality — a
keyword that is on every entry, a summary that repeats the title.

## 6. Search it

```bash
cat > config/city-weather.json <<'JSON'
{ "port": 8080, "dictionaries": [ { "id": "city-weather",
  "source": { "kind": "file", "location": "../spec/examples/city-weather.dictionary.json" } } ] }
JSON
npm run dev -- config/city-weather.json
```

```bash
curl -s 'localhost:8080/v1/dictionaries/city-weather/search?q=is+it+raining+in+Lisbon&format=text'
```

```
DICTIONARY city-weather v1 — 1 result for "is it raining in Lisbon"

1. current_conditions — Current conditions
   Temperature, sky and wind in a city right now.
   path: weather
   input: city (string, required) — City name, optionally with country.
   returns: An object with tempC, sky, windKph and observedAt.
   call: GET https://api.weather.example/v1/current?city={city}  (auth: x-api-key header)
   see also: forecast_daily (pairs_with) — what comes next, once you know what it is like now

RELATED
   - forecast_daily — Daily forecast
     High, low and chance of rain per day for up to ten days.
     (pairs_with to current_conditions: what comes next, once you know what it is like now)

To use one, call it with the input shown. To see the full definition of any of
these, search again with its exact name.
```

(File locations are relative to the config file. `config/*.json` is
gitignored except for the example, so a local config never gets committed.)

And a miss, which is the more instructive case:

```bash
curl -s 'localhost:8080/v1/dictionaries/city-weather/search?q=stock+price&format=text'
```

```
DICTIONARY city-weather v1 — index
NOTE: Nothing matched "stock price". Search with one of the "try" queries below.

CATEGORIES
weather (3) — Weather: What it is like outside, now and soon.
   try: "is it raining in Lisbon", "will it snow this weekend"

Search again with one of the "try" queries, or with a path to narrow to one branch.
```

That is the whole format at its smallest. For a dictionary of hundreds of tools,
do not write it by hand — [generate it](generate-from-openapi.md) and put the
human knowledge in an overlay.
