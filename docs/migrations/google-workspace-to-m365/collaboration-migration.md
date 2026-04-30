# Collaboration Migration: Google Chat, Meet, and Spaces to Microsoft Teams

**Status:** Authored 2026-04-30
**Audience:** M365 administrators, change management leads, and IT teams managing the transition from Google collaboration tools to Microsoft Teams.
**Scope:** Google Chat to Teams chat, Google Spaces to Teams channels, Google Meet to Teams meetings, Google Groups to M365 Groups, and Google Voice to Teams Phone.

---

## Overview

Unlike email and Drive, Google Chat/Meet/Spaces data generally does not migrate to Microsoft Teams through automated tools. Chat history, Space conversations, and Meet recordings are platform-specific. The migration is primarily a **workflow transition** supported by user training, communication, and change management.

**Key principle:** Plan the Teams structure before the transition. Map Google Spaces to Teams channels, create the channel architecture, and deploy Teams to users before the Google Workspace cutover date.

---

## Google Chat to Microsoft Teams chat

### What migrates

Chat history from Google Chat **does not migrate** to Teams. This is a platform limitation, not a tooling gap. Google Chat messages are stored in Google's infrastructure and are not exportable in a format Teams can ingest at scale.

### Migration strategy

1. **Archive Google Chat history** via Google Vault export before decommission.
2. **Communicate the cutover date** --- all new chat conversations start in Teams after date X.
3. **Deploy Teams** to all users 2-4 weeks before the chat cutover date.
4. **Enable side-by-side usage** during the coexistence period so users become familiar with Teams chat.

### Feature comparison

| Feature                  | Google Chat                           | Microsoft Teams                                     | Notes                   |
| ------------------------ | ------------------------------------- | --------------------------------------------------- | ----------------------- |
| 1:1 chat                 | Direct messages                       | Teams 1:1 chat                                      | Feature parity          |
| Group chat               | Group conversations                   | Teams group chat                                    | Feature parity          |
| Message formatting       | Basic formatting (bold, italic, code) | Rich formatting (bold, italic, code, tables, lists) | Teams richer            |
| File sharing in chat     | Google Drive integration              | OneDrive/SharePoint integration                     | Integrated with M365    |
| Message reactions        | Emoji reactions                       | Emoji reactions + custom reactions                  | Teams richer            |
| Message threading        | Threaded replies                      | Threaded replies                                    | Feature parity          |
| Message search           | Search across chats                   | Search across chats, channels, files                | Teams searches all M365 |
| Read receipts            | Available                             | Available                                           | Feature parity          |
| Priority notifications   | Not available                         | Priority and urgent notifications                   | Teams advantage         |
| Scheduled send           | Available                             | Available                                           | Feature parity          |
| Chat with external users | Google Chat federation                | Teams external access + guest access                | Teams more configurable |

---

## Google Spaces to Microsoft Teams channels

### Mapping strategy

Google Spaces are persistent conversation areas organized around topics, projects, or teams. They map to Microsoft Teams channels.

| Google Spaces structure            | Microsoft Teams equivalent          | Notes                                               |
| ---------------------------------- | ----------------------------------- | --------------------------------------------------- |
| Google Space (topic-based)         | Teams channel (standard)            | Public channel visible to team members              |
| Google Space (team-based)          | Teams team + general channel        | Each team has a general channel; add topic channels |
| Google Space (project-based)       | Teams channel (standard or private) | Private channels for sensitive projects             |
| Google Space with external members | Teams channel with guest access     | Configure guest access in Teams admin               |
| Google Space announcements         | Teams channel with moderation       | Enable channel moderation for announcement-only     |

### Creating the Teams structure

#### Step 1: Inventory Google Spaces

Document all active Google Spaces:

- [ ] Space name and description.
- [ ] Member count and membership list.
- [ ] Activity level (messages per week).
- [ ] Purpose (team communication, project coordination, announcements).
- [ ] External members (if any).

#### Step 2: Design the Teams architecture

Map Google Spaces to Teams:

| Google Space              | Teams team    | Teams channel   | Channel type         |
| ------------------------- | ------------- | --------------- | -------------------- |
| Engineering Discussion    | Engineering   | General         | Standard             |
| Frontend Team             | Engineering   | Frontend        | Standard             |
| Backend Team              | Engineering   | Backend         | Standard             |
| Project Alpha             | Project Alpha | General         | Standard             |
| Project Alpha - Security  | Project Alpha | Security Review | Private              |
| All Company Announcements | Organization  | Announcements   | Standard (moderated) |
| IT Help Desk              | IT Support    | Help Desk       | Standard             |

#### Step 3: Create Teams and channels

```powershell
# Connect to Microsoft Teams
Connect-MicrosoftTeams

# Create a team
New-Team -DisplayName "Engineering" `
    -Description "Engineering team collaboration" `
    -Visibility Private

# Get team GroupId for adding channels
$team = Get-Team -DisplayName "Engineering"

# Add channels
New-TeamChannel -GroupId $team.GroupId `
    -DisplayName "Frontend" `
    -Description "Frontend team discussions"

New-TeamChannel -GroupId $team.GroupId `
    -DisplayName "Backend" `
    -Description "Backend team discussions"

# Add members
Add-TeamUser -GroupId $team.GroupId `
    -User "developer@contoso.com" `
    -Role Member

# Add owners
Add-TeamUser -GroupId $team.GroupId `
    -User "lead@contoso.com" `
    -Role Owner
```

#### Step 4: Configure channel settings

```powershell
# Enable moderation on announcement channels
Set-TeamChannel -GroupId $team.GroupId `
    -CurrentDisplayName "Announcements" `
    -ModerationSettings @{
        AllowUserToPostMessages = $false
        AllowUserToReplyToMessages = $true
    }
```

---

## Google Meet to Microsoft Teams meetings

### What migrates

Google Meet meeting history and recordings **do not migrate** to Teams. The migration is a workflow transition.

### Feature comparison

| Feature                   | Google Meet                     | Microsoft Teams                              | Notes                                                |
| ------------------------- | ------------------------------- | -------------------------------------------- | ---------------------------------------------------- |
| Video meetings            | Up to 500 participants          | Up to 1,000 participants (10,000 view-only)  | Teams higher limits                                  |
| Meeting scheduling        | Google Calendar integration     | Outlook Calendar integration                 | Calendar-dependent                                   |
| Meeting recording         | Google Drive storage            | OneDrive/SharePoint storage                  | Different storage location                           |
| Meeting transcription     | Available (paid in some SKUs)   | Included with Teams                          | Teams includes natively                              |
| Live captions             | Available                       | Available in 30+ languages                   | Feature parity                                       |
| Breakout rooms            | Up to 100 rooms                 | Up to 50 rooms                               | Google has more rooms; Teams rooms are more featured |
| Polls                     | Google Forms integration        | Teams polls (Forms integration)              | Feature parity                                       |
| Q&A                       | Not available natively          | Teams Q&A in meetings                        | Teams advantage                                      |
| Whiteboard in meetings    | Google Jamboard                 | Microsoft Whiteboard                         | Teams advantage (more integrated)                    |
| Meeting lobby             | Available                       | Available with granular controls             | Teams more configurable                              |
| Meeting recap             | Basic summary                   | Copilot meeting recap (with Copilot license) | Copilot advantage                                    |
| Together mode             | Not available                   | Available                                    | Virtual shared background                            |
| Background effects        | Background blur and replacement | Background blur, replacement, and custom     | Feature parity                                       |
| Noise suppression         | Available                       | AI-powered noise suppression                 | Feature parity                                       |
| Hand raise                | Available                       | Available                                    | Feature parity                                       |
| Webinars                  | Basic (Google Meet)             | Teams webinars with registration             | Teams more capable                                   |
| Town halls                | YouTube Live (separate)         | Teams town halls (up to 10,000)              | Teams integrated                                     |
| Recording auto-expiration | Manual management               | Configurable auto-expiration policies        | Teams more governed                                  |

### Teams meeting deployment

1. **Configure Teams meeting policies** in Teams Admin Center.
2. **Deploy Teams desktop and mobile apps** via Intune.
3. **Train users** on Teams meeting scheduling, recording, and Copilot features.
4. **Configure meeting room devices** (if replacing Google Meet hardware).

```powershell
# Configure Teams meeting policy
Set-CsTeamsMeetingPolicy -Identity "Global" `
    -AllowMeetingRecording $true `
    -AllowTranscription $true `
    -AllowCartCaptionsScheduling "EnabledUserOverride" `
    -MeetingChatEnabledType "Enabled" `
    -AllowMeetingReactions $true
```

---

## Google Groups to M365 Groups

### Google Groups types and M365 equivalents

| Google Group type                        | M365 equivalent                          | Notes                                                                 |
| ---------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------- |
| **Email distribution list**              | Exchange distribution group              | Simple email distribution                                             |
| **Collaborative inbox**                  | Exchange shared mailbox or M365 Group    | Shared mailbox for shared email; M365 Group for broader collaboration |
| **Announcement-only list**               | Exchange distribution group (restricted) | Restrict who can send to the group                                    |
| **Web forum**                            | Viva Engage (Yammer) community           | Community-based discussion                                            |
| **Google Group for Google Drive access** | M365 Group or SharePoint group           | Group-based file permissions                                          |
| **Google Group for Google Sites access** | SharePoint site permissions              | Site-specific access groups                                           |

### Migration steps

#### Step 1: Export Google Groups

```
Google Admin Console > Directory > Groups
```

Export:

- [ ] Group name and email address.
- [ ] Member list with roles (owner, manager, member).
- [ ] Group type (distribution, collaborative inbox, announcement).
- [ ] Access settings (who can post, who can view).
- [ ] Number of members.

#### Step 2: Create M365 Groups or distribution groups

```powershell
# Create an Exchange distribution group (for email-only distribution)
New-DistributionGroup -Name "All Engineering" `
    -PrimarySmtpAddress "engineering@contoso.com" `
    -Type Distribution

# Add members
Add-DistributionGroupMember -Identity "engineering@contoso.com" `
    -Member "dev1@contoso.com"

# Create an M365 Group (for collaboration: shared mailbox + SharePoint + Teams)
New-UnifiedGroup -DisplayName "Project Alpha" `
    -PrimarySmtpAddress "project-alpha@contoso.com" `
    -AccessType Private

# Add members
Add-UnifiedGroupLinks -Identity "project-alpha@contoso.com" `
    -LinkType Members `
    -Links "user1@contoso.com","user2@contoso.com"
```

#### Step 3: Configure group settings

```powershell
# Restrict who can send to a distribution group (announcement-only)
Set-DistributionGroup -Identity "announcements@contoso.com" `
    -AcceptMessagesOnlyFrom "ceo@contoso.com","comms@contoso.com"

# Configure M365 Group expiration policy (via Entra ID)
# Configured in Entra Admin Center > Groups > Expiration
```

---

## Google Voice to Teams Phone

### Overview

Google Voice provides cloud-based phone service in limited markets. Microsoft Teams Phone provides enterprise-grade cloud PBX with broader capabilities and availability.

### Migration considerations

| Consideration       | Google Voice                     | Teams Phone                                                  |
| ------------------- | -------------------------------- | ------------------------------------------------------------ |
| **Availability**    | Limited countries                | Available in 60+ countries                                   |
| **Number porting**  | Export numbers from Google Voice | Port numbers to Teams Phone via carrier                      |
| **Calling plans**   | Google-provided numbers          | Microsoft Calling Plans, Direct Routing, or Operator Connect |
| **Auto attendants** | Basic                            | Advanced auto attendants with nested menus                   |
| **Call queues**     | Basic                            | Advanced call queues with agent routing                      |
| **Voicemail**       | Basic voicemail                  | Voicemail with transcription                                 |
| **Call recording**  | Available                        | Compliance recording (E5) + policy-based recording           |
| **Integration**     | Google Workspace integration     | Teams integration + Power Automate + CRM connectors          |

### Teams Phone deployment options

| Option                      | Description                                            | Best for                                    |
| --------------------------- | ------------------------------------------------------ | ------------------------------------------- |
| **Microsoft Calling Plans** | Microsoft provides phone numbers and PSTN connectivity | Small-medium orgs, simple phone needs       |
| **Direct Routing**          | Connect existing SBC/PBX to Teams                      | Orgs with existing telephony infrastructure |
| **Operator Connect**        | Carrier-managed PSTN through Teams Admin Center        | Orgs wanting carrier-managed solution       |

```powershell
# Assign Teams Phone license and calling plan
Set-CsPhoneNumberAssignment -Identity "user@contoso.com" `
    -PhoneNumber "+12065551234" `
    -PhoneNumberType CallingPlan

# Configure auto attendant
New-CsAutoAttendant -Name "Main Line" `
    -DefaultCallFlow $defaultCallFlow `
    -TimeZoneId "Pacific Standard Time" `
    -LanguageId "en-US"
```

---

## Communication plan for collaboration migration

### Timeline communication

| When           | Communication                                          | Channel                            |
| -------------- | ------------------------------------------------------ | ---------------------------------- |
| 4 weeks before | "Teams is coming" announcement with timeline           | Email + all-hands meeting          |
| 3 weeks before | Teams training sessions (live + recorded)              | Google Meet (ironic but practical) |
| 2 weeks before | Teams deployed to all users; side-by-side usage starts | Email + Teams announcement         |
| 1 week before  | "Last week of Google Chat/Spaces" reminder             | Email + Google Chat + Teams        |
| Cutover day    | "Google Chat/Spaces is now read-only; use Teams"       | Email + Teams                      |
| 1 week after   | Tips and tricks for Teams power users                  | Teams channel                      |
| 2 weeks after  | Feedback survey                                        | Microsoft Forms                    |

### Training topics

1. **Teams basics:** Chat, channels, mentions, notifications.
2. **Teams meetings:** Scheduling, recording, transcription, Copilot recap.
3. **Teams files:** Accessing OneDrive and SharePoint files within Teams.
4. **Teams apps:** Using Power Automate, Forms, Planner within Teams.
5. **Teams Phone:** Making and receiving calls (if applicable).
6. **Teams mobile:** Using Teams on iOS/Android.

---

## Troubleshooting

| Issue                                      | Cause                                    | Resolution                                                  |
| ------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------- |
| Users not receiving Teams notifications    | Notification settings default to minimal | Configure notification policies in Teams Admin Center       |
| External users cannot join Teams           | External access not configured           | Enable external access in Teams Admin Center                |
| File sharing in Teams channels not working | SharePoint site not provisioned          | Ensure SharePoint is licensed and provisioned               |
| Teams meeting recording fails              | Recording policy not enabled             | Enable recording in Teams meeting policy                    |
| Phone numbers not porting                  | Carrier port-out delays                  | Coordinate with Google Voice and new carrier                |
| Users confused by Teams UI                 | Training gap                             | Run additional training sessions; deploy Teams tips channel |
