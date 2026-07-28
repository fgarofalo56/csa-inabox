# Tutorial: Data contract editor

> CSA Loom `data-contract` editor — the data-mesh / **ODCS** data contract as a
> first-class item: an output-port schema (typed columns + PII classification),
> quantified **SLOs**, and **data-quality expectations**, all authored in a typed
> designer — never a JSON textarea. Validates against a live **Azure Data
> Explorer** table with real KQL. Azure-native — **no Microsoft Fabric**.

## What it is

A data contract is the formal promise a data product makes to its consumers.
This item holds three things:

1. **Schema** — the output columns, their types, nullability, primary keys, and
   PII/sensitivity classification.
2. **SLOs** — quantified commitments: freshness, availability, support response,
   retention.
3. **Quality expectations** — per-column rules with a severity, checked against
   real data.

Bind the contract to a data product and its **error-severity** expectations are
enforced at that product's publish time. Bind it to an ingestion path and every
batch is checked as it lands.

## When to use it

- You are running a data mesh and need producers to publish an explicit,
  machine-checkable promise.
- You need an ODCS 3.1 document to exchange with a partner or register centrally.
- You want a publish gate that blocks a data product when its contract fails.
- If the contract belongs to exactly one data product and never travels, the
  data product's own **Contract** tab uses this same designer inline.

## Step-by-step in Loom

1. **Create the item.** **+ New item → Data contract**. A create gate explains
   what a contract is; click **Create data contract**. The editor opens at
   `/items/data-contract/<id>` with a teaching banner and a badge row showing
   live counts — *N columns · N SLOs · N expectations*, plus an `unsaved` badge
   when you have pending edits.
2. **Bind a table to validate against.** In **Validate against a table**, pick
   an **ADX database** then a **Table**. Both dropdowns are populated from your
   real Azure Data Explorer cluster (`?browse=databases` / `?browse=tables` on
   the item's quality endpoint) — nothing is typed by hand.
3. **Derive the schema.** Click **Derive schema from this table** (also in the
   ribbon as **Derive from table**). Loom runs a real ADX
   `.show table <T> schema as json` read and fills the designer. Re-deriving
   after a source change is a **diff, not a wipe**: columns you already annotated
   keep their description, classification, primary-key flag, and nullability;
   dropped columns are removed; new columns are appended. Save to persist.
4. **Author the contract.** In the **DataContractDesigner**:
   - **Schema grid** — add/remove columns, set type, nullability, primary key,
     and classification from typed dropdowns.
   - **SLO panel** — pick freshness, availability, support-response, and
     retention commitments from enumerated options.
   - **Quality expectations grid** — pick a rule and a **severity** per column.
5. **Save.** **Save contract** persists the whole document to the item's Cosmos
   state.
6. **Run the expectations.** The **quality run** panel executes the contract's
   expectations against the bound ADX table with real KQL and reports pass/fail
   per expectation. (Save first — validation runs against the *persisted*
   binding.)
7. **Register as ODCS 3.1.** In the ODCS card:
   - **Register** converts the typed designer state to an **ODCS 3.1** document,
     validates it, and upserts it into the registry.
   - **Export** downloads the registered document as `.odcs.json`.
   - **Import** takes a `.json` file through a file picker; any validation
     failure is rendered as verbatim per-field `{path, message}` errors, so an
     invalid document is **never** silently accepted.
8. **Set the enforcement posture.** The **Enforcement** dropdown defaults to
   **`warn-quarantine`** (labelled as the default): violating rows go to the
   Bronze `_rejected` dead-letter path and raise an alert, while conforming rows
   still land. **`hard-reject`** is the explicit opt-in that blocks the whole
   batch.
9. **Bind ingestion paths.** In **Ingestion bindings**, choose which mirrored
   databases, pipelines, or eventstreams this contract governs — all picked from
   dropdowns of your **real** items (`/api/items/by-type`), never typed.
10. **Enforce at publish.** Set a data product's `dataContractId` to this
    contract and its error-severity expectations gate that product's publish
    (BR-CONTRACT-GATE).

## The Azure backend it rides on

- **Validation engine:** **Azure Data Explorer** — schema introspection
  (`.show table … schema as json`) and expectation runs, both real KQL.
- **Persistence:** the item's own **Cosmos DB** state; the ODCS registry is a
  Cosmos registry document.
- **Quarantine:** the Bronze `_rejected` dead-letter path on your lake, plus an
  alert.
- **Enforcement point:** the data product publish gate and the bound ingestion
  paths.

## Honest gates

| Condition | What you see | Exact remediation |
|---|---|---|
| ADX not configured | Warning MessageBar *"ADX not configured"* naming the exact missing env var; the designer still works and still saves | Set the named variable to the ADX cluster URI on the `loom-console` container env — wired by `platform/fiab/bicep/modules/admin-plane/adx-cluster.bicep` |
| No database selected | The **Table** dropdown reads *"Pick a database first"* | Choose an ADX database |
| Browse call fails | The dropdown stays empty rather than showing invented names | Check ADX reachability / the console identity's ADX viewer grant |
| Invalid ODCS import | Per-field `{path, message}` errors rendered verbatim; nothing is applied | Fix the document at the reported paths and re-import |

## No Fabric required

Azure Data Explorer + Cosmos DB + ADLS Gen2. No Fabric capacity, workspace,
OneLake path, or Power BI workspace is used on any path.

## Learn more

- Data product editor tutorial: `editor-data-product.md`
- Parity source: `docs/fiab/parity/data-contracts.md`
- Microsoft Purview data products:
  <https://learn.microsoft.com/purview/concept-data-products>
