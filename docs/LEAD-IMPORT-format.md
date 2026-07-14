# Lead Import Format (CSV / Excel → retell_call_queue)

What a lead file must look like to import into the dialer, and how each column maps to the
`retell_call_queue` schema. Save Excel as **CSV (UTF-8)**. First row = headers (any order;
the importer maps by header name, case-insensitive).

## Columns

| CSV header (accepted) | Maps to | Required | Notes |
|---|---|---|---|
| `phone` (or `phone_number`, `cell`) | `phone_e164` | **Yes** | Importer normalizes 10-digit US → `+1XXXXXXXXXX`. Rows that don't validate are rejected. |
| `first_name` + `last_name` (or `name`, `full_name`) | `contact_name` | **Yes** | Combined if split. |
| `state` (or `timezone`) | `lead_timezone` | **Strongly recommended** | Drives the TCPA calling-window. State → IANA tz (e.g. `FL`→`America/New_York`). Defaults to `America/New_York` if absent — **wrong tz = calling at illegal hours.** |
| `email` | `lead_context.email` | No | Shown on the agent screen. |
| `consent_date` + `consent_source` | `consent_verified` + `lead_context.consent` | Recommended | PEWC provenance. If compliance module is ON, leads without consent won't dial. |
| `segment` (or `campaign`, `product`) | `segment` | No | Business line / list label; can route to an in-group. |
| `external_id` (or `crm_id`) | `external_lead_id` | No | Your CRM's record id (for writeback). |
| `tags` (or `labels`) | `lead_labels` | No | Comma-separated → array. Used for tier/engagement rules. |
| `priority` | `priority_score` | No | Integer; default `20`. Higher = dialed sooner. |
| `agent` | `assigned_agent` | No | Pre-assign to a specific agent (free text). |
| *any other column* | `lead_context.<name>` | No | Extra fields land in the JSONB and surface on the agent pop. |

## Sample header row

```
first_name,last_name,phone,email,state,segment,external_id,tags,consent_date,consent_source,notes
```

A ready-to-edit sample is committed at `examples/sample-leads.csv`.

## Rules the importer MUST enforce (not optional for insurance)

1. **Normalize + validate phone** to E.164; reject/report invalid rows (don't silently drop).
2. **Dedup on `phone_e164`** — skip or update an existing queue row rather than double-dial.
3. **Scrub BEFORE insert** against national + internal **DNC** *and* a **TCPA litigator list**
   (Blacklist Alliance / DNC.com / TCPA Litigator List). This is the lawsuit-prevention gate.
4. **Set `source = 'csv_import'`** and stamp an import batch id in `lead_context` for auditability.
5. **Resolve timezone** from `state` (or accept `timezone`), else default — and log the default so
   calling-window mistakes are traceable.
6. **Consent:** if these are consented leads, set `consent_verified = true` and record
   `consent_date/source` in `lead_context`; if the compliance module is ON, leads stay non-callable
   until consent is verified.
7. **Report a summary:** rows accepted / rejected (with reasons) / deduped / DNC-suppressed.

## What the UI needs (import screen)

- Upload CSV/XLSX → **preview + column-mapping step** (auto-map by header, let the user fix
  mismatches) → validation report → confirm import into a chosen **list/campaign**.
- Show the post-import counts and let the user download the rejected-rows file to fix and re-upload.
