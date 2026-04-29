# Industries

CSA-in-a-Box vertical implementations for major commercial industries. Each industry page includes the **typical analytics + AI scenarios**, **regulatory landscape**, **reference architecture variations**, and **how to start** — including which existing tutorials and examples are closest fits.

| Industry                                     | Top scenarios                                                         | Compliance focus                               |
| -------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------- |
| [Financial Services](financial-services.md)  | Fraud, AML, customer 360, risk modeling, FRTB                         | SOC 2, PCI-DSS, SOX, GLBA, Basel III, MiFID II |
| [Manufacturing](manufacturing.md)            | Digital twin, predictive maintenance, OT/IT convergence, supply chain | NIST CSF, IEC 62443 (OT), ITAR (defense)       |
| [Retail & CPG](retail-cpg.md)                | Customer 360, demand forecasting, recommendation, inventory           | PCI-DSS, GDPR, CCPA                            |
| [Energy & Utilities](energy-utilities.md)    | Smart grid, IoT, renewables forecasting, asset performance            | NERC CIP, ISO 27019                            |
| [Telecommunications](telco.md)               | Network analytics, churn, fraud, customer experience                  | GDPR, CPNI, sector-specific regulator          |
| [Life Sciences & Genomics](life-sciences.md) | Genomics pipelines, clinical analytics, drug discovery                | HIPAA, GxP (GLP, GMP, GCP), 21 CFR Part 11     |

## Industries vs Use Cases vs Examples — what's the difference?

| Section                                         | Audience                                                         | Depth                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Industries** (you are here)                   | Buyer / architect deciding "does this platform fit my industry?" | Industry context + scenarios + regulatory + which-example-to-start-with |
| **[Use Cases](../use-cases/index.md)**          | Architect / consultant designing for a specific scenario         | Specific scenario walkthrough with Azure services                       |
| **[End-to-End Examples](../examples/index.md)** | Engineer implementing                                            | Full working code: deploy + contracts + dbt + data + tests              |

Read **Industries → Use Cases → Examples** in that order if you're new.

## Federal & Public Sector industries

The platform's federal/public-sector industry coverage is significantly deeper and lives under **[Use Cases — Government & Public Sector](../use-cases/index.md)**:

- DOJ Antitrust, DOT Transportation, FAA Aviation, EPA Environmental, NOAA Climate, NASA Earth Science, Interior Natural Resources, USDA Agriculture, USPS Postal, Commerce Economic
- IHS / Tribal Health
- Federal Cybersecurity & Threat Analytics

These are treated as use-cases rather than industries because each federal agency is genuinely distinct.

## How to contribute an industry page

If your industry isn't represented:

1. Open an issue at https://github.com/fgarofalo56/csa-inabox/issues with:
    - Industry name
    - Top 3-5 analytics + AI scenarios
    - Regulatory frameworks that apply
    - Whether you'd be willing to co-author
2. We'll create the page using the same template as the existing industry pages
3. PRs welcome — `docs/industries/<industry>.md`
