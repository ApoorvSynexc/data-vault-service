# `POST /api/v1/restore/retrieve/fetch-records` — UI integration & test payloads

Verified against source on 2026-07-30:

- `client-service/src/routes/v1/restore-retrieve.route.ts:24` (route)
- `client-service/src/controller/v1/restore-retrieve/index.ts:254` (`parseFetchRecordsParams` — the authoritative validator)
- `client-service/src/services/restore-retrieve/index.ts` (`fetchCsvRecords`, `resolveScope`, `fingerprintRequest`)
- `client-service/src/services/restore-retrieve/athena-fetch.ts` (SQL builder), `athena-filter.ts` (filters)
- `client-service/src/assets/localization/en.json:60-100` (error text)

> ⚠️ `docs/architecture-graph/API_FETCH_RECORDS.md` is **stale** — it documents an older flat contract
> (`configType`, top-level `backupJobIds` / `columnNames` / `filters` / `changedSince` / `filteringFields`).
> None of those fields exist any more. Use this file.

---

## 1. Endpoint basics

| | |
|---|---|
| Method / URL | `POST {{baseUrl}}/api/v1/restore/retrieve/fetch-records` |
| Content-Type | `application/json` (body limit 10 MB) |
| Auth | **HTTP-only cookie `accessToken`** — *not* an `Authorization: Bearer` header |
| Page size | 50 records per response (fixed) |

Mount chain: `app.use('/api', …)` → `router.use('/v1', …)` → `router.use('/restore', restoreRetrieveRouter)` → `router.post('/retrieve/fetch-records', …)`.

### Auth — the one thing that breaks first

`middlewares/authentication/index.ts:8` reads the JWT from `req.cookies.accessToken`. A bearer header is ignored.
CORS runs with `credentials: true` against a fixed `ALLOWED_ORIGINS` list, so the browser must send the cookie:

```js
// fetch
await fetch(`${baseUrl}/api/v1/restore/retrieve/fetch-records`, {
  method: 'POST',
  credentials: 'include',                     // required
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

// axios
axios.post(url, payload, { withCredentials: true });
```

Failure modes: `401 unauthorized` (no/expired cookie, dead session), `403 blocked_or_removed` (inactive user).

---

## 2. Request shape

```jsonc
{
  "source": {                       // REQUIRED object
    "backupConfigId": "string",     // REQUIRED — resolves CRM, Glue db + table, ownership
    "type": "ENTIRE",               // REQUIRED — "ENTIRE" | "PARTIAL" | "CHANGED_BETWEEN"
    "startDate": "2026-01-01",      // optional — LastModifiedDate lower bound
    "endDate":   "2026-07-30",      // optional — LastModifiedDate upper bound
    "backupJobIds": ["job_1"]       // optional for ENTIRE/CHANGED_BETWEEN, required for PARTIAL
  },
  "objectApiName": "Account",       // REQUIRED
  "columns": ["Id", "Name"],        // REQUIRED — non-empty; also the response projection
  "selection": null,                // optional — null/absent = source filters only
  "fullRestore": false,             // optional — default false
  "cursor": "…"                     // optional — echo meta.nextCursor for page 2+
}
```

`selection`, when present:

```jsonc
"selection": {
  "restoreScope": {                                          // REQUIRED inside selection
    "type": "RECORD",                                        // REQUIRED — see table below
    "objects":     ["Account"],                              // optional allow-list
    "records":     [{ "objectName": "Account", "recordIds": ["001…"] }],
    "fields":      [{ "objectName": "Account", "fieldNames": ["Name"] }],
    "filters":     { "type": "AND", "fields": [ … ] },
    "chnageSince": { "date": "2026-06-01" },                 // NOTE the spelling
    "bulkCsvIds":  ["001…"],
    "deletedOnly": false
  }
}
```

### `source.type` — this changes which records AND which version you get

| type | Required extra input | Records returned | Version returned |
|---|---|---|---|
| `ENTIRE` | none | every record in scope | **newest**, from `inserts/`, `updates/` or `deletes/` alike |
| `PARTIAL` | `backupJobIds` non-empty | records in those jobs | **newest** |
| `CHANGED_BETWEEN` | `startDate` **or** `endDate` | **only records that changed inside the window** | the version to **restore TO** — see below |

Missing the required input → `400 backup_job_ids_required` / `400 date_range_required`.

**`CHANGED_BETWEEN` version picking:**

| latest op in window | what comes back |
|---|---|
| `UPDATE` | the version **beneath** the change — i.e. the second-newest. For a record updated once this row physically lives in `inserts/`. |
| `DELETE` | the whole `deletes/` row. A deleted record has no earlier version to roll back to. |
| `INSERT` | the row itself — nothing has changed since it was written, so it is already its own restore target. |

Records with no change inside the window are excluded entirely.

Two consequences worth knowing:

- **`ENTIRE` + a date window is no longer the same as `CHANGED_BETWEEN`.** On `ENTIRE` the dates are a plain row filter and you still get the newest version. Pick the type by what you actually want.
- **`fullRestore` is redundant with `CHANGED_BETWEEN`** — that type implies restore-to picking, and `fullRestore: false` does **not** turn it back off. If you need the *current* state of records that changed in a window, use `ENTIRE`/`PARTIAL` with the date window instead.

A change made *after* `endDate` cannot affect the answer: the scan is truncated at `endDate`, so the anchor is always the newest change at or before the window's end.

### `restoreScope.type` — declarative, not behavioural

Accepted: `ALL`, `OBJECT`, `RECORD`, `FIELD`, `FILTER`, `DELETED_ONLY`, `CHNAGE_SINCE`, `BULK_CSV`.

`resolveScope()` does **not** switch on `type` — narrowing comes from whichever *fields* are present. Two consequences for the UI:

1. `{"type": "RECORD"}` with no `records[]` narrows **nothing** and returns the whole object. The UI must send the payload field that matches the type it picked.
2. `type: "DELETED_ONLY"` is the single exception — it forces `deletedOnly = true` whether or not the flag was sent.

`type` **is** part of the cursor fingerprint, so changing it alone still invalidates pagination.

---

## 3. Response shape

```jsonc
{
  "success": true,
  "message": "fetch",                       // localized via accept-language
  "data": {
    "columns": ["Id", "Name", "type"],
    "rows": [
      { "record": { "Id": "001xx…", "Name": "Acme", "type": "UPDATE" } },
      { "record": { "Id": "001yy…", "Name": "",     "type": "DELETE" } }
    ]
  },
  "meta": { "limit": 50, "hasMore": true, "nextCursor": "eyJmcCI6…" }
}
```

Contract details the UI must code against:

- **`rows` is always `[{ record: {...} }]`** — the record is one level down, never a flat row.
- **Every value is a string.** Athena returns varchar for everything. Null/absent → `""`. Numbers, booleans and dates need client-side parsing.
- **`type` is always present** in every record and in `columns`, even though it is not in your `columns` request. It is derived from the S3 path (`inserts/` → `INSERT`, `updates/` → `UPDATE`, `deletes/` → `DELETE`) and reports the record's *latest* operation. Do not send `"type"` in `columns` — it is not a real table column.
- **`columns` = your `columns` + extras.** Read `columns`; don't assume it equals your request.
- **`Id` and `LastModifiedDate` are always scanned but stripped from the response unless requested.** If the UI writes records back to Salesforce, or shows a modified-date column, ask for them explicitly.
- Rows are ordered `LastModifiedDate DESC, Id DESC`.
- `meta.nextCursor` is absent on the last page; `meta.hasMore` is `false`.

### `fullRestore`

Opts `ENTIRE` / `PARTIAL` into the same restore-to version picking that `CHANGED_BETWEEN` does by default.

| | `fullRestore: false` (default) | `fullRestore: true`, or `CHANGED_BETWEEN` |
|---|---|---|
| `INSERT` | the row | same row (already the restore target) |
| `UPDATE` | post-update values (current state) | the version **beneath** it (pre-change state) |
| `DELETE` | the DELETE row | the DELETE row (nothing earlier to roll back to) |

`type` still reports the latest operation in both modes, so the UI can show "what is being reverted".

---

## 4. Pagination

Server holds no state — the cursor carries everything.

```
POST { …query… }                     → 50 rows, meta.nextCursor = A
POST { …identical query…, cursor: A} → next 50,  meta.nextCursor = B
…                                    → meta.hasMore = false
```

Rules:

1. Re-send the query **byte-identically** alongside the cursor.
2. Change anything that affects which rows come back → **drop the cursor, restart at page 1**. Sending a stale cursor returns `400 cursor_mismatch` rather than silently serving the old query's rows.
3. Stop on `meta.hasMore === false`.
4. Treat `nextCursor` as opaque — never parse, build, or reorder it.

The cursor fingerprint (`fingerprintRequest`, `services/restore-retrieve/index.ts:381`) covers exactly:
`objectApiName`, `userId`, `columns` (order-insensitive), `source.backupConfigId`, `source.type`, `source.startDate`, `source.endDate`, `source.backupJobIds` (order-insensitive), `fullRestore`, the compiled filter, `restoreScope.type`, `.objects` (order-insensitive), `.records`, `.fields`, `.chnageSince.date`, `.bulkCsvIds` (order-insensitive), `.deletedOnly`.

Reordering `columns` or job ids is safe; changing any value is not.

**Why re-sending is cheap:** Athena is queried in blocks of 2000. Page 1 runs one scan; pages 2–40 replay the stored result set from S3 (no scan, no ~2s query settle — near-instant); page 41 runs one new query seeking past the last row. 2000 records = 1 scan, not 40.

---

## 5. Test payloads

`{{configId}}`, `{{jobId}}`, `{{recordId}}` are placeholders. Every payload below is valid against the current validator.

### 5.1 Smoke test — smallest legal body

```json
{
  "source": { "backupConfigId": "{{configId}}", "type": "ENTIRE" },
  "objectApiName": "Account",
  "columns": ["Id", "Name"]
}
```

### 5.2 Typical grid load (recommended default)

```json
{
  "source": { "backupConfigId": "{{configId}}", "type": "ENTIRE" },
  "objectApiName": "Account",
  "columns": ["Id", "Name", "Phone", "LastModifiedDate"],
  "selection": null
}
```

### 5.3 Page 2 — cursor echo

```json
{
  "source": { "backupConfigId": "{{configId}}", "type": "ENTIRE" },
  "objectApiName": "Account",
  "columns": ["Id", "Name", "Phone", "LastModifiedDate"],
  "selection": null,
  "cursor": "<paste meta.nextCursor from 5.2 verbatim>"
}
```

### 5.4 `PARTIAL` — specific backup jobs

```json
{
  "source": {
    "backupConfigId": "{{configId}}",
    "type": "PARTIAL",
    "backupJobIds": ["{{jobId}}", "{{jobId2}}"]
  },
  "objectApiName": "Account",
  "columns": ["Id", "Name", "Phone"]
}
```

`backupJobIds` is the table's partition filter — the only real pruning lever on this table. Send it whenever the user has picked jobs.

### 5.5 `CHANGED_BETWEEN` — date window

```json
{
  "source": {
    "backupConfigId": "{{configId}}",
    "type": "CHANGED_BETWEEN",
    "startDate": "2026-06-01",
    "endDate": "2026-07-29"
  },
  "objectApiName": "Account",
  "columns": ["Id", "Name", "LastModifiedDate"]
}
```

Bare dates are fine. `endDate: "2026-07-29"` is auto-extended to `2026-07-29T23:59:59.999Z`, so the range is inclusive of that whole day. Full ISO timestamps are passed through as-is.

**What this returns:** only records that changed between those dates, each at the version to restore TO — an updated record comes back with its pre-change values (that row usually lives in `inserts/`), a deleted record comes back as the whole `deletes/` row, and records untouched in the window are omitted. `type` tells you which change is being reverted.

Note the returned `LastModifiedDate` is the *restored version's* timestamp, so it can legitimately be **older than `startDate`** — that is the point, not a bug. Rows are still ordered by it, so a "changed between" grid is ordered by the pre-change timestamp. If the UI needs to sort by when the change happened, that value is not in the response today; say so and it can be added.

Omitting `startDate` and sending only `endDate` is legal: with no lower bound every record qualifies, and the query reads as "restore-to state as of `endDate`".

### 5.6 Structured `AND` filter

```json
{
  "source": { "backupConfigId": "{{configId}}", "type": "ENTIRE" },
  "objectApiName": "Account",
  "columns": ["Id", "Name", "AnnualRevenue", "Industry"],
  "selection": {
    "restoreScope": {
      "type": "FILTER",
      "filters": {
        "type": "AND",
        "fields": [
          { "name": "Name",          "dataType": "string",   "operator": "LIKE", "value": "Acme" },
          { "name": "AnnualRevenue", "dataType": "currency", "operator": ">=",   "value": "100000" },
          { "name": "Industry",      "dataType": "string",   "operator": "IN",   "value": "Technology, Finance" }
        ]
      }
    }
  }
}
```

Filter rules (`athena-filter.ts`):

- **Operators** (closed set, case-insensitive): `=`, `!=`, `<>`, `<`, `>`, `<=`, `>=`, `LIKE`, `NOT LIKE`, `IN`, `NOT IN`. Anything else → `400 invalid_filter_operator`.
- **All four keys are required strings** on every field — including `value`. Numbers must be sent as `"100000"`, not `100000`, or you get `400 invalid_filter_field`.
- **`LIKE` auto-wraps**: a value with no `%`/`_` becomes `%value%` (contains). Supply your own wildcards for prefix/suffix matching (`"Acme%"`).
- **`IN` / `NOT IN` take one comma-separated string**, not an array. Empty after splitting → `400 invalid_filter_field`.
- **`dataType`** decides literal quoting. Bare (unquoted) for `integer`, `double`, `decimal`, `currency`, `percent`, `number`, `long`; `true`/`false` for `boolean` (matching `true|1|yes`, case-insensitive); single-quoted for everything else. Defaults to `string` when empty.
- **`name` must match `/^[A-Za-z_][A-Za-z0-9_]*$/`** → else `400 invalid_filter_field`. Same rule applies to `columns` (`400 invalid_column_name`) and `fields[].fieldNames`.

### 5.7 `OR` filter

```json
{
  "source": { "backupConfigId": "{{configId}}", "type": "ENTIRE" },
  "objectApiName": "Contact",
  "columns": ["Id", "FirstName", "LastName", "Email"],
  "selection": {
    "restoreScope": {
      "type": "FILTER",
      "filters": {
        "type": "OR",
        "fields": [
          { "name": "Email",     "dataType": "string", "operator": "LIKE", "value": "@example.com" },
          { "name": "LastName",  "dataType": "string", "operator": "=",    "value": "O'Brien" }
        ]
      }
    }
  }
}
```

Quotes in values are escaped server-side — `O'Brien` is safe.

### 5.8 `SOQL` filter (WHERE clause only)

```json
{
  "source": { "backupConfigId": "{{configId}}", "type": "ENTIRE" },
  "objectApiName": "Opportunity",
  "columns": ["Id", "Name", "StageName", "Amount"],
  "selection": {
    "restoreScope": {
      "type": "FILTER",
      "filters": { "type": "SOQL", "soqlQuery": "StageName = 'Closed Won' AND Amount > 5000" }
    }
  }
}
```

A full `SELECT … FROM … WHERE …` is accepted (only the `WHERE` body is used). A query with no `WHERE` compiles to no filter. Not supported → 400:
`Owner.Name = 'x'` → `soql_relationship_not_supported`; subqueries → `soql_subquery_not_supported`;
SOQL date literals (`LAST_N_DAYS:7`, `TODAY`) → `soql_date_filter_not_supported`; unparseable → `invalid_soql`.
Use `source.startDate` / `endDate` for date ranges instead.

### 5.9 `RECORD` scope — user ticked specific rows

```json
{
  "source": { "backupConfigId": "{{configId}}", "type": "ENTIRE" },
  "objectApiName": "Account",
  "columns": ["Id", "Name", "Phone"],
  "selection": {
    "restoreScope": {
      "type": "RECORD",
      "records": [{ "objectName": "Account", "recordIds": ["{{recordId1}}", "{{recordId2}}"] }]
    }
  }
}
```

`objectName` must match `objectApiName` **exactly** (case-sensitive). Entries for other objects contribute nothing — a mismatch silently widens the query to the whole object, so this is worth an explicit test.

### 5.10 `FIELD` scope — replaces `columns`

```json
{
  "source": { "backupConfigId": "{{configId}}", "type": "ENTIRE" },
  "objectApiName": "Account",
  "columns": ["Id", "Name", "Phone", "Website", "Industry"],
  "selection": {
    "restoreScope": {
      "type": "FIELD",
      "fields": [{ "objectName": "Account", "fieldNames": ["Id", "Phone"] }]
    }
  }
}
```

For the matching object, `fieldNames` **replaces** `columns` entirely — this response returns `Id`, `Phone`, `type` only. An entry that matches but carries an empty `fieldNames` is ignored (`columns` stands). If the UI needs `Id` back, put it in `fieldNames`.

### 5.11 `DELETED_ONLY`

```json
{
  "source": {
    "backupConfigId": "{{configId}}",
    "type": "PARTIAL",
    "backupJobIds": ["{{jobId}}"]
  },
  "objectApiName": "Account",
  "columns": ["Id", "Name", "Phone"],
  "selection": { "restoreScope": { "type": "DELETED_ONLY" } }
}
```

Keeps only records whose **newest** operation is `DELETE`; every row comes back with `"type": "DELETE"`. Equivalent to `"deletedOnly": true` on any other scope type.

### 5.12 `BULK_CSV` — ids from an uploaded file

```json
{
  "source": { "backupConfigId": "{{configId}}", "type": "ENTIRE" },
  "objectApiName": "Account",
  "columns": ["Id", "Name"],
  "selection": {
    "restoreScope": {
      "type": "BULK_CSV",
      "bulkCsvIds": ["{{recordId1}}", "{{recordId2}}", "{{recordId3}}"]
    }
  }
}
```

`bulkCsvIds` is **unioned** with `records[].recordIds` (not overridden) — sending both widens the set.

### 5.13 `CHNAGE_SINCE` — note the spelling

```json
{
  "source": { "backupConfigId": "{{configId}}", "type": "ENTIRE" },
  "objectApiName": "Account",
  "columns": ["Id", "Name", "LastModifiedDate"],
  "selection": {
    "restoreScope": { "type": "CHNAGE_SINCE", "chnageSince": { "date": "2026-06-01" } }
  }
}
```

`CHNAGE_SINCE` / `chnageSince` is the accepted spelling in both the type and the key — the server matches what the client already sends. `chnageSince` and `source.startDate` are both lower bounds; **the later (tighter) of the two wins**, so neither can widen the other.

### 5.14 `fullRestore` — restore preview

```json
{
  "source": {
    "backupConfigId": "{{configId}}",
    "type": "PARTIAL",
    "backupJobIds": ["{{jobId}}"]
  },
  "objectApiName": "Account",
  "columns": ["Id", "Name", "Phone"],
  "selection": { "restoreScope": { "type": "ALL" } },
  "fullRestore": true
}
```

Use this to get restore-to versions **without** restricting to a date window. On `CHANGED_BETWEEN` the flag is redundant — that type already picks restore-to versions.

### 5.15 Everything at once (max-coverage regression payload)

```json
{
  "source": {
    "backupConfigId": "{{configId}}",
    "type": "CHANGED_BETWEEN",
    "startDate": "2026-01-01T00:00:00Z",
    "endDate": "2026-07-29",
    "backupJobIds": ["{{jobId}}", "{{jobId2}}"]
  },
  "objectApiName": "Account",
  "columns": ["Id", "Name", "Phone", "LastModifiedDate"],
  "selection": {
    "restoreScope": {
      "type": "FILTER",
      "objects": ["Account"],
      "records": [{ "objectName": "Account", "recordIds": ["{{recordId1}}"] }],
      "filters": {
        "type": "AND",
        "fields": [{ "name": "Name", "dataType": "string", "operator": "LIKE", "value": "A" }]
      },
      "chnageSince": { "date": "2026-03-01" },
      "bulkCsvIds": ["{{recordId2}}"],
      "deletedOnly": false
    }
  },
  "fullRestore": false
}
```

`fullRestore: false` is ignored here — `CHANGED_BETWEEN` picks restore-to versions regardless. `chnageSince.date` (`2026-03-01`) and `source.startDate` (`2026-01-01`) are both lower bounds, so the later one wins and the effective change window is `2026-03-01 → 2026-07-29`.

### 5.16 Empty page without an Athena scan

```json
{
  "source": { "backupConfigId": "{{configId}}", "type": "ENTIRE" },
  "objectApiName": "Account",
  "columns": ["Id", "Name"],
  "selection": { "restoreScope": { "type": "OBJECT", "objects": ["Contact"] } }
}
```

`objects` excludes `Account`, so the request selects nothing: `200` with `rows: []`, `hasMore: false`, no `nextCursor`, and no query run. An empty or absent `objects` means "no object restriction", **not** "no objects".

---

## 6. Negative tests (all `400`, shape `{ "success": false, "message": "<text>", "data": null, "meta": {} }`)

| Payload change | `message` key |
|---|---|
| `source` missing / not an object | `invalid_source` |
| `source.backupConfigId` missing or blank | `id_required` |
| `source.type: "FOO"` | `invalid_source_type` |
| `source.startDate: 20260101` (number) | `invalid_source_date` |
| `source.backupJobIds: "job_1"` (string, not array) | `invalid_backup_job_ids` |
| `type: "PARTIAL"` with no `backupJobIds` | `backup_job_ids_required` |
| `type: "CHANGED_BETWEEN"` with no dates | `date_range_required` |
| `objectApiName` missing / empty | `object_api_name_required` |
| `columns: []` or not an array | `column_names_required` |
| `columns: ["Name; DROP TABLE x"]` | `invalid_column_name` |
| `selection: "x"` (not an object/null) | `invalid_selection` |
| `selection: {}` (no `restoreScope`) | `invalid_restore_scope` |
| `restoreScope.type: "NOPE"` | `invalid_restore_scope_type` |
| `restoreScope.objects: "Account"` | `invalid_scope_objects` |
| `records: [{ "recordIds": [] }]` (no `objectName`) | `invalid_scope_records` |
| `fields: [{ "objectName": "Account" }]` (no `fieldNames`) | `invalid_scope_fields` |
| `filters: "x"` | `invalid_filters` |
| `filters.type: "XOR"` | `invalid_filter_type` |
| `filters: { "type": "SOQL" }` (no query) | `soql_query_required` |
| `filters: { "type": "AND" }` (no `fields`) | `filter_fields_required` |
| a field missing a key, or `value` not a string | `invalid_filter_field` |
| `operator: "OR 1=1"` | `invalid_filter_operator` |
| `chnageSince: { "date": 123 }` | `invalid_changed_since` |
| `bulkCsvIds: "001"` | `invalid_bulk_csv_ids` |
| `deletedOnly: "true"` (string) | `invalid_deleted_only` |
| `fullRestore: "yes"` (string) | `invalid_full_restore` |
| `cursor: 123` | `invalid_cursor` |
| cursor from a *different* query | `cursor_mismatch` → **restart at page 1** |
| cursor whose Athena block aged out | `cursor_expired` → **restart at page 1** |
| unknown `backupConfigId`, or one owned by another user | `not_exist` |

`message` is localized from `assets/localization/en.json` via `accept-language`, so match on the **HTTP status + your own request state**, not on the message string. Ownership failure and genuine absence both collapse into `not_exist` deliberately — it avoids confirming that another user's config exists.

---

## 7. Ready-to-run curl

```bash
curl -i -X POST "{{baseUrl}}/api/v1/restore/retrieve/fetch-records" \
  -H "Content-Type: application/json" \
  -b "accessToken={{jwt}}" \
  -d '{
    "source": { "backupConfigId": "{{configId}}", "type": "ENTIRE" },
    "objectApiName": "Account",
    "columns": ["Id", "Name", "Phone", "LastModifiedDate"],
    "selection": null
  }'
```

---

## 8. Performance notes to pass along

Athena bills by bytes scanned. Roughly in order of impact:

1. **Send `source.backupJobIds` whenever the user has picked jobs** — it is the table's partition filter and the only real pruning lever.
2. **Send an `endDate`** when the user's intent allows it. Note that on `CHANGED_BETWEEN` the `startDate` is a record *selector*, not a row filter — it does not reduce bytes scanned (it cannot: the pre-change version it has to return is older than the window). `endDate` does bound the scan on every type.
3. **Ask for fewer `columns`** — Parquet/CSV projection cost scales with columns.
4. **Send `bulkCsvIds` / `records[]`** when specific rows are selected.
5. **Page with the cursor** instead of re-issuing the query — pages 2–40 of each 2000-row block cost nothing.
6. **Reuse the identical request**: byte-identical queries within 5 minutes hit Athena's own result cache.
