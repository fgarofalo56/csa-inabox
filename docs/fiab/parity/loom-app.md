# loom-app — parity with Microsoft Fabric / Power BI **org apps**

> Parity audit per `.claude/rules/ui-parity.md` + `.claude/rules/no-vaporware.md`
> + `.claude/rules/no-fabric-dependency.md`. Graded conservatively.

**What this is.** A **Loom app** is the Azure-native equivalent of a **Fabric /
Power BI org app** (the "Apps" experience): bundle existing workspace items
(reports, dashboards, notebooks, and more) into a single distributable,
audience-scoped app with its own navigation, then publish a consumer view.
Unlike the ADF sub-features documented alongside it, `loom-app` **is a real,
standalone gallery item** — `apps/fiab-console/lib/catalog/item-types/fabric-apps.ts`
(`slug: 'loom-app'`, `restType: 'LoomApp'`, category **Loom Apps**).

**Source UI (grounded in Microsoft Learn, not memory):**
- Fabric org apps (create + navigation + audiences): https://learn.microsoft.com/fabric/fundamentals/create-apps
- Power BI apps overview: https://learn.microsoft.com/power-bi/consumer/end-user-apps
- App audiences (per-audience content + access): https://learn.microsoft.com/power-bi/collaborate-share/service-create-distribute-apps
- Update / publish an app: https://learn.microsoft.com/power-bi/collaborate-share/service-update-apps

**No-Fabric note.** The Fabric/Power BI org-app model requires a Power BI /
Fabric workspace. Loom's parity path is **100% Azure-native**: the app
definition + audiences persist to **Cosmos** as the item's `state`, and the
published consumer view reuses Loom's existing item routes + access model. No
Power BI or Fabric workspace is required (`no-fabric-dependency.md`), and the
editor says so in-surface.

**Loom surface:**
- Editor: `apps/fiab-console/lib/editors/loom-app-editor.tsx` + model
  `loom-app-model.ts`. Tabs: **Content · Navigation · Audiences · Publish ·
  Preview**.
- BFF: `app/api/items/loom-app/[id]/candidates` (live workspace inventory),
  `…/[id]/route.ts` (state via `useItemState`), `…/[id]/publish` (publish /
  unpublish + version), `…/[id]/render` (resolve the consumer manifest).
- Consumer view: `/apps/view/<id>`.

**Backend reality check.** The Content picker lists the **real** workspace
inventory (`listAllOwnedItems`, Cosmos, ownership-scoped) — no mock arrays.
Save/Publish/Preview PATCH/POST real Cosmos-backed routes; Publish stamps
`published` + a new `version` + `publishedAt` and returns the live
`/apps/view/<id>` URL; Preview (`/render`) resolves the exact manifest a consumer
sees, filtered by audience membership. Audiences carry an access list of
UPN/email/group-object-id principals enforced through Loom's access model.

---

## Fabric/Power BI feature inventory → Loom coverage → backend

Legend: built ✅ · honest-gate ⚠️ · MISSING ❌

| # | Fabric / Power BI org-app capability | Loom | Where / backend |
|---|---|---|---|
| 1 | Create an app that bundles workspace items | ✅ built | `loom-app` item; `NewItemCreateGate` |
| 2 | **Pick content** from the live workspace inventory | ✅ built | Content tab → `GET …/candidates` (real Cosmos inventory) |
| 3 | Order content | ✅ built | move up/down; persists to `state.content` |
| 4 | **Navigation sections** — create / rename / reorder | ✅ built | Navigation tab; assign items to sections |
| 5 | Assign each content item to a nav section | ✅ built | per-row section dropdown |
| 6 | **Audiences** — named, each with its own access list | ✅ built | Audiences tab; `AudienceCard` |
| 7 | Per-audience **visible-content subset** | ✅ built | "All app content" toggle or per-item checkboxes |
| 8 | Access list by user (email/UPN) or group (object id) | ✅ built | principal chips on the audience |
| 9 | **Publish** (mint consumer app + version) | ✅ built | Publish tab → `POST …/publish` |
| 10 | **Re-publish / update** an existing app | ✅ built | Publish → re-publish bumps `version` |
| 11 | **Unpublish** (retract) | ✅ built | `POST …/publish {unpublish:true}` |
| 12 | **Preview as a consumer** (audience-filtered manifest) | ✅ built | Preview tab → `GET …/render` |
| 13 | **Open the published consumer app** | ✅ built | `/apps/view/<id>` (new tab) |
| 14 | Consumer opens items under their own identity + governance | ✅ built | consumer nav routes to real item pages |
| 15 | App branding (logo / theme / description landing) | ❌ MISSING | display name + description only |
| 16 | Per-audience install / auto-install / app link sharing UX | ⚠️ partial | access list + published URL; no push-install / email-share flow |
| 17 | Item-level permission overrides inside the app | ⚠️ partial | audience visible-subset only; relies on underlying item access |

**Grade: B.** The full org-app workflow — content → navigation → audiences →
publish → preview → consumer view — is built and round-trips to real
Cosmos-backed routes with **no Fabric/Power BI workspace**, matching the
`fabric-apps` catalog intent. Gaps (app branding, push-install/share UX) are
polish, not stubs.
