# InfoPath Forms Migration Guide: InfoPath to Power Apps

**Status:** Authored 2026-04-30
**Audience:** SharePoint administrators, Power Platform developers, and business analysts migrating InfoPath forms to Power Apps or SharePoint Online list forms.
**Scope:** Form complexity assessment, Power Apps patterns for common InfoPath scenarios, data connection migration, and form library conversion.

---

## 1. InfoPath migration overview

InfoPath Designer 2013 is the last version of InfoPath, and Microsoft has confirmed it will not receive further development. InfoPath Forms Services, which renders InfoPath forms in the browser on SharePoint Server, is not available in SharePoint Online. All InfoPath forms must be migrated to alternative technologies before moving to SPO.

### Migration target options

| Target                                      | Best for                       | Complexity | Notes                                                            |
| ------------------------------------------- | ------------------------------ | ---------- | ---------------------------------------------------------------- |
| **Power Apps (customized SPO list form)**   | Simple data entry forms        | Low        | Built-in SPO integration; no additional licensing                |
| **Power Apps (canvas app)**                 | Medium complexity forms        | Medium     | Full design control; standard M365 licensing for basic scenarios |
| **Power Apps (model-driven app)**           | Complex business process forms | High       | Requires Dataverse; premium licensing                            |
| **SPO modern list form (no customization)** | Basic list forms               | Very low   | Default SPO experience; no development needed                    |
| **Microsoft Forms**                         | Surveys and feedback forms     | Very low   | Not a replacement for data entry; good for surveys               |

---

## 2. InfoPath form inventory

### Automated form discovery

```powershell
# Find all InfoPath forms across the farm
Add-PSSnapin Microsoft.SharePoint.PowerShell

$infoPathForms = @()

Get-SPSite -Limit All | ForEach-Object {
    $_.AllWebs | ForEach-Object {
        $web = $_

        # Check for InfoPath form libraries
        $_.Lists | Where-Object { $_.BaseTemplate -eq 115 } | ForEach-Object {
            $infoPathForms += [PSCustomObject]@{
                SiteUrl       = $web.Site.Url
                WebUrl        = $web.Url
                ListTitle     = $_.Title
                Type          = "Form Library"
                ItemCount     = $_.ItemCount
                ContentTypes  = ($_.ContentTypes | Select-Object -ExpandProperty Name) -join "; "
                LastModified  = $_.LastItemModifiedDate
            }
        }

        # Check for lists with InfoPath form customization
        $_.Lists | Where-Object {
            $_.ContentTypes | Where-Object { $_.DocumentTemplate -like "*.xsn" }
        } | ForEach-Object {
            $infoPathForms += [PSCustomObject]@{
                SiteUrl       = $web.Site.Url
                WebUrl        = $web.Url
                ListTitle     = $_.Title
                Type          = "List with InfoPath Form"
                ItemCount     = $_.ItemCount
                ContentTypes  = ($_.ContentTypes | Select-Object -ExpandProperty Name) -join "; "
                LastModified  = $_.LastItemModifiedDate
            }
        }
    }
}

$infoPathForms | Export-Csv -Path "C:\Migration\infopath-inventory.csv" -NoTypeInformation
Write-Host "Total InfoPath forms found: $($infoPathForms.Count)"
```

### Form complexity assessment

For each InfoPath form, assess complexity by examining:

| Factor                        | Low complexity               | Medium complexity                         | High complexity                     |
| ----------------------------- | ---------------------------- | ----------------------------------------- | ----------------------------------- |
| **Field count**               | < 20 fields                  | 20-50 fields                              | > 50 fields                         |
| **Views**                     | Single view                  | 2-3 views                                 | 4+ views or print views             |
| **Data connections**          | None or single SPO list      | 2-3 data connections                      | External web services, databases    |
| **Rules**                     | Simple show/hide, validation | Conditional formatting, calculated values | Complex business logic chains       |
| **Code behind**               | None                         | None                                      | C# or VB.NET code behind            |
| **Repeating tables/sections** | None                         | 1-2 repeating sections                    | Complex nested repeating structures |
| **Digital signatures**        | None                         | None                                      | Digital signature required          |
| **Managed code**              | None                         | None                                      | Custom .NET assemblies              |
| **Submit data connections**   | Single SPO list submit       | Multi-target submit                       | Web service, email, database submit |

### Complexity scoring

| Score                      | Classification           | Power Apps effort | Recommended target                                                 |
| -------------------------- | ------------------------ | ----------------- | ------------------------------------------------------------------ |
| All low                    | **Tier 1 -- Simple**     | 4-8 hours         | SPO list form customization (Power Apps)                           |
| Mostly low, some medium    | **Tier 2 -- Standard**   | 2-3 days          | Power Apps canvas app                                              |
| Mix of medium and high     | **Tier 3 -- Complex**    | 1-2 weeks         | Power Apps canvas app + Power Automate                             |
| Mostly high                | **Tier 4 -- Enterprise** | 2-4 weeks         | Power Apps model-driven + Dataverse                                |
| Code behind / managed code | **Tier 5 -- Custom**     | 4-8 weeks         | Custom development (SPFx, Azure, or Power Apps + custom connector) |

---

## 3. Power Apps patterns for common InfoPath scenarios

### Pattern 1: Simple data entry form (Tier 1)

**InfoPath:** Basic form with text fields, dropdowns, date pickers, and a submit button connected to a SharePoint list.

**Power Apps (SPO list form customization):**

1. Navigate to the SharePoint list in SPO
2. Click **Integrate** > **Power Apps** > **Customize forms**
3. Power Apps opens with a form pre-connected to the list
4. Customize field layout, add validation, configure conditional visibility
5. Save and publish -- the form replaces the default SPO list form

Key Power Fx formulas:

```
// Conditional visibility (show field only if Type = "Other")
If(DataCardValue_Type.Selected.Value = "Other", true, false)

// Field validation (require email format)
IsMatch(DataCardValue_Email.Text, Match.Email)

// Default value (current user)
User().FullName

// Default value (today's date)
Today()
```

### Pattern 2: Multi-view form (Tier 2)

**InfoPath:** Form with multiple views (e.g., "New Request" view, "Approval" view, "Summary" view) that switch based on user role or form status.

**Power Apps (canvas app):**

1. Create a canvas app from blank
2. Add multiple screens (one per InfoPath view)
3. Use navigation to switch between screens based on status

```
// Navigate based on form status
Switch(
    ThisItem.Status,
    "New", Navigate(Screen_NewRequest),
    "Pending Approval", Navigate(Screen_Approval),
    "Approved", Navigate(Screen_Summary),
    Navigate(Screen_Default)
)

// Role-based view selection
If(
    LookUp(ApproversList, Email = User().Email, Count(1)) > 0,
    Navigate(Screen_Approval),
    Navigate(Screen_ReadOnly)
)
```

### Pattern 3: Repeating table/section (Tier 2-3)

**InfoPath:** Repeating table for line items (e.g., expense report with multiple line items).

**Power Apps equivalent:**

1. Create a child SharePoint list for line items (parent-child relationship via lookup column)
2. Use a Gallery control in Power Apps to display and edit line items
3. Use a "+" button to add new line items

```
// Add new line item to child list
Patch(
    ExpenseLineItems,
    Defaults(ExpenseLineItems),
    {
        Title: TextInput_Description.Text,
        Amount: Value(TextInput_Amount.Text),
        Category: Dropdown_Category.Selected.Value,
        ExpenseReportID: ThisItem.ID
    }
);
Reset(TextInput_Description);
Reset(TextInput_Amount)

// Calculate total from child items
Sum(
    Filter(ExpenseLineItems, ExpenseReportID = ThisItem.ID),
    Amount
)
```

### Pattern 4: Data connection to external system (Tier 3)

**InfoPath:** Form with data connections to SQL Server, web services, or other external systems.

**Power Apps equivalent:**

1. For SQL Server: Use the SQL Server connector (standard connector)
2. For REST APIs: Use Power Automate with HTTP action, called from Power Apps
3. For legacy SOAP services: Use Power Automate with HTTP action + XML parsing

```
// Call a Power Automate flow from Power Apps to fetch external data
Set(
    varExternalData,
    GetExternalData.Run(TextInput_EmployeeID.Text)
);

// Use the result
Label_EmployeeName.Text = varExternalData.name;
Label_Department.Text = varExternalData.department
```

### Pattern 5: Approval form with status tracking (Tier 2-3)

**InfoPath:** Form submitted for approval, with status tracking and email notifications.

**Power Apps + Power Automate:**

1. Power Apps form submits data to SharePoint list
2. Power Automate flow triggers on list item creation
3. Flow starts approval process, sends notifications
4. Flow updates list item status based on approval response
5. Power Apps form reads status and adjusts view accordingly

---

## 4. Data connection migration

### InfoPath data connection types and Power Apps equivalents

| InfoPath connection type                | Power Apps equivalent                  | Notes                                            |
| --------------------------------------- | -------------------------------------- | ------------------------------------------------ |
| SharePoint list (query)                 | SharePoint connector                   | Direct mapping; built into Power Apps            |
| SharePoint list (submit)                | Patch() function to SharePoint         | Built-in; no additional connector                |
| SQL Server database                     | SQL Server connector                   | Standard connector; on-prem requires gateway     |
| REST web service                        | Power Automate HTTP action             | Premium connector; call from Power Apps via flow |
| SOAP web service                        | Power Automate HTTP action + XML parse | Premium connector; complex mapping               |
| XML file                                | Power Automate + SharePoint file read  | Read XML from SPO library, parse in flow         |
| Email submit                            | Power Automate email action            | Office 365 Outlook connector                     |
| Hosting environment (form load)         | Power Apps context variables           | User(), Param(), ThisItem                        |
| Secondary data sources (dropdown lists) | SharePoint lists or Dataverse tables   | Choices() function or LookUp()                   |
| User profile service                    | Office 365 Users connector             | User(), Office365Users.MyProfile()               |

### On-premises data gateway for hybrid scenarios

If Power Apps forms need to access on-premises SQL Server or file shares during the migration transition:

```powershell
# Install the on-premises data gateway
# Download from https://aka.ms/on-premises-data-gateway-installer

# After installation, register the gateway in Power Platform admin center
# Then configure SQL Server connections in Power Apps using the gateway
```

---

## 5. Form library conversion

InfoPath form libraries store XML data files rendered by InfoPath Forms Services. These have no direct equivalent in SPO.

### Conversion strategies

| Strategy                             | Description                                             | Best for                                                      |
| ------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------- |
| **Convert to SPO list**              | Extract data from XML files into a SharePoint list      | Structured data with consistent schema                        |
| **Convert to Power Apps + SPO list** | Create Power Apps form backed by SPO list; migrate data | Active forms that need ongoing data entry                     |
| **Archive as documents**             | Migrate XML files to a document library as archive      | Historical forms that are read-only                           |
| **Convert to PDF**                   | Render InfoPath forms as PDF for archival               | Legal/compliance requirement for form appearance preservation |

### Extract data from InfoPath XML files

```powershell
# Extract data from InfoPath XML files in a form library
$web = Get-SPWeb "https://sp2016.contoso.com/sites/hr"
$library = $web.Lists["Leave Requests"]

$formData = @()

$library.Items | ForEach-Object {
    $file = $_.File
    $xmlBytes = $file.OpenBinary()
    $xml = [System.Xml.XmlDocument]::new()
    $xml.Load([System.IO.MemoryStream]::new($xmlBytes))

    # Define namespace manager for InfoPath namespace
    $nsm = [System.Xml.XmlNamespaceManager]::new($xml.NameTable)
    $nsm.AddNamespace("my", $xml.DocumentElement.NamespaceURI)

    $formData += [PSCustomObject]@{
        FileName       = $file.Name
        EmployeeName   = $xml.SelectSingleNode("//my:EmployeeName", $nsm)?.InnerText
        StartDate      = $xml.SelectSingleNode("//my:StartDate", $nsm)?.InnerText
        EndDate        = $xml.SelectSingleNode("//my:EndDate", $nsm)?.InnerText
        LeaveType      = $xml.SelectSingleNode("//my:LeaveType", $nsm)?.InnerText
        Status         = $xml.SelectSingleNode("//my:Status", $nsm)?.InnerText
        Created        = $_.File.TimeCreated
        Modified       = $_.File.TimeLastModified
    }
}

$formData | Export-Csv -Path "C:\Migration\leave-requests-data.csv" -NoTypeInformation
```

### Import extracted data to SPO list

```powershell
# Create the target list in SPO and import data
Connect-PnPOnline -Url "https://contoso.sharepoint.com/sites/hr" -Interactive

# Ensure the target list exists with matching columns
$csvData = Import-Csv "C:\Migration\leave-requests-data.csv"

foreach ($row in $csvData) {
    Add-PnPListItem -List "Leave Requests" -Values @{
        "Title"          = $row.EmployeeName
        "StartDate"      = $row.StartDate
        "EndDate"        = $row.EndDate
        "LeaveType"      = $row.LeaveType
        "Status"         = $row.Status
    }
}
```

---

## 6. InfoPath features with no direct Power Apps equivalent

| InfoPath feature               | Workaround in Power Apps                          | Notes                                                    |
| ------------------------------ | ------------------------------------------------- | -------------------------------------------------------- |
| **Print views**                | Power Automate + Word template + PDF              | Generate PDF via Word Online connector in Power Automate |
| **Digital signatures**         | Adobe Sign or DocuSign connector                  | Premium connector; requires third-party subscription     |
| **Merge forms**                | Power Automate + custom logic                     | No native merge; build aggregation in Power Automate     |
| **Form template publishing**   | Power Apps publishing                             | Different publishing model; admin-controlled             |
| **XPath expressions**          | Power Fx formulas                                 | Different syntax; similar capabilities                   |
| **Custom task pane**           | Side panel in Power Apps                          | Supported in canvas apps                                 |
| **Managed code (.NET)**        | Power Automate custom connector or Azure Function | Complex migrations; requires development                 |
| **XML schema enforcement**     | Dataverse table schema                            | Schema enforced at data layer, not form layer            |
| **Browser-enabled deployment** | Default (Power Apps is browser-native)            | All Power Apps are browser-based                         |

---

## 7. Migration execution plan

### Recommended sequence

1. **Tier 1 forms first** (simple list forms): Convert during site migration
2. **Tier 2 forms second** (multi-view, repeating): Build canvas apps in parallel with content migration
3. **Tier 3 forms third** (external connections): Requires Power Automate; build after connectors are configured
4. **Tier 4/5 forms last** (enterprise/custom): Longest lead time; start design early

### Per-form migration checklist

- [ ] Document current form fields, views, and rules
- [ ] Document data connections (source, type, credentials)
- [ ] Document submission behavior (where data goes, what notifications fire)
- [ ] Identify the Power Apps target (list form, canvas app, model-driven)
- [ ] Create the SPO list or Dataverse table with matching schema
- [ ] Build the Power Apps form
- [ ] Recreate data connections as Power Apps connectors or Power Automate flows
- [ ] Recreate validation rules as Power Fx formulas
- [ ] Recreate conditional visibility as Power Fx If() statements
- [ ] Test with sample data
- [ ] Migrate historical data from InfoPath form library
- [ ] User acceptance testing
- [ ] Deploy and decommission InfoPath form

---

## 8. Power Apps licensing for InfoPath replacements

| Scenario                                       | License needed               | Cost           |
| ---------------------------------------------- | ---------------------------- | -------------- |
| Customize SPO list form                        | Included in M365 E3/E5/G3/G5 | $0 additional  |
| Canvas app with SPO data only                  | Included in M365 E3/E5/G3/G5 | $0 additional  |
| Canvas app with premium connectors (SQL, HTTP) | Power Apps Premium           | $20/user/month |
| Model-driven app with Dataverse                | Power Apps Premium           | $20/user/month |
| Canvas app with on-premises data gateway       | Power Apps Premium           | $20/user/month |

!!! tip "Most InfoPath replacements are free"
If the InfoPath form only reads/writes SharePoint list data, the Power Apps replacement is included in M365 licensing at no additional cost. Only forms that connect to external databases, web services, or require Dataverse need premium licensing.

---

## References

- [Power Apps documentation](https://learn.microsoft.com/power-apps/)
- [Customize SharePoint list forms with Power Apps](https://learn.microsoft.com/power-apps/maker/canvas-apps/customize-list-form)
- [Power Apps formulas reference (Power Fx)](https://learn.microsoft.com/power-platform/power-fx/formula-reference)
- [InfoPath retirement FAQ](https://learn.microsoft.com/lifecycle/products/infopath-2013)
- [On-premises data gateway](https://learn.microsoft.com/data-integration/gateway/service-gateway-install)
- [Power Apps pricing](https://powerapps.microsoft.com/pricing/)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
