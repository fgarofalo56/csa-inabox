# Workflow Migration Guide: SharePoint Workflows to Power Automate

**Status:** Authored 2026-04-30
**Audience:** SharePoint administrators, Power Platform developers, and workflow architects migrating SharePoint 2010/2013 Workflows and Nintex Workflows to Power Automate.
**Scope:** Assessment with SMAT, workflow complexity tiers, Power Automate patterns for common workflows, and Nintex migration considerations.

---

## 1. Workflow migration overview

SharePoint 2010 Workflows and SharePoint 2013 Workflows are deprecated and not supported in SharePoint Online. All workflow functionality must be migrated to **Power Automate** (formerly Microsoft Flow). There is no automated migration tool -- each workflow requires manual assessment, redesign, and rebuild in Power Automate.

!!! danger "SharePoint workflows are fully deprecated" - **SharePoint 2010 Workflows:** Retired from SPO on November 1, 2020. Cannot run in SPO. - **SharePoint 2013 Workflows:** Retired from SPO on April 2, 2024. Cannot run in SPO. - **SharePoint Designer Workflows:** SharePoint Designer 2013 is the last version; no longer updated. Designer workflows use the 2010 or 2013 workflow engine. - There is **no migration tool** from SP Workflows to Power Automate. Each workflow must be manually redesigned.

---

## 2. Workflow inventory and assessment

### SMAT workflow assessment

```powershell
# Run SMAT with workflow focus
.\SMAT.exe -SiteURL https://sharepoint.contoso.com `
    -OutputFolder C:\SMAT-Results

# Key SMAT reports for workflows:
# - WorkflowAssociations2010.csv -- SP 2010 workflows
# - WorkflowAssociations2013.csv -- SP 2013 workflows
# - WorkflowRunning2010.csv -- Currently running 2010 instances
# - WorkflowRunning2013.csv -- Currently running 2013 instances
```

### Manual workflow inventory

```powershell
# Inventory all workflow associations across the farm
Add-PSSnapin Microsoft.SharePoint.PowerShell

$workflowInventory = @()

Get-SPSite -Limit All | ForEach-Object {
    $_.AllWebs | ForEach-Object {
        $web = $_

        # Site-level workflows
        $web.WorkflowAssociations | ForEach-Object {
            $workflowInventory += [PSCustomObject]@{
                SiteUrl           = $web.Site.Url
                WebUrl            = $web.Url
                Scope             = "Web"
                ListTitle         = "N/A"
                WorkflowName      = $_.Name
                AssociationId     = $_.Id
                IsEnabled         = $_.Enabled
                IsDeclarative     = $_.IsDeclarative
                Created           = $_.Created
                Modified          = $_.Modified
                RunningInstances  = $_.RunningInstances
                Platform          = "Unknown"
            }
        }

        # List-level workflows
        $web.Lists | ForEach-Object {
            $list = $_
            $_.WorkflowAssociations | ForEach-Object {
                $workflowInventory += [PSCustomObject]@{
                    SiteUrl           = $web.Site.Url
                    WebUrl            = $web.Url
                    Scope             = "List"
                    ListTitle         = $list.Title
                    WorkflowName      = $_.Name
                    AssociationId     = $_.Id
                    IsEnabled         = $_.Enabled
                    IsDeclarative     = $_.IsDeclarative
                    Created           = $_.Created
                    Modified          = $_.Modified
                    RunningInstances  = $_.RunningInstances
                    Platform          = "Unknown"
                }
            }
        }
    }
}

$workflowInventory | Export-Csv -Path "C:\Migration\workflow-inventory.csv" -NoTypeInformation
Write-Host "Total workflows found: $($workflowInventory.Count)"
```

### Workflow complexity classification

| Tier                   | Complexity | Characteristics                                                          | Power Automate effort  |
| ---------------------- | ---------- | ------------------------------------------------------------------------ | ---------------------- |
| **Tier 1 -- Simple**   | Low        | Approval, notification, status update                                    | 2-4 hours per workflow |
| **Tier 2 -- Standard** | Medium     | Multi-step approval, conditional logic, email with dynamic content       | 1-2 days per workflow  |
| **Tier 3 -- Complex**  | High       | Parallel approvals, loops, external web service calls, state machine     | 3-5 days per workflow  |
| **Tier 4 -- Custom**   | Very high  | Custom code activities, complex business logic, multi-system integration | 1-2 weeks per workflow |

---

## 3. Power Automate patterns for common SharePoint workflows

### Pattern 1: Simple approval workflow

**Source (SP 2010/2013):** Out-of-the-box approval workflow on a document library.

**Power Automate equivalent:**

```json
{
    "trigger": "When an item is created or modified",
    "conditions": "Status equals 'Pending Approval'",
    "actions": [
        "Start and wait for an approval (Approve/Reject)",
        "If approved: Update item status to 'Approved'",
        "If rejected: Update item status to 'Rejected', send rejection email"
    ]
}
```

Steps to build in Power Automate:

1. Create a new **Automated cloud flow**
2. Trigger: **When an item is created or modified** (SharePoint connector)
3. Condition: Check if Status column equals "Pending Approval"
4. Action: **Start and wait for an approval** (Approvals connector)
5. Condition: Check approval outcome
6. If approved: **Update item** (set Status to "Approved")
7. If rejected: **Update item** (set Status to "Rejected") + **Send an email**

### Pattern 2: Multi-level approval

**Source:** Custom SP Designer workflow with sequential approvals (Manager then Director then VP).

**Power Automate equivalent:**

1. Trigger: **When an item is created** (SharePoint)
2. **Get manager** (Office 365 Users connector -- get user's manager)
3. **Start and wait for an approval** -- Manager level
4. If approved: **Get manager's manager** (Director)
5. **Start and wait for an approval** -- Director level
6. If approved and amount > $50,000: **Start and wait for an approval** -- VP level
7. Update item status at each step
8. Send notification emails at each step

### Pattern 3: Document review and feedback collection

**Source:** Collect Feedback workflow (SP 2010 OOB).

**Power Automate equivalent:**

1. Trigger: **When a file is created in a folder** (SharePoint)
2. **Get items** from a reviewers list or use a SharePoint group
3. **Apply to each** reviewer:
    - **Start and wait for an approval** (Custom Responses: "Approve with Comments" / "Request Changes" / "Abstain")
    - **Create item** in a feedback tracking list (reviewer, response, comments, date)
4. After all reviewers respond: **Send email** to document owner with aggregated feedback
5. **Update item** metadata with review status

### Pattern 4: Conditional routing based on metadata

**Source:** SP Designer workflow with multiple conditions routing to different approvers based on department, amount, or category.

**Power Automate equivalent:**

1. Trigger: **When an item is created** (SharePoint)
2. **Switch** on Department column:
    - Case "Finance": Route to Finance Manager
    - Case "HR": Route to HR Manager
    - Case "Legal": Route to Legal Manager
    - Default: Route to General Manager
3. **Start and wait for an approval** with the selected approver
4. Update item status

### Pattern 5: Scheduled recurring workflow

**Source:** SP 2013 workflow with a pause/loop pattern that runs weekly.

**Power Automate equivalent:**

1. Trigger: **Recurrence** (Schedule connector -- every Monday at 8:00 AM)
2. **Get items** from SharePoint list (filter: Status eq 'Active')
3. **Apply to each** item:
    - Check due date: if due date is within 7 days, send reminder email
    - If overdue: escalate to manager, update status to "Overdue"
4. **Send email** summary to list owner with counts

---

## 4. SharePoint Designer workflow migration

SharePoint Designer (SPD) workflows are the most common type found on-premises. They range from simple email notifications to complex multi-step processes.

### SPD action to Power Automate mapping

| SPD action                | Power Automate equivalent         | Notes                                                    |
| ------------------------- | --------------------------------- | -------------------------------------------------------- |
| Send an email             | Send an email (V2)                | Use Office 365 Outlook connector                         |
| Update list item          | Update item (SharePoint)          | Direct mapping                                           |
| Create list item          | Create item (SharePoint)          | Direct mapping                                           |
| Set field in current item | Update item (SharePoint)          | Direct mapping                                           |
| Log to history list       | Compose + Create item in log list | No direct history list; create a custom log              |
| Pause for duration        | Delay                             | Direct mapping (minutes, hours, days)                    |
| Pause until date          | Delay until                       | Direct mapping                                           |
| Set workflow status       | Update item (status column)       | Use a custom status column                               |
| Assign a task             | Start and wait for an approval    | Approvals connector replaces task-based assignments      |
| Call HTTP web service     | HTTP action                       | Premium connector; requires Power Automate per-user plan |
| Dictionary operations     | Compose + Parse JSON              | JSON operations replace dictionary                       |
| Loop with condition       | Do Until / Apply to each          | Direct mapping                                           |

---

## 5. Nintex workflow migration

Nintex for SharePoint on-premises is widely deployed. Nintex offers **Nintex Workflow Cloud** and **Nintex for Microsoft 365** as cloud migration targets.

### Migration options for Nintex workflows

| Option                       | Description                                   | Best for                                               |
| ---------------------------- | --------------------------------------------- | ------------------------------------------------------ |
| **Nintex for Microsoft 365** | Nintex's own cloud platform                   | Organizations committed to Nintex; complex workflows   |
| **Power Automate**           | Microsoft's native workflow platform          | Organizations standardizing on M365; simpler workflows |
| **Hybrid**                   | Nintex for complex, Power Automate for simple | Phased migration; cost optimization                    |

### Nintex action to Power Automate mapping

| Nintex action      | Power Automate equivalent                         | Notes                                       |
| ------------------ | ------------------------------------------------- | ------------------------------------------- |
| Request approval   | Start and wait for an approval                    | Approvals connector                         |
| Send notification  | Send an email (V2)                                | Office 365 Outlook connector                |
| Assign flexi task  | Start and wait for an approval (custom responses) | Custom approval responses                   |
| Query list         | Get items (SharePoint)                            | OData filter support                        |
| Update item        | Update item (SharePoint)                          | Direct mapping                              |
| Create item        | Create item (SharePoint)                          | Direct mapping                              |
| Call web service   | HTTP action                                       | Premium connector                           |
| Regular expression | Compose with expressions                          | Power Automate expressions                  |
| Generate document  | Word Online (Business) connector                  | Populate Word template                      |
| Convert to PDF     | Word Online (Business) - Convert                  | Built-in PDF conversion                     |
| State machine      | Manually manage state with variables              | No native state machine; use status columns |

### Nintex assessment script

```powershell
# Export Nintex workflow definitions for assessment
# Requires Nintex Workflow PowerShell module or direct web service calls

$webUrl = "https://sp2016.contoso.com/sites/finance"
$web = Get-SPWeb $webUrl

# Nintex stores workflow definitions in the NintexWorkflow content database
# Export via Nintex Administration page or use the Nintex Web Service

# Alternative: Use Nintex's built-in export to NWP files
# Administration > Nintex Workflow Management > Export Workflow (per workflow)
```

---

## 6. Migration execution strategy

### Phase 1: Inventory and classify (week 1-2)

1. Run SMAT workflow reports
2. Run manual inventory script
3. Classify each workflow into complexity tiers
4. Identify workflows that can be retired (unused, redundant, obsolete)
5. Prioritize by business criticality

### Phase 2: Design Power Automate replacements (week 3-6)

1. Document the business process for each workflow (not the technical implementation)
2. Design Power Automate flows that implement the business process
3. Identify premium connectors needed (HTTP, custom connectors)
4. Plan licensing (standard vs premium flows)
5. Create flow design documents for Tier 3 and Tier 4 workflows

### Phase 3: Build and test (week 7-14)

1. Build flows in a development environment
2. Test with representative data
3. Validate approval routing, email content, status updates
4. Test error handling and edge cases
5. User acceptance testing with workflow owners

### Phase 4: Deploy and cutover (week 15-18)

1. Deploy flows to production SPO environment
2. Run parallel with on-premises workflows for 1-2 weeks (where possible)
3. Disable on-premises workflows
4. Monitor Power Automate flow runs for errors
5. Document known issues and workarounds

### Handling in-flight workflow instances

!!! warning "Running workflow instances cannot be migrated"
Any SharePoint workflow instances that are running at the time of migration will be lost. Plan the cutover to minimize in-flight instances:

    1. Communicate a freeze date to workflow users
    2. Allow running instances to complete before cutover
    3. For long-running instances, manually complete the process and restart in Power Automate
    4. Document any instances that cannot be completed before cutover

---

## 7. Power Automate licensing considerations

| Plan                       | Included with    | Limits                                                    | Best for                                 |
| -------------------------- | ---------------- | --------------------------------------------------------- | ---------------------------------------- |
| **M365 included**          | M365 E3/E5/G3/G5 | Standard connectors only; 6,000 actions/day               | Simple approvals, notifications          |
| **Power Automate Premium** | $15/user/month   | Premium connectors, custom connectors, 40,000 actions/day | Complex workflows with external systems  |
| **Power Automate Process** | $150/bot/month   | Unattended RPA, premium connectors                        | Automated processes without user context |

!!! note "M365 included flows cover most scenarios"
The majority of SharePoint workflow replacements use only standard connectors (SharePoint, Outlook, Approvals, Teams). Only workflows that call external web services, custom APIs, or require RPA need premium licensing.

---

## 8. Testing and validation

### Flow testing checklist

- [ ] Trigger fires correctly on item create/modify/delete
- [ ] Approval routing reaches correct approvers
- [ ] Approval responses update item status correctly
- [ ] Email notifications include correct content and formatting
- [ ] Conditional logic routes correctly for all branches
- [ ] Error handling captures and reports failures
- [ ] Parallel branches execute correctly
- [ ] Loops terminate correctly (no infinite loops)
- [ ] Performance is acceptable (flow completes within expected time)
- [ ] Flow runs are logged and visible in Power Automate analytics

---

## References

- [Power Automate documentation](https://learn.microsoft.com/power-automate/)
- [SharePoint workflow retirement](https://learn.microsoft.com/sharepoint/dev/transform/modernize-workflows)
- [Power Automate SharePoint connector](https://learn.microsoft.com/connectors/sharepointonline/)
- [Power Automate approvals](https://learn.microsoft.com/power-automate/get-started-approvals)
- [Nintex for Microsoft 365](https://www.nintex.com/process-automation/microsoft-365/)
- [Power Automate licensing](https://learn.microsoft.com/power-automate/pricing-billing-questions)
- [SMAT workflow reports](https://learn.microsoft.com/sharepointmigration/overview-of-the-sharepoint-migration-assessment-tool)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
