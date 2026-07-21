# Tiny in-VNet one-shot: az CLI + curl + python3 (all in the azure-cli image) that
# creates a Databricks SQL warehouse against the private-link Gov workspace and
# wires the console. Baked script (no base64/args gymnastics).
FROM mcr.microsoft.com/azure-cli:2.62.0
RUN which curl >/dev/null 2>&1 || (apk add --no-cache curl || true)
COPY init.sh /init.sh
RUN chmod +x /init.sh
ENTRYPOINT ["/bin/sh","/init.sh"]
