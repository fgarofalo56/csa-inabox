/*
 * CSA Loom — Loom Unity: passwordless (Microsoft Entra) PostgreSQL authentication
 * for the OSS Unity Catalog server.  LU-1.
 *
 * WHY THIS EXISTS
 * ---------------
 * Loom Unity's metastore lives on an Azure Database for PostgreSQL Flexible
 * Server created with `authConfig.passwordAuth = 'Disabled'`
 * (platform/fiab/bicep/modules/data-plane/loom-unity-postgres.bicep): there is
 * no database password to configure, rotate, or leak.  Every connection must
 * present a short-lived Microsoft Entra access token as its password.
 *
 * Rendering a token once into hibernate.properties at container start does NOT
 * work: Entra access tokens expire (5-60 minutes), and Hibernate's pool opens
 * new physical connections for the life of the process, so the catalog would
 * start fine and then hard-fail authentication roughly an hour later.  The
 * token has to be minted per physical connection.
 *
 * The pgjdbc driver supports exactly that through
 * `authenticationPluginClassName` (org.postgresql.plugin.AuthenticationPlugin):
 * the driver calls getPassword() each time it opens a connection.  This is the
 * same mechanism Microsoft's own
 * com.azure.identity.extensions.jdbc.postgresql.AzurePostgresqlAuthenticationPlugin
 * uses (see the Learn passwordless-JDBC guidance).
 *
 * WHY NOT JUST USE THE MICROSOFT PLUGIN
 * -------------------------------------
 * azure-identity-extensions drags azure-identity + azure-core + msal4j +
 * reactor + netty + jackson onto the classpath.  The OSS Unity Catalog server
 * is itself an Armeria/netty/jackson application: adding ~40 transitive jars to
 * its classpath is a real, untestable version-conflict risk for a component
 * whose only job is "GET one URL, read one JSON field".  This class talks to
 * the Azure managed-identity endpoint with nothing but the JDK, so the only jar
 * added next to pgjdbc is this one, and it cannot conflict with anything.
 *
 * PROTOCOL
 * --------
 * Azure Container Apps exposes managed identity the App Service way, NOT the
 * classic IMDS way (a Loom-wide gotcha — see
 * apps/fiab-console/lib/azure/aca-managed-identity.ts):
 *
 *   GET ${IDENTITY_ENDPOINT}?api-version=2019-08-01&resource=<res>&client_id=<id>
 *   header: X-IDENTITY-HEADER: ${IDENTITY_HEADER}
 *
 * with a fallback to classic IMDS (VM / AKS) when those variables are absent.
 * `client_id` is REQUIRED whenever more than one identity is assigned, which is
 * why the bicep module surfaces AZURE_CLIENT_ID.
 *
 * SECURITY
 * --------
 * - The token is never logged, never written to disk, and never placed in an
 *   exception message; a failed acquisition reports the HTTP status and the
 *   resource only.
 * - Tokens are cached in-process for 60 seconds.  That is purely to stop a pool
 *   warm-up from stampeding the identity endpoint; it deliberately does NOT
 *   parse or trust `expires_on`, so an early-expiring token can never be
 *   replayed past its life by this cache.
 *
 * Sovereign clouds: the resource defaults to the Commercial OSS-RDBMS app URI
 * and is overridden per cloud by LOOM_UNITY_DB_AAD_RESOURCE, which the bicep
 * module derives from environment().suffixes.sqlServerHostname
 * (https://ossrdbms-aad.database.usgovcloudapi.net in GCC-High / IL5).
 * Nothing sovereign is hard-coded on a code path.
 */
package ai.limitlessdata.loom.unity;

import org.postgresql.plugin.AuthenticationPlugin;
import org.postgresql.plugin.AuthenticationRequestType;
import org.postgresql.util.PSQLException;
import org.postgresql.util.PSQLState;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Properties;

public final class EntraPostgresAuthPlugin implements AuthenticationPlugin {

    /** Commercial OSS-RDBMS Entra application URI; overridden per cloud by env. */
    private static final String DEFAULT_RESOURCE = "https://ossrdbms-aad.database.windows.net";

    /** Anti-stampede window only — never an expiry claim. */
    private static final long CACHE_MILLIS = 60_000L;

    private static final Object LOCK = new Object();
    private static String cachedToken;
    private static long cachedAtMillis;

    private final String resource;
    private final String clientId;

    /** pgjdbc prefers a (Properties) constructor; the no-arg one keeps the class usable standalone. */
    public EntraPostgresAuthPlugin() {
        this(new Properties());
    }

    public EntraPostgresAuthPlugin(Properties properties) {
        Properties props = properties == null ? new Properties() : properties;
        this.resource = normalizeResource(firstNonEmpty(
                props.getProperty("loomUnityAadResource"),
                System.getenv("LOOM_UNITY_DB_AAD_RESOURCE"),
                DEFAULT_RESOURCE));
        this.clientId = firstNonEmpty(
                props.getProperty("loomUnityClientId"),
                System.getenv("AZURE_CLIENT_ID"),
                "");
    }

    @Override
    public char[] getPassword(AuthenticationRequestType type) throws PSQLException {
        try {
            return acquireToken().toCharArray();
        } catch (Exception e) {
            throw new PSQLException(
                    "Loom Unity: could not mint a Microsoft Entra access token for " + resource
                            + " (managed identity client id "
                            + (clientId.isEmpty() ? "<unset - set AZURE_CLIENT_ID>" : clientId)
                            + "). The Loom Unity Postgres metastore is Entra-only (passwordAuth=Disabled), so this is fatal. "
                            + "Check that the Container App has the loom-unity user-assigned identity attached and that the "
                            + "identity is the flexible server's Entra administrator (see docs/fiab/unity-gov.md).",
                    PSQLState.INVALID_PASSWORD, e);
        }
    }

    private String acquireToken() throws Exception {
        synchronized (LOCK) {
            long now = System.currentTimeMillis();
            if (cachedToken != null && now - cachedAtMillis < CACHE_MILLIS) {
                return cachedToken;
            }
            String token = fetchToken();
            cachedToken = token;
            cachedAtMillis = now;
            return token;
        }
    }

    private String fetchToken() throws Exception {
        String endpoint = System.getenv("IDENTITY_ENDPOINT");
        String header = System.getenv("IDENTITY_HEADER");
        if (isEmpty(endpoint) || isEmpty(header)) {
            endpoint = System.getenv("MSI_ENDPOINT");
            header = System.getenv("MSI_SECRET");
        }
        if (!isEmpty(endpoint) && !isEmpty(header)) {
            // Azure Container Apps / App Service managed-identity protocol.
            String url = endpoint
                    + (endpoint.indexOf('?') >= 0 ? "&" : "?")
                    + "api-version=2019-08-01&resource=" + encode(resource)
                    + clientIdParam();
            return httpGetAccessToken(url, "X-IDENTITY-HEADER", header);
        }
        // Classic IMDS (VM / VMSS / AKS) fallback.
        String url = "http://169.254.169.254/metadata/identity/oauth2/token"
                + "?api-version=2018-02-01&resource=" + encode(resource)
                + clientIdParam();
        return httpGetAccessToken(url, "Metadata", "true");
    }

    private String clientIdParam() {
        return clientId.isEmpty() ? "" : "&client_id=" + encode(clientId);
    }

    private static String httpGetAccessToken(String url, String headerName, String headerValue) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) URI.create(url).toURL().openConnection();
        try {
            conn.setRequestMethod("GET");
            conn.setRequestProperty(headerName, headerValue);
            conn.setConnectTimeout(5_000);
            conn.setReadTimeout(15_000);
            int status = conn.getResponseCode();
            InputStream stream = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            StringBuilder body = new StringBuilder();
            if (stream != null) {
                try (BufferedReader reader =
                             new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        body.append(line);
                    }
                }
            }
            if (status < 200 || status >= 300) {
                // Deliberately body-free: an error body from the identity
                // endpoint can echo request material into logs.
                throw new IllegalStateException("managed-identity endpoint returned HTTP " + status);
            }
            String token = extractJsonString(body.toString(), "access_token");
            if (isEmpty(token)) {
                throw new IllegalStateException("managed-identity response carried no access_token field");
            }
            return token;
        } finally {
            conn.disconnect();
        }
    }

    /**
     * Minimal, allocation-cheap extraction of one string field. The managed-identity
     * response is a flat, machine-generated object and an access token is base64url
     * (no escapes), so a JSON library would be pure classpath risk for no benefit.
     */
    static String extractJsonString(String json, String key) {
        String needle = "\"" + key + "\"";
        int i = json.indexOf(needle);
        if (i < 0) {
            return null;
        }
        i = json.indexOf(':', i + needle.length());
        if (i < 0) {
            return null;
        }
        i++;
        while (i < json.length() && Character.isWhitespace(json.charAt(i))) {
            i++;
        }
        if (i >= json.length() || json.charAt(i) != '"') {
            return null;
        }
        i++;
        StringBuilder out = new StringBuilder();
        while (i < json.length()) {
            char ch = json.charAt(i);
            if (ch == '\\') {
                i++;
                if (i < json.length()) {
                    out.append(json.charAt(i));
                    i++;
                }
                continue;
            }
            if (ch == '"') {
                break;
            }
            out.append(ch);
            i++;
        }
        return out.toString();
    }

    /** The MSI endpoints want the bare resource URI, not an OAuth2 `.default` scope. */
    static String normalizeResource(String value) {
        String out = value.trim();
        if (out.endsWith("/.default")) {
            out = out.substring(0, out.length() - "/.default".length());
        }
        while (out.endsWith("/")) {
            out = out.substring(0, out.length() - 1);
        }
        return out;
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    private static boolean isEmpty(String value) {
        return value == null || value.isEmpty();
    }

    private static String firstNonEmpty(String... values) {
        for (String value : values) {
            if (value != null && !value.trim().isEmpty()) {
                return value.trim();
            }
        }
        return "";
    }
}
