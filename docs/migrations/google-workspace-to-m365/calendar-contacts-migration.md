# Calendar and Contacts Migration: Google to Outlook

**Status:** Authored 2026-04-30
**Audience:** M365 administrators and migration engineers handling Google Calendar and Contacts migration to Exchange Online / Outlook.
**Scope:** Calendar event migration, recurring event handling, room/resource migration, contact migration, delegation, and Google Calendar interop considerations.

---

## Overview

Calendar and contact migration is typically handled alongside email migration using the Google Workspace migration feature in Exchange Admin Center (EAC). When configured for Google Workspace migration, the migration batch migrates email, calendar events, and contacts in a single pass.

**Key consideration:** Calendar migration is time-sensitive. Migrating calendar data early gives users their schedules in Outlook before the email cutover, reducing day-one confusion.

---

## Calendar migration methods

| Method                                 | Calendar support                   | Contact support | Notes                                             |
| -------------------------------------- | ---------------------------------- | --------------- | ------------------------------------------------- |
| **Google Workspace migration (EAC)**   | Yes (events, recurring, attendees) | Yes             | Recommended; part of email migration batch        |
| **IMAP migration**                     | No                                 | No              | Email only; does not support calendar or contacts |
| **FastTrack**                          | Yes                                | Yes             | Microsoft-managed; recommended for 150+ seats     |
| **BitTitan MigrationWiz**              | Yes                                | Yes             | Third-party; granular scheduling                  |
| **Google Calendar export (ICS)**       | Manual export                      | No              | Last resort; no automated mapping                 |
| **Google Contacts export (CSV/vCard)** | No                                 | Manual export   | Last resort; no automated mapping                 |

### Recommendation

Use the **Google Workspace migration in EAC** for calendar and contacts. It is included in the email migration batch and provides the best fidelity for calendar events, recurring patterns, and attendee lists.

---

## Calendar event migration

### What migrates

| Calendar feature               | Migration support  | Notes                                                              |
| ------------------------------ | ------------------ | ------------------------------------------------------------------ |
| **Single events**              | Migrated           | Title, time, location, description, attendees                      |
| **Recurring events**           | Migrated           | Daily, weekly, monthly, yearly patterns preserved                  |
| **All-day events**             | Migrated           | Direct mapping to Outlook all-day events                           |
| **Attendees**                  | Migrated           | Attendee list with response status (accepted, declined, tentative) |
| **Event location**             | Migrated           | Text location preserved; room booking handled separately           |
| **Event description**          | Migrated           | Rich text preserved where possible                                 |
| **Event attachments**          | Migrated           | Attachments included with calendar events                          |
| **Event reminders**            | Migrated           | Default reminder mapped to Outlook reminder                        |
| **Event color coding**         | Partially migrated | Google event colors map to Outlook categories where possible       |
| **Free/busy status**           | Migrated           | Busy, free, tentative, out of office                               |
| **Private events**             | Migrated           | Privacy flag preserved                                             |
| **Recurring event exceptions** | Migrated           | Modified instances of recurring events preserved                   |

### What does not migrate

| Calendar feature                         | Reason                                                  | Workaround                                         |
| ---------------------------------------- | ------------------------------------------------------- | -------------------------------------------------- |
| **Google Meet links in events**          | Google Meet links become non-functional after migration | Users add Teams meeting links to events in Outlook |
| **Google Calendar appointment slots**    | No direct equivalent in migration                       | Rebuild using Microsoft Bookings                   |
| **Google Calendar tasks (Google Tasks)** | Different product; not part of Calendar migration       | Export Google Tasks; import to Microsoft To Do     |
| **Calendar subscriptions (ICS feeds)**   | Subscriptions are user-configured                       | Users re-subscribe in Outlook                      |
| **Event goal tracking**                  | Google-specific feature                                 | No direct equivalent in Outlook                    |

### Recurring event pattern mapping

| Google Calendar pattern   | Outlook equivalent            | Notes                                                    |
| ------------------------- | ----------------------------- | -------------------------------------------------------- |
| Daily (every N days)      | Daily recurrence              | Direct mapping                                           |
| Weekly (specific days)    | Weekly recurrence             | Direct mapping                                           |
| Monthly (day of month)    | Monthly recurrence            | Direct mapping                                           |
| Monthly (nth weekday)     | Monthly recurrence (relative) | Direct mapping                                           |
| Yearly (date)             | Yearly recurrence             | Direct mapping                                           |
| Custom (complex patterns) | Custom recurrence             | Most patterns map; edge cases may need manual recreation |
| No end date               | No end date                   | Direct mapping                                           |
| End after N occurrences   | End after N occurrences       | Direct mapping                                           |
| End by date               | End by date                   | Direct mapping                                           |

---

## Room and resource migration

### Google Workspace room resources

Google Workspace manages room resources through the Admin Console. These do not migrate automatically and must be recreated in Exchange Online.

#### Step 1: Export Google room resources

In Google Admin Console, navigate to **Directory > Buildings and resources > Resources**. Export the resource list including:

- Resource name
- Resource email (e.g., boardroom@resource.contoso.com)
- Building
- Capacity
- Features (video conferencing, whiteboard, phone)

#### Step 2: Create room mailboxes in Exchange Online

```powershell
# Connect to Exchange Online
Connect-ExchangeOnline -UserPrincipalName admin@contoso.com

# Create room mailboxes
New-Mailbox -Name "Board Room" `
    -Room `
    -PrimarySmtpAddress "boardroom@contoso.com" `
    -ResourceCapacity 20

New-Mailbox -Name "Conference Room A" `
    -Room `
    -PrimarySmtpAddress "confroomA@contoso.com" `
    -ResourceCapacity 10

# Configure room booking policies
Set-CalendarProcessing -Identity "boardroom@contoso.com" `
    -AutomateProcessing AutoAccept `
    -AllowConflicts $false `
    -BookingWindowInDays 180 `
    -MaximumDurationInMinutes 480

# Add room features
Set-Place -Identity "boardroom@contoso.com" `
    -IsWheelChairAccessible $true `
    -AudioDeviceName "Poly Studio" `
    -VideoDeviceName "Surface Hub" `
    -DisplayDeviceName "85-inch display" `
    -Building "HQ" `
    -Floor 3 `
    -Capacity 20
```

#### Step 3: Create room lists

```powershell
# Create room lists (room finders in Outlook)
New-DistributionGroup -Name "HQ Rooms" `
    -RoomList `
    -PrimarySmtpAddress "hqrooms@contoso.com"

# Add rooms to the list
Add-DistributionGroupMember -Identity "hqrooms@contoso.com" `
    -Member "boardroom@contoso.com"
Add-DistributionGroupMember -Identity "hqrooms@contoso.com" `
    -Member "confroomA@contoso.com"
```

#### Step 4: Configure room booking delegates (if applicable)

```powershell
# Set room delegates (for rooms requiring approval)
Set-CalendarProcessing -Identity "boardroom@contoso.com" `
    -AutomateProcessing AutoAccept `
    -ResourceDelegates "admin@contoso.com","receptionist@contoso.com" `
    -AllBookInPolicy $false `
    -AllRequestInPolicy $true
```

### Equipment resources

Google Workspace equipment resources (projectors, vehicles, etc.) map to Exchange Online equipment mailboxes:

```powershell
# Create equipment mailbox
New-Mailbox -Name "Projector 1" `
    -Equipment `
    -PrimarySmtpAddress "projector1@contoso.com"

Set-CalendarProcessing -Identity "projector1@contoso.com" `
    -AutomateProcessing AutoAccept
```

---

## Contact migration

### Personal contacts

Personal contacts in Google Contacts migrate automatically with the Google Workspace migration in EAC. The migration maps:

| Google Contacts field | Outlook Contacts field | Notes                            |
| --------------------- | ---------------------- | -------------------------------- |
| Name (first, last)    | Name (first, last)     | Direct mapping                   |
| Email addresses       | Email addresses        | Up to 3 email addresses          |
| Phone numbers         | Phone numbers          | Home, work, mobile mapped        |
| Address               | Address                | Home, work mapped                |
| Organization          | Company                | Direct mapping                   |
| Title                 | Job Title              | Direct mapping                   |
| Notes                 | Notes                  | Direct mapping                   |
| Photo                 | Photo                  | Contact photos preserved         |
| Birthday              | Birthday               | Direct mapping                   |
| Groups (labels)       | Contact groups         | Mapped to Outlook contact groups |

### Shared contacts (directory)

Google Workspace shared contacts (domain contacts visible to all users) map to Exchange Online contacts:

```powershell
# Create mail contacts for external shared contacts
New-MailContact -Name "Partner Contact" `
    -ExternalEmailAddress "partner@external.com" `
    -FirstName "Jane" `
    -LastName "Smith"

# Create org-wide contacts visible in GAL
# Contacts created as MailContact appear in the Global Address List
```

### Google Directory (GAL equivalent)

The Google Workspace directory (all users) automatically populates the Exchange Online Global Address List (GAL) when users are provisioned in Entra ID. No manual migration is needed for internal directory entries.

---

## Calendar delegation migration

### Google Calendar delegation types

| Google delegation type              | Exchange equivalent         | Configuration                                |
| ----------------------------------- | --------------------------- | -------------------------------------------- |
| **View free/busy**                  | Free/busy sharing (default) | Default in Exchange; no configuration needed |
| **See all event details**           | Reviewer permission         | Grant via Outlook or PowerShell              |
| **Make changes to events**          | Editor permission           | Grant via Outlook or PowerShell              |
| **Make changes and manage sharing** | Delegate (full access)      | Grant via Outlook or PowerShell              |

### Configure calendar delegation

```powershell
# Grant calendar reviewer permission (view all details)
Add-MailboxFolderPermission -Identity "user@contoso.com:\Calendar" `
    -User "assistant@contoso.com" `
    -AccessRights Reviewer

# Grant calendar editor permission (make changes)
Add-MailboxFolderPermission -Identity "user@contoso.com:\Calendar" `
    -User "assistant@contoso.com" `
    -AccessRights Editor

# Grant delegate permission (full access + send on behalf)
Add-MailboxFolderPermission -Identity "user@contoso.com:\Calendar" `
    -User "assistant@contoso.com" `
    -AccessRights Editor

Set-Mailbox -Identity "user@contoso.com" `
    -GrantSendOnBehalfTo "assistant@contoso.com"
```

---

## Post-migration validation

### Calendar validation checklist

- [ ] Single events appear with correct dates, times, and attendees.
- [ ] Recurring events show correct patterns (daily, weekly, monthly).
- [ ] Recurring event exceptions are preserved.
- [ ] Room bookings appear on room calendars.
- [ ] All-day events display correctly.
- [ ] Event attachments are accessible.
- [ ] Calendar delegation works (delegates can view/edit as configured).
- [ ] Free/busy information is visible to other users.
- [ ] Time zones are correct for all events.

### Contact validation checklist

- [ ] Personal contacts are visible in Outlook People.
- [ ] Contact details (phone, email, address) are complete.
- [ ] Contact photos are displayed.
- [ ] Contact groups are preserved.
- [ ] Global Address List shows all internal users.
- [ ] External shared contacts are visible in GAL.

---

## Coexistence considerations

During the migration period, some users will be on Google Calendar and others on Outlook Calendar. To maintain scheduling capability:

### Free/busy interop

Free/busy interop between Google Calendar and Outlook Calendar is not natively supported. During the coexistence period:

1. **Migrate by team/department** to minimize cross-platform scheduling.
2. **Fast-track calendar migration** --- run calendar migration before email cutover so all calendars are in Outlook even if email is still in Gmail.
3. **Communication:** Tell users that scheduling across platforms during coexistence requires manual coordination.

### Google Meet links in migrated events

After migration, existing events with Google Meet links will still show the Meet link. These links will continue to work as long as Google Workspace licenses are active. After Google Workspace decommission, Meet links become non-functional.

**Recommendation:** After migration, have users add Teams meeting links to future events and communicate that Google Meet links on historical events will stop working after decommission.

---

## Troubleshooting

| Issue                                 | Cause                                         | Resolution                                         |
| ------------------------------------- | --------------------------------------------- | -------------------------------------------------- |
| Calendar events not migrating         | Calendar API not enabled                      | Enable Google Calendar API in Google Cloud Console |
| Recurring events missing instances    | Complex recurrence pattern                    | Verify in Outlook; recreate if needed              |
| Room bookings not visible             | Room mailboxes not created                    | Create room mailboxes before migration             |
| Contact photos missing                | Photo sync not enabled                        | Re-sync contacts or upload photos manually         |
| Time zone incorrect on events         | Time zone mismatch between Google and Outlook | Set correct time zone in Outlook settings          |
| Delegation not working post-migration | Permissions not re-configured                 | Re-configure via PowerShell as documented above    |
