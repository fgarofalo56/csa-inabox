# Complete Feature Mapping: Okta to Microsoft Entra ID

**Status:** Authored 2026-04-30
**Audience:** Identity Architects, Security Engineers, IAM Analysts
**Purpose:** Comprehensive feature-by-feature mapping for migration planning

---

## How to use this document

This document maps 50+ Okta features to their Microsoft Entra ID equivalents. Each mapping includes:

- **Okta feature name** and capability description
- **Entra ID equivalent** with product/service name
- **Parity level:** Full (feature parity or better), Partial (functional equivalent with differences), or Gap (no direct equivalent; workaround documented)
- **Migration notes** for implementation-specific guidance

Use this document during Phase 0 (Discovery) to build your migration scope and during Phase 2-5 to guide feature-by-feature implementation.

---

## 1. Directory and user management

| #   | Okta feature               | Okta description                                                                        | Entra ID equivalent                                                         | Parity  | Migration notes                                                                                                                                             |
| --- | -------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Universal Directory**    | Cloud-hosted user store with custom attributes, profile mastering from multiple sources | **Entra ID Directory**                                                      | Full    | Entra supports custom extension attributes (15 built-in + unlimited via extension properties). Graph API for schema extension.                              |
| 2   | **User profiles**          | Flexible user schema with custom attributes, profile mastering priority                 | **User object + extension attributes**                                      | Full    | Map Okta custom attributes to Entra extension attributes via Graph API. Profile mastering handled by Entra Connect Sync or Cloud Sync for hybrid scenarios. |
| 3   | **Groups**                 | Okta groups with rules-based membership, group push to apps                             | **Security groups + dynamic membership rules**                              | Full    | Dynamic groups in Entra ID P1 replace Okta group rules. Group-based app assignment replaces Okta group push.                                                |
| 4   | **Group rules**            | Automatic group membership based on user attribute conditions                           | **Dynamic group membership rules**                                          | Full    | Syntax differs. Okta: `user.department == "Engineering"`. Entra: `user.department -eq "Engineering"`.                                                       |
| 5   | **Directory integrations** | LDAP interface, Active Directory agent, HR imports                                      | **Entra Connect Sync, Cloud Sync, HR provisioning connectors**              | Full    | Entra Connect Sync replaces AD agent. Cloud Sync provides lightweight alternative. Native Workday/SuccessFactors HR connectors.                             |
| 6   | **Custom schemas**         | Extended user profile with custom attributes                                            | **Extension attributes + directory extensions**                             | Full    | 15 built-in extension attributes + unlimited directory extensions via app registrations.                                                                    |
| 7   | **Profile mastering**      | Multiple sources with priority-based attribute mastering                                | **Entra Connect Sync precedence rules + HR provisioning attribute mapping** | Partial | Entra Connect handles on-prem AD mastering. HR provisioning connectors master from HR source. Multi-source priority requires careful mapping.               |
| 8   | **Linked objects**         | Manager-subordinate relationships, linked user attributes                               | **Manager attribute + custom extension properties**                         | Full    | Manager relationship is native. Custom linked objects map to extension properties.                                                                          |

---

## 2. Single sign-on (SSO)

| #   | Okta feature                        | Okta description                                        | Entra ID equivalent                                    | Parity  | Migration notes                                                                                                                                                             |
| --- | ----------------------------------- | ------------------------------------------------------- | ------------------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **SAML 2.0 SSO**                    | SAML IdP for enterprise applications                    | **Enterprise Applications (SAML)**                     | Full    | Entra supports SAML 2.0 IdP. Migrate metadata, certificates, claims mappings. [Tutorial](https://learn.microsoft.com/entra/identity/enterprise-apps/migrate-apps-from-okta) |
| 10  | **OIDC/OAuth 2.0 SSO**              | OpenID Connect and OAuth 2.0 for modern apps            | **Enterprise Applications (OIDC) + App Registrations** | Full    | Entra supports OIDC 1.0. Migrate client IDs, redirect URIs, scopes. Token claims may require transformation rules.                                                          |
| 11  | **SWA (Secure Web Authentication)** | Password-vaulted SSO for apps without SAML/OIDC support | **Password-based SSO (My Apps)**                       | Full    | Entra My Apps provides password-vaulted SSO. Consider upgrading SWA apps to SAML where possible.                                                                            |
| 12  | **WS-Federation**                   | WS-Fed SSO for legacy Microsoft applications            | **WS-Federation**                                      | Full    | Native support. Used primarily for on-prem SharePoint, ADFS-reliant apps.                                                                                                   |
| 13  | **Header-based SSO**                | Inject authentication headers for legacy web apps       | **Application Proxy with header-based SSO**            | Full    | Entra Application Proxy supports header injection for on-prem web apps.                                                                                                     |
| 14  | **Okta Integration Network (OIN)**  | Pre-built SSO integrations (7,500+ apps)                | **Entra App Gallery (5,000+ apps)**                    | Partial | Gallery is smaller but covers most enterprise SaaS. Custom SAML/OIDC configuration covers gaps. Gallery growing rapidly.                                                    |
| 15  | **Bookmark apps**                   | URL-only apps in Okta dashboard (no SSO)                | **My Apps linked applications**                        | Full    | My Apps supports linked applications (URL bookmarks).                                                                                                                       |
| 16  | **Custom SAML apps**                | Hand-configured SAML apps not in OIN                    | **Non-gallery enterprise applications**                | Full    | Entra supports custom SAML configuration with flexible claims mapping.                                                                                                      |
| 17  | **IDP discovery**                   | Route users to correct IdP based on email domain        | **Home Realm Discovery (HRD) policies**                | Full    | HRD policies in Entra ID route users to federated IdPs based on domain.                                                                                                     |

---

## 3. Multi-factor authentication (MFA)

| #   | Okta feature           | Okta description                                          | Entra ID equivalent                                     | Parity  | Migration notes                                                                                                  |
| --- | ---------------------- | --------------------------------------------------------- | ------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| 18  | **Okta Verify (push)** | Mobile app push notification for MFA                      | **Microsoft Authenticator (push)**                      | Full    | Authenticator supports push with number matching (phishing-resistant). Superior to basic push.                   |
| 19  | **Okta Verify (TOTP)** | Time-based one-time password in Okta Verify               | **Microsoft Authenticator (TOTP) or any OATH TOTP app** | Full    | Authenticator supports TOTP. Third-party TOTP apps (Google Authenticator, Authy) also supported.                 |
| 20  | **Okta FastPass**      | Passwordless authentication using device-bound credential | **Microsoft Authenticator passwordless + Passkeys**     | Full    | Authenticator passwordless sign-in and FIDO2 passkeys provide equivalent or superior passwordless experience.    |
| 21  | **FIDO2/WebAuthn**     | Hardware security key support (YubiKey, etc.)             | **FIDO2 security keys**                                 | Full    | Native FIDO2 support in Entra ID. Supports YubiKey, Feitian, and other FIDO2-certified keys.                     |
| 22  | **SMS MFA**            | SMS one-time passcode                                     | **SMS verification**                                    | Full    | Supported but discouraged. Microsoft and NIST recommend phishing-resistant methods.                              |
| 23  | **Voice call MFA**     | Phone call verification                                   | **Voice call verification**                             | Full    | Supported but discouraged for the same reasons as SMS.                                                           |
| 24  | **Email MFA**          | Email one-time passcode                                   | **Email OTP**                                           | Full    | Supported as secondary method.                                                                                   |
| 25  | **Security questions** | Knowledge-based authentication                            | **Security questions (SSPR only)**                      | Partial | Available for self-service password reset. Not recommended for MFA. Entra encourages phishing-resistant methods. |
| 26  | **Adaptive MFA**       | Risk-based MFA enforcement (device, location, behavior)   | **Conditional Access + Identity Protection**            | Full    | Conditional Access with Identity Protection risk levels provides richer risk-based MFA than Okta Adaptive MFA.   |
| 27  | **Custom MFA factors** | Third-party MFA factor integration                        | **External authentication methods**                     | Full    | Entra supports external authentication methods for custom MFA integration.                                       |

---

## 4. Access policies and conditional access

| #   | Okta feature               | Okta description                                                       | Entra ID equivalent                                  | Parity | Migration notes                                                                                                               |
| --- | -------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 28  | **Global sign-on policy**  | Organization-wide authentication requirements                          | **Conditional Access baseline policies**             | Full   | Create CA policies targeting "All users" + "All cloud apps" for global enforcement.                                           |
| 29  | **Per-app sign-on policy** | Application-specific authentication requirements                       | **Application-targeted Conditional Access policies** | Full   | CA policies can target specific applications or application groups.                                                           |
| 30  | **Network zones**          | IP-based trusted/untrusted network definitions                         | **Named locations (IP ranges, GPS, countries)**      | Full   | Named locations support IP ranges, GPS-based locations, and country/region definitions. Richer than Okta network zones.       |
| 31  | **Device trust**           | Device posture assessment via Workspace ONE/Jamf integration           | **Device compliance (Intune)**                       | Full   | Native Intune integration. No third-party MDM required (though supported).                                                    |
| 32  | **Session lifetime**       | Configurable session duration and idle timeout                         | **Sign-in frequency + persistent browser session**   | Full   | CA policies control sign-in frequency and persistent browser session behavior.                                                |
| 33  | **Behavior detection**     | Anomalous sign-in pattern detection                                    | **Identity Protection (user risk + sign-in risk)**   | Full   | Identity Protection uses ML across billions of signals for risk detection. Significantly richer than Okta behavior detection. |
| 34  | **ThreatInsight**          | Pre-authentication threat detection (credential stuffing, brute force) | **Entra ID Smart Lockout + Identity Protection**     | Full   | Smart lockout handles brute force. Identity Protection handles credential stuffing, leaked credentials, anomalous sign-ins.   |

---

## 5. Lifecycle management and provisioning

| #   | Okta feature                                | Okta description                                        | Entra ID equivalent                                         | Parity | Migration notes                                                                                                                      |
| --- | ------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 35  | **SCIM provisioning**                       | Automated user provisioning/deprovisioning to SaaS apps | **Entra provisioning service (SCIM)**                       | Full   | Entra provisioning service supports SCIM 2.0. Migrate connector configurations and attribute mappings.                               |
| 36  | **HR-driven provisioning (Workday)**        | Inbound provisioning from Workday HR                    | **Workday inbound provisioning connector**                  | Full   | Native Entra connector for Workday. [Microsoft Learn](https://learn.microsoft.com/entra/identity/saas-apps/workday-inbound-tutorial) |
| 37  | **HR-driven provisioning (SuccessFactors)** | Inbound provisioning from SAP SuccessFactors            | **SuccessFactors inbound provisioning connector**           | Full   | Native Entra connector for SuccessFactors.                                                                                           |
| 38  | **Group push**                              | Push group membership to downstream applications        | **Group-based provisioning**                                | Full   | Entra provisioning supports group-based assignment and membership sync.                                                              |
| 39  | **Deprovisioning**                          | Automated account deactivation/removal when user leaves | **Entra provisioning deprovisioning + Lifecycle Workflows** | Full   | Provisioning service handles app-level deprovisioning. Lifecycle Workflows automate leaver processes.                                |
| 40  | **Profile sync**                            | Attribute synchronization from directory to apps        | **Attribute mapping in provisioning configuration**         | Full   | Entra provisioning supports rich attribute mapping with expressions and transformations.                                             |
| 41  | **Import users**                            | Bulk user import from CSV or API                        | **Graph API bulk operations + CSV import**                  | Full   | Microsoft Graph API supports batch user creation. Entra admin center supports CSV import.                                            |

---

## 6. Automation and workflows

| #   | Okta feature            | Okta description                                                        | Entra ID equivalent                                            | Parity  | Migration notes                                                                                                                                                       |
| --- | ----------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 42  | **Okta Workflows**      | No-code identity automation with visual flow builder                    | **Lifecycle Workflows + Logic Apps + Power Automate**          | Partial | No single 1:1 replacement. Lifecycle Workflows handle identity lifecycle events. Logic Apps/Power Automate handle complex orchestration. Requires redesign, not port. |
| 43  | **Workflow connectors** | 100+ pre-built connectors (Slack, Jira, ServiceNow, etc.)               | **Logic Apps connectors (1,000+) + Power Automate connectors** | Full    | Logic Apps and Power Automate have significantly more connectors than Okta Workflows.                                                                                 |
| 44  | **Workflow tables**     | Data storage within Okta Workflows                                      | **Dataverse or Azure Table Storage**                           | Partial | No direct equivalent within Entra. Use Dataverse (with Power Automate) or Azure Table Storage (with Logic Apps).                                                      |
| 45  | **Event hooks**         | Webhook notifications on Okta events                                    | **Entra ID audit log + Event Grid + Logic Apps**               | Full    | Entra audit logs stream to Event Grid, Log Analytics, or Event Hubs. Logic Apps triggered by identity events.                                                         |
| 46  | **Inline hooks**        | Modify Okta behavior in real-time (token inline hook, SAML inline hook) | **Claims transformation rules + custom claims providers**      | Partial | SAML claims mapping handles most inline hook scenarios. Custom claims providers (preview) enable API-based claims enrichment.                                         |

---

## 7. Identity governance

| #   | Okta feature               | Okta description                                   | Entra ID equivalent                                | Parity  | Migration notes                                                                                                                                                |
| --- | -------------------------- | -------------------------------------------------- | -------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 47  | **Access certifications**  | Periodic review of user access to applications     | **Access reviews (Entra ID Governance)**           | Full    | Access reviews support recurring certifications with multi-stage review, auto-remediation, and ML-based recommendations.                                       |
| 48  | **Access requests**        | Self-service access request workflows              | **Entitlement management (access packages)**       | Full    | Access packages provide self-service request, approval workflows, time-limited access, and automatic removal. Richer than Okta access requests.                |
| 49  | **Separation of duties**   | Policy-based incompatible access prevention        | **Incompatible access packages + custom policies** | Partial | Entitlement management supports incompatible access package policies. Custom Graph API policies can enforce SoD rules.                                         |
| 50  | **Okta Privileged Access** | Privileged session management, credential vaulting | **Privileged Identity Management (PIM)**           | Full    | PIM provides just-in-time activation, approval workflows, time-bound access, and audit trails for privileged roles. PIM for Groups extends to any Entra group. |

---

## 8. API access management

| #   | Okta feature                     | Okta description                                   | Entra ID equivalent                             | Parity  | Migration notes                                                                                                                                          |
| --- | -------------------------------- | -------------------------------------------------- | ----------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 51  | **Custom authorization servers** | OAuth 2.0 authorization servers for API protection | **App registrations + custom API scopes**       | Full    | Entra app registrations support custom OAuth 2.0 scopes, claims, and token configuration.                                                                |
| 52  | **API tokens**                   | Machine-to-machine API authentication              | **Service principals + client credentials**     | Full    | Service principal with client certificate or secret. Managed identity preferred for Azure resources (no credential management).                          |
| 53  | **Scopes and claims**            | Custom scopes and claims for API authorization     | **App roles + custom claims + optional claims** | Full    | App roles provide RBAC for APIs. Custom claims and optional claims configure token content.                                                              |
| 54  | **Token lifetime**               | Configurable token expiration                      | **Token lifetime policies**                     | Full    | Configurable via token lifetime policies or Conditional Access sign-in frequency.                                                                        |
| 55  | **API rate limiting**            | Throttling for API endpoints                       | **Azure API Management (APIM)**                 | Partial | Entra ID has built-in rate limits on Graph API. For custom API rate limiting, use Azure API Management with CSA-in-a-Box APIM Data Mesh Gateway pattern. |

---

## 9. Server access

| #   | Okta feature                     | Okta description                          | Entra ID equivalent                                            | Parity | Migration notes                                                                                                    |
| --- | -------------------------------- | ----------------------------------------- | -------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------ |
| 56  | **Advanced Server Access (SSH)** | Certificate-based SSH access management   | **Entra ID SSH login for Linux VMs + Azure RBAC**              | Full   | Azure Linux VMs support Entra ID SSH login natively. RBAC controls access. No client agent required for Azure VMs. |
| 57  | **Advanced Server Access (RDP)** | Managed RDP access with session recording | **Entra ID login for Windows VMs + Azure Bastion**             | Full   | Azure Bastion provides managed RDP/SSH access with session recording. Entra ID authentication for Windows VMs.     |
| 58  | **Server enrollment**            | Agent-based server registration           | **Azure Arc (hybrid/multi-cloud) or native Azure VM identity** | Full   | Azure VMs have native identity. Non-Azure servers use Azure Arc for Entra-based access management.                 |

---

## 10. Security and threat protection

| #   | Okta feature      | Okta description                    | Entra ID equivalent                                  | Parity | Migration notes                                                                                                                                                     |
| --- | ----------------- | ----------------------------------- | ---------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 59  | **ThreatInsight** | Pre-authentication threat detection | **Identity Protection + Smart Lockout**              | Full   | Identity Protection provides richer threat detection including leaked credentials, anonymous IP, malware-linked IP, atypical travel, unfamiliar sign-in properties. |
| 60  | **HealthInsight** | Security posture recommendations    | **Entra ID Secure Score + Identity recommendations** | Full   | Secure Score provides actionable security posture assessment with prioritized recommendations.                                                                      |
| 61  | **System Log**    | Audit logging for all Okta events   | **Entra audit logs + sign-in logs**                  | Full   | Entra provides separate audit and sign-in logs with rich filtering. Logs stream to Log Analytics, SIEM, and storage.                                                |
| 62  | **Event hooks**   | Real-time event notifications       | **Diagnostic settings + Event Grid + streaming**     | Full   | Entra logs can stream in real-time to Event Hubs, Log Analytics, Azure Storage, and partner SIEM solutions.                                                         |

---

## 11. Developer and external identity

| #   | Okta feature         | Okta description                                  | Entra ID equivalent                             | Parity | Migration notes                                                                                                                                            |
| --- | -------------------- | ------------------------------------------------- | ----------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 63  | **Okta Auth0 (CIC)** | Customer identity and access management (CIAM)    | **Entra External ID**                           | Full   | Entra External ID (formerly Azure AD B2C + External Identities) provides CIAM with customizable user flows, social identity providers, and API protection. |
| 64  | **Social login**     | Google, Facebook, Apple sign-in for consumer apps | **Entra External ID social identity providers** | Full   | Supports Google, Facebook, Apple, and custom OpenID Connect providers.                                                                                     |
| 65  | **Branded sign-in**  | Custom login page branding                        | **Company branding**                            | Full   | Entra company branding supports custom logos, backgrounds, sign-in page text, and CSS customization.                                                       |

---

## 12. Compliance and reporting

| #   | Okta feature         | Okta description                            | Entra ID equivalent                      | Parity | Migration notes                                                                                                                                                               |
| --- | -------------------- | ------------------------------------------- | ---------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 66  | **FedRAMP Moderate** | Okta Workforce Identity Cloud               | **FedRAMP High (Azure Government)**      | Full+  | Entra in Azure Government holds FedRAMP High -- higher authorization level than Okta.                                                                                         |
| 67  | **SOC 2 Type II**    | Okta annual SOC 2 report                    | **SOC 2 Type II (Azure + M365)**         | Full   | Microsoft provides SOC 2 Type II reports covering Entra ID as part of Azure and M365 compliance program.                                                                      |
| 68  | **HIPAA BAA**        | Business Associate Agreement for healthcare | **HIPAA BAA (M365 + Azure)**             | Full   | Microsoft HIPAA BAA covers Entra ID as part of M365 and Azure covered services.                                                                                               |
| 69  | **Reports**          | Pre-built usage and security reports        | **Entra reports + workbooks + Power BI** | Full   | Entra admin center provides built-in reports. Azure Monitor workbooks provide customizable dashboards. Power BI provides executive-level identity analytics via CSA-in-a-Box. |

---

## Summary scorecard

| Category                      | Features mapped | Full parity  | Partial parity | Gap        |
| ----------------------------- | --------------- | ------------ | -------------- | ---------- |
| Directory & user management   | 8               | 7            | 1              | 0          |
| Single sign-on                | 9               | 8            | 1              | 0          |
| Multi-factor authentication   | 10              | 9            | 1              | 0          |
| Access policies               | 7               | 7            | 0              | 0          |
| Lifecycle management          | 7               | 7            | 0              | 0          |
| Automation & workflows        | 5               | 3            | 2              | 0          |
| Identity governance           | 4               | 3            | 1              | 0          |
| API access management         | 5               | 4            | 1              | 0          |
| Server access                 | 3               | 3            | 0              | 0          |
| Security & threat protection  | 4               | 4            | 0              | 0          |
| Developer & external identity | 3               | 3            | 0              | 0          |
| Compliance & reporting        | 4               | 4            | 0              | 0          |
| **Total**                     | **69**          | **62 (90%)** | **7 (10%)**    | **0 (0%)** |

**Key finding:** 90% of Okta features have full parity or better in Entra ID. The 10% with partial parity are functional equivalents that require architectural adaptation rather than missing capabilities. There are zero features with no Entra ID equivalent.

---

## Key Microsoft Learn references

- [Migrate applications from Okta to Entra ID](https://learn.microsoft.com/entra/identity/enterprise-apps/migrate-apps-from-okta)
- [Entra ID feature comparison](https://learn.microsoft.com/entra/identity/fundamentals/compare)
- [Conditional Access documentation](https://learn.microsoft.com/entra/identity/conditional-access/)
- [Entra ID Governance documentation](https://learn.microsoft.com/entra/id-governance/)
- [Entra External ID documentation](https://learn.microsoft.com/entra/external-id/)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
