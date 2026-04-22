---
title: AI Copilot Chat
description: Ask the Copilot about the CSA-in-a-Box codebase
hide:
  - navigation
  - toc
---

# :robot: CSA-in-a-Box Copilot

<div class="hero" markdown>
**Your AI assistant for everything in this repository.**
Ask about architecture, code, tutorials, troubleshooting, and more.
</div>

---

<div id="copilot-fullpage"></div>

---

!!! info "About this Copilot"
    This AI assistant is powered by **Azure OpenAI** and has full context of the CSA-in-a-Box repository.

    **Example questions:**

    - "How does the Delta Lake medallion architecture work?"
    - "Where is the Bicep landing zone deployment defined?"
    - "Help me troubleshoot a dbt compilation error"
    - "What's the difference between DLZ and DMLZ?"
    - "How do I add a new data source to the portal?"

!!! warning "Backend Required"
    The Copilot requires the Azure Function backend to be deployed.
    See `azure-functions/copilot-chat/` for setup instructions.
