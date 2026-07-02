# Tutorial: Workshop app editor

> CSA Loom `workshop-app` editor — the Azure-native equivalent of Palantir
> Foundry **Workshop** (Loom calls it *Atelier*): a low-code operational app
> bound to a Loom **Ontology**, running on Azure with **no Microsoft Fabric
> workspace required**.

## What it is

A Workshop app is an operational, low-code application whose pages render
**object views over an Ontology's entity types** instead of over a raw database.
Widgets read live objects, users traverse links between them, and **write-back
actions** persist changes through the ontology's bound Lakehouse / Warehouse.
The app runs on **Azure Container Apps** over the ontology's existing data
bindings — there is no Fabric or OneLake dependency.

## When to use it

- You have a Loom Ontology (entity types + links + actions) and want a
  purpose-built app for operators to view and edit those objects.
- You need a screen that lists objects, drills into one, shows related objects
  across a link, and lets a user submit a change that writes back to the data.
- You want a governed alternative to a hand-built canvas app: every action is
  recorded as a Thread lineage edge from the app to the ontology.

## Step-by-step in Loom

1. **Create the item.** In your workspace choose **+ New item → Workshop app**
   (Fabric IQ category). The editor opens at `/items/workshop-app/<id>`.
2. **Bind an ontology.** Pick a saved Ontology in the same workspace. Its entity
   types become the object types available to every widget.
3. **Add object views.** Use **Add widget** to place an *object table* (choose
   the **Object type** and the properties to show), then *chart*, *metric*, and
   *markdown* widgets as needed. Paginate rows with **Prev / Next**.
4. **Add variables and events.** Under **Variables**, add a variable a widget
   writes to (e.g. the selected object's key); under **Events**, wire an event
   so selecting a row filters a detail widget "filtered by variables".
5. **Wire a write-back action.** Add an *action* widget, choose the **Action
   kind** (create / update), and map its inputs to object properties. The action
   writes back through the ontology's bound Lakehouse / Warehouse.
6. **Run an action.** Test it in the editor. Loom executes the real backend
   write and records a **Thread edge** from the app to the ontology so lineage
   stays accurate.

## The Azure backend it rides on

- **Compute:** Azure Container Apps hosts the running app.
- **Data:** the ontology's own bindings — an **ADLS Gen2 + Delta lakehouse** or a
  **Synapse warehouse** — so reads and write-back actions hit real Azure data.
- **Lineage:** Loom's Thread graph records app → ontology edges.

## No Fabric required

The app binds to a **Loom Ontology**, not to a Fabric semantic model, and runs
entirely on Azure Container Apps over Azure data. No Fabric capacity, workspace,
or OneLake shortcut is involved on the default path.

## Learn more

- Ontology editor tutorial: `editor-ontology.md`
- Low-code app concepts on Microsoft Learn:
  <https://learn.microsoft.com/power-apps/maker/canvas-apps/getting-started>
