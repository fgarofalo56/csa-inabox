# Customization Migration Guide: Farm Solutions to SPFx

**Status:** Authored 2026-04-30
**Audience:** SharePoint developers, solution architects, and IT administrators migrating custom SharePoint solutions from on-premises to SharePoint Online.
**Scope:** Farm solutions, sandbox solutions, SharePoint Designer customizations, custom web parts, master pages, and their SPFx/modern equivalents.

---

## 1. Customization migration overview

SharePoint Online does not support server-side code execution. Farm solutions (WSP files deployed to the server), sandbox solutions with managed code, and SharePoint Designer customizations that rely on server-side features must be migrated to the **SharePoint Framework (SPFx)**, **Power Platform**, or **Azure services**.

### Migration target by customization type

| On-premises customization                 | Primary SPO target                   | Alternative target                              |
| ----------------------------------------- | ------------------------------------ | ----------------------------------------------- |
| Farm solution (web parts)                 | SPFx web parts                       | Power Apps embedded in SPO page                 |
| Farm solution (timer jobs)                | Azure Functions (timer trigger)      | Power Automate scheduled flows                  |
| Farm solution (event receivers)           | SPFx extensions + webhooks           | Power Automate triggers                         |
| Farm solution (application pages)         | SPFx full-page applications          | Power Apps standalone app                       |
| Farm solution (custom service apps)       | Azure App Service + Microsoft Graph  | Custom API on Azure                             |
| Sandbox solution (web parts)              | SPFx web parts                       | Power Apps                                      |
| Sandbox solution (event receivers)        | SPFx extensions + webhooks           | Power Automate                                  |
| SP Designer workflows                     | Power Automate                       | See [Workflow Migration](workflow-migration.md) |
| SP Designer custom pages                  | Modern pages with SPFx web parts     | Communication site pages                        |
| Custom master pages                       | Modern theming + SPFx app customizer | JSON themes                                     |
| Custom page layouts                       | Modern page sections + web parts     | SPFx section backgrounds                        |
| Custom CSS                                | Modern theming (JSON)                | SPFx app customizer for advanced CSS            |
| JavaScript injection (CEWP/Script Editor) | SPFx extensions (app customizer)     | SPFx web parts                                  |
| Custom web parts (server-side)            | SPFx web parts (client-side)         | Power Apps                                      |

---

## 2. Farm solution assessment

### Inventory farm solutions

```powershell
Add-PSSnapin Microsoft.SharePoint.PowerShell

# List all farm solutions
Get-SPSolution | ForEach-Object {
    [PSCustomObject]@{
        Name              = $_.Name
        SolutionId        = $_.SolutionId
        Deployed          = $_.Deployed
        DeployedWebApps   = ($_.DeployedWebApplications | Select-Object -ExpandProperty Url) -join "; "
        ContainsGlobalAssembly = $_.ContainsGlobalAssembly
        ContainsWebAppResource = $_.ContainsWebApplicationResource
        ContainsCasPolicy = $_.ContainsCasPolicy
        LastModified      = $_.LastOperationEndTime
    }
} | Export-Csv -Path "C:\Migration\farm-solutions.csv" -NoTypeInformation

# List sandbox solutions per site collection
Get-SPSite -Limit All | ForEach-Object {
    $site = $_
    $_.Solutions | ForEach-Object {
        [PSCustomObject]@{
            SiteUrl    = $site.Url
            Name       = $_.Name
            SolutionId = $_.SolutionId
            Status     = $_.Status
            HasAssembly = $_.HasAssembly
        }
    }
} | Export-Csv -Path "C:\Migration\sandbox-solutions.csv" -NoTypeInformation
```

### WSP contents analysis

```powershell
# Extract and analyze a WSP file (it is a CAB file)
$wspPath = "C:\Solutions\MyCustomSolution.wsp"
$extractPath = "C:\Solutions\Extracted"

# Extract using expand (WSP is a CAB)
expand $wspPath -F:* $extractPath

# Analyze the manifest
[xml]$manifest = Get-Content "$extractPath\manifest.xml"

# List assemblies
$manifest.Solution.Assemblies.Assembly | ForEach-Object {
    [PSCustomObject]@{
        Location      = $_.Location
        DeploymentTarget = $_.DeploymentTarget
    }
}

# List features
$manifest.Solution.Features.Feature | ForEach-Object {
    [PSCustomObject]@{
        Location = $_.Location
    }
}
```

### Complexity classification for farm solutions

| Complexity       | Characteristics                                                          | SPFx conversion effort                    |
| ---------------- | ------------------------------------------------------------------------ | ----------------------------------------- |
| **Simple**       | Visual web parts with HTML/JS only, no server-side logic                 | 1-3 days per web part                     |
| **Medium**       | Web parts with SharePoint CSOM/REST API calls, basic business logic      | 3-5 days per web part                     |
| **Complex**      | Web parts with server-side object model, SQL connections, complex logic  | 1-2 weeks per web part                    |
| **Very complex** | Full-trust code, custom service applications, GAC assemblies             | 2-4 weeks; may require Azure services     |
| **Not portable** | Deep server-side integration (ULS logging, health analyzer, admin pages) | Redesign from scratch with Azure services |

---

## 3. SPFx development fundamentals

### SPFx project setup

```bash
# Install Node.js LTS (18.x or later)
# Install Yeoman and SPFx generator
npm install -g yo @microsoft/generator-sharepoint

# Create a new SPFx web part project
yo @microsoft/sharepoint

# Prompts:
# Solution name: my-custom-webpart
# Target: SharePoint Online only
# Type: WebPart
# Framework: React

# Build and test locally
gulp serve
```

### SPFx web part structure

```typescript
// src/webparts/myWebPart/MyWebPart.ts
import { BaseClientSideWebPart } from "@microsoft/sp-webpart-base";
import { SPHttpClient, SPHttpClientResponse } from "@microsoft/sp-http";

export default class MyWebPart extends BaseClientSideWebPart<IMyWebPartProps> {
    public render(): void {
        // Render the React component or raw HTML
        const element = React.createElement(MyComponent, {
            context: this.context,
            listTitle: this.properties.listTitle,
        });
        ReactDom.render(element, this.domElement);
    }

    // Replace server-side object model calls with REST API
    private async getListItems(): Promise<any[]> {
        const response: SPHttpClientResponse =
            await this.context.spHttpClient.get(
                `${this.context.pageContext.web.absoluteUrl}/_api/web/lists/getbytitle('${this.properties.listTitle}')/items`,
                SPHttpClient.configurations.v1,
            );
        const data = await response.json();
        return data.value;
    }
}
```

### Server-side to client-side API mapping

| Server-side (on-prem)                  | Client-side (SPFx)                                       | Notes                                   |
| -------------------------------------- | -------------------------------------------------------- | --------------------------------------- |
| `SPContext.Current.Web`                | `this.context.pageContext.web`                           | Web context from SPFx                   |
| `SPList list = web.Lists["Title"]`     | REST: `/_api/web/lists/getbytitle('Title')`              | SPHttpClient or PnPjs                   |
| `list.Items`                           | REST: `/_api/web/lists/getbytitle('Title')/items`        | SPHttpClient or PnPjs                   |
| `list.Items.Add()`                     | REST POST to `/_api/web/lists/getbytitle('Title')/items` | Include X-RequestDigest header          |
| `item.Update()`                        | REST MERGE to item endpoint                              | Include If-Match header for concurrency |
| `SPSecurity.RunWithElevatedPrivileges` | App-only auth (Azure AD app registration)                | Different security model                |
| `web.CurrentUser`                      | `this.context.pageContext.user`                          | Current user context                    |
| `SPUtility.SendEmail`                  | Microsoft Graph API: `/me/sendMail`                      | Requires Graph API permissions          |
| `SPTimerJob`                           | Azure Functions (timer trigger)                          | See section 5                           |
| `SPEventReceiver`                      | SPO webhooks + Azure Function                            | See section 6                           |
| `SPUserProfileManager`                 | Microsoft Graph API: `/users/{id}`                       | User profiles via Graph                 |

---

## 4. SharePoint Designer customization migration

### Custom pages and views

SharePoint Designer custom pages (aspx pages with custom markup) do not work in modern SPO. Migration options:

1. **Modern page equivalent:** Recreate the page using modern web parts and page sections
2. **SPFx full-page application:** For complex custom pages, create an SPFx extension hosted in a full-page experience
3. **Power Apps:** For data-driven pages, embed a Power Apps canvas app in a modern page

### Custom XSLT list views

XSLT Data View Web Parts (DVWPs) created in SharePoint Designer are not supported in modern SPO.

| DVWP scenario                 | Modern equivalent                             |
| ----------------------------- | --------------------------------------------- |
| Custom list rendering         | Modern list with column formatting (JSON)     |
| Aggregated views (cross-list) | Highlighted content web part or SPFx web part |
| Custom grouping/sorting       | Modern list views with grouping               |
| Conditional formatting        | Column formatting with JSON                   |
| Custom forms                  | Power Apps list form customization            |

### Column formatting with JSON (replacing XSLT)

```json
{
    "$schema": "https://developer.microsoft.com/json-schemas/sp/v2/column-formatting.schema.json",
    "elmType": "div",
    "style": {
        "background-color": "=if(@currentField == 'Critical', '#FDE7E9', if(@currentField == 'High', '#FFF4CE', '#DFF6DD'))"
    },
    "children": [
        {
            "elmType": "span",
            "txtContent": "@currentField",
            "style": {
                "font-weight": "600"
            }
        }
    ]
}
```

---

## 5. Timer job replacement with Azure Functions

### On-premises timer job pattern

```csharp
// On-premises: Custom timer job
public class DailyReportJob : SPJobDefinition
{
    public override void Execute(Guid targetInstanceId)
    {
        using (SPSite site = new SPSite("https://sharepoint.contoso.com/sites/reports"))
        {
            SPWeb web = site.RootWeb;
            SPList list = web.Lists["Daily Reports"];
            // Process items, generate reports, send emails
        }
    }
}
```

### Azure Functions replacement

```csharp
// Azure Function: Timer-triggered (equivalent)
[FunctionName("DailyReportJob")]
public static async Task Run(
    [TimerTrigger("0 0 2 * * *")] TimerInfo timer, // Daily at 2:00 AM
    ILogger log)
{
    var credential = new DefaultAzureCredential();
    var graphClient = new GraphServiceClient(credential);

    // Use Microsoft Graph API instead of server-side object model
    var items = await graphClient.Sites["{site-id}"]
        .Lists["{list-id}"]
        .Items
        .Request()
        .GetAsync();

    foreach (var item in items)
    {
        // Process items
        log.LogInformation($"Processing: {item.Fields.AdditionalData["Title"]}");
    }

    // Send email via Graph API
    await graphClient.Users["{user-id}"]
        .SendMail(message, false)
        .Request()
        .PostAsync();
}
```

---

## 6. Event receiver replacement with webhooks

### On-premises event receiver

```csharp
// On-premises: Item event receiver
public class DocumentEventReceiver : SPItemEventReceiver
{
    public override void ItemAdded(SPItemEventProperties properties)
    {
        SPListItem item = properties.ListItem;
        // Custom logic when document is added
        item["ReviewStatus"] = "Pending";
        item.Update();
    }
}
```

### SPO webhook + Azure Function replacement

```csharp
// Step 1: Register webhook on SPO list
// POST https://contoso.sharepoint.com/sites/docs/_api/web/lists('{list-id}')/subscriptions
// Body: { "resource": "list-url", "notificationUrl": "https://my-function.azurewebsites.net/api/webhook", "expirationDateTime": "2027-01-01" }

// Step 2: Azure Function to handle webhook
[FunctionName("SharePointWebhook")]
public static async Task<IActionResult> Run(
    [HttpTrigger(AuthorizationLevel.Function, "post")] HttpRequest req,
    ILogger log)
{
    // Handle validation handshake
    string validationToken = req.Query["validationtoken"];
    if (!string.IsNullOrEmpty(validationToken))
        return new OkObjectResult(validationToken);

    // Process notification
    string body = await new StreamReader(req.Body).ReadToEndAsync();
    var notification = JsonConvert.DeserializeObject<WebhookNotification>(body);

    // Get changed items using GetChanges API
    // Process each change
    return new OkResult();
}
```

---

## 7. Master page and branding migration

### Modern theming (replacing master pages)

```powershell
# Create a custom theme using PnP PowerShell
Connect-PnPOnline -Url "https://contoso-admin.sharepoint.com" -Interactive

$theme = @{
    "themePrimary"         = "#0078d4"
    "themeLighterAlt"      = "#f3f9fd"
    "themeLighter"         = "#d0e7f8"
    "themeLight"           = "#a9d3f2"
    "themeTertiary"        = "#5ba9e5"
    "themeSecondary"       = "#1a86d9"
    "themeDarkAlt"         = "#006cbe"
    "themeDark"            = "#005ba1"
    "themeDarker"          = "#004377"
    "neutralLighterAlt"    = "#faf9f8"
    "neutralLighter"       = "#f3f2f1"
    "neutralLight"         = "#edebe9"
    "neutralQuaternaryAlt" = "#e1dfdd"
    "neutralQuaternary"    = "#d0d0d0"
    "neutralTertiaryAlt"   = "#c8c6c4"
    "neutralTertiary"      = "#a19f9d"
    "neutralSecondary"     = "#605e5c"
    "neutralPrimaryAlt"    = "#3b3a39"
    "neutralPrimary"       = "#323130"
    "neutralDark"          = "#201f1e"
    "black"                = "#000000"
    "white"                = "#ffffff"
}

Add-PnPTenantTheme -Identity "Contoso Corporate" -Palette $theme -IsInverted $false
```

### SPFx application customizer (header/footer)

For branding elements that require more than JSON themes (custom header, footer, notification bar):

```typescript
// SPFx Application Customizer for custom header/footer
import {
    BaseApplicationCustomizer,
    PlaceholderName,
} from "@microsoft/sp-application-base";

export default class HeaderFooterCustomizer extends BaseApplicationCustomizer<IHeaderFooterProps> {
    public onInit(): Promise<void> {
        // Render custom header
        const headerPlaceholder =
            this.context.placeholderProvider.tryCreateContent(
                PlaceholderName.Top,
            );

        if (headerPlaceholder) {
            headerPlaceholder.domElement.innerHTML = `
        <div class="custom-header">
          <img src="/sites/branding/logo.png" alt="Contoso" />
          <span>Contoso Intranet</span>
        </div>
      `;
        }

        // Render custom footer
        const footerPlaceholder =
            this.context.placeholderProvider.tryCreateContent(
                PlaceholderName.Bottom,
            );

        if (footerPlaceholder) {
            footerPlaceholder.domElement.innerHTML = `
        <div class="custom-footer">
          <span>&copy; 2026 Contoso. All rights reserved.</span>
        </div>
      `;
        }

        return Promise.resolve();
    }
}
```

---

## 8. Deployment and governance

### SPFx solution deployment

```powershell
# Build and package SPFx solution
gulp bundle --ship
gulp package-solution --ship

# Deploy to tenant app catalog
Connect-PnPOnline -Url "https://contoso.sharepoint.com/sites/appcatalog" -Interactive

Add-PnPApp -Path ".\sharepoint\solution\my-webpart.sppkg" `
    -Scope Tenant `
    -Publish `
    -Overwrite

# Deploy to a specific site
Install-PnPApp -Identity "my-webpart-client-side-solution" -Scope Site
```

### Governance for custom solutions in SPO

| Control                                | Implementation                                                      |
| -------------------------------------- | ------------------------------------------------------------------- |
| App catalog access                     | Restrict who can upload to tenant app catalog                       |
| Site collection app catalogs           | Enable per-site catalogs for isolated deployments                   |
| API permissions                        | Review and approve Graph API permissions in SharePoint admin center |
| ALM (Application Lifecycle Management) | Use Azure DevOps or GitHub Actions for CI/CD                        |
| Testing                                | SPFx unit testing with Jest; integration testing with Playwright    |
| Monitoring                             | Application Insights integration for SPFx telemetry                 |

---

## 9. Solutions with no SPFx equivalent

Some farm solution capabilities have no client-side equivalent and require cloud services:

| Capability                      | Cloud alternative                             | Notes                                                   |
| ------------------------------- | --------------------------------------------- | ------------------------------------------------------- |
| Custom search crawl connectors  | Microsoft Graph connectors                    | Index external content in Microsoft Search              |
| Custom authentication providers | Entra ID (Azure AD)                           | SAML, OIDC, custom providers via Entra                  |
| Server-side file processing     | Azure Functions + Azure Blob                  | Process files uploaded to SPO via webhooks              |
| Custom logging (ULS)            | Application Insights                          | Centralized telemetry for SPFx and Azure Functions      |
| Health monitoring rules         | Azure Monitor alerts                          | Custom health checks via Azure Monitor                  |
| Custom Central Admin pages      | Microsoft 365 admin center + custom admin app | No extensibility in M365 admin center; build standalone |

---

## References

- [SharePoint Framework documentation](https://learn.microsoft.com/sharepoint/dev/spfx/sharepoint-framework-overview)
- [SPFx web part development](https://learn.microsoft.com/sharepoint/dev/spfx/web-parts/overview-client-side-web-parts)
- [SPFx extensions](https://learn.microsoft.com/sharepoint/dev/spfx/extensions/overview-extensions)
- [SharePoint webhooks](https://learn.microsoft.com/sharepoint/dev/apis/webhooks/overview-sharepoint-webhooks)
- [Azure Functions documentation](https://learn.microsoft.com/azure/azure-functions/)
- [Microsoft Graph API](https://learn.microsoft.com/graph/overview)
- [PnP SPFx controls](https://pnp.github.io/sp-dev-fx-controls-react/)
- [Modern theming](https://learn.microsoft.com/sharepoint/dev/declarative-customization/site-theming/sharepoint-site-theming-overview)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
