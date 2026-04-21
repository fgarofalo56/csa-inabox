# Sample Overview Document

CSA-in-a-Box is a reference implementation of Microsoft's Cloud-Scale
Analytics guidance. It provides Fabric-parity capabilities on Azure
PaaS for Government and regulated Commercial workloads.

## Key Capabilities

The platform includes governance automation, lakehouse patterns, and a
grounded Copilot for operator Q&A. Each capability is independently
deployable so teams can adopt incrementally.

## Private Endpoints

All storage and Key Vault services should be deployed with private
endpoints in production. The Bicep templates set this up automatically
when the ``environment`` parameter is ``prod``.

Private endpoints are required for FedRAMP High compliance.
