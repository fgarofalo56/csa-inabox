using System.Data.Common;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AnalysisServices.AdomdClient;

// Bounded stdin only. Library exception text may contain credentials; never emit it.
try
{
    var buffer = new char[32769];
    var length = 0;
    int read;
    while (length < buffer.Length &&
           (read = await Console.In.ReadAsync(buffer.AsMemory(length))) > 0)
        length += read;
    if (length == buffer.Length) throw new ArgumentException();
    var request = JsonSerializer.Deserialize<ProbeRequest>(new string(buffer, 0, length))
        ?? throw new ArgumentException();
    if (!Uri.TryCreate(request.ServerUri, UriKind.Absolute, out var uri) ||
        uri.Scheme != "asazure" || !uri.IsDefaultPort || uri.UserInfo.Length != 0 ||
        uri.Query.Length != 0 || uri.Fragment.Length != 0 ||
        !Regex.IsMatch(uri.Host, @"^[a-z0-9-]+\.asazure\.(windows\.net|usgovcloudapi\.net)$") ||
        !Regex.IsMatch(uri.AbsolutePath, @"^/[a-zA-Z0-9-]+$") ||
        string.IsNullOrWhiteSpace(request.Token) || request.Token.Length > 24000 ||
        request.ExpiresOnTimestamp <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())
        throw new ArgumentException();

    var connectionString = new DbConnectionStringBuilder
    {
        ["Data Source"] = request.ServerUri,
        ["Connect Timeout"] = 15
    };
    using var connection = new AdomdConnection(connectionString.ConnectionString);
    connection.AccessToken = new Microsoft.AnalysisServices.AccessToken(request.Token,
        DateTimeOffset.FromUnixTimeMilliseconds(request.ExpiresOnTimestamp));
    connection.Open();
    var catalogs = connection.GetSchemaDataSet("DBSCHEMA_CATALOGS", null);
    if (catalogs.Tables.Count == 0) throw new InvalidOperationException();
    Console.WriteLine(JsonSerializer.Serialize(new { ok = true, catalogCount = catalogs.Tables[0].Rows.Count }));
    return 0;
}
catch (ArgumentException)
{
    Console.WriteLine("{\"ok\":false,\"code\":\"invalid-input\"}");
    return 2;
}
catch (JsonException)
{
    Console.WriteLine("{\"ok\":false,\"code\":\"invalid-input\"}");
    return 2;
}
catch (Exception)
{
    Console.WriteLine("{\"ok\":false,\"code\":\"discovery-failed\"}");
    return 1;
}

internal sealed record ProbeRequest(string ServerUri, string Token, long ExpiresOnTimestamp);
