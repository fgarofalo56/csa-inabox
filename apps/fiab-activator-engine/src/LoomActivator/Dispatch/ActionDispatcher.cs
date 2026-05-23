using CsaLoom.Activator.Models;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace CsaLoom.Activator.Dispatch;

/// <summary>
/// Dispatches actions to the four supported sinks: Teams (incoming webhook),
/// email (Logic App email action), Logic App (HTTP trigger), generic webhook.
/// </summary>
public class ActionDispatcher
{
    private readonly IHttpClientFactory _httpFactory;
    private readonly ILogger<ActionDispatcher> _log;

    public ActionDispatcher(IHttpClientFactory httpFactory, ILogger<ActionDispatcher> log)
    {
        _httpFactory = httpFactory;
        _log = log;
    }

    public async Task DispatchAsync(FireDecision decision, CancellationToken ct = default)
    {
        var rule = decision.Rule;
        _log.LogInformation(
            "Dispatching action {Action} → {Target} for rule {RuleId} on {ObjectId}: {Reason}",
            rule.Action, rule.ActionTarget, rule.Id, decision.ObjectId, decision.Reason);

        var payload = BuildPayload(decision);
        var client = _httpFactory.CreateClient("action-dispatcher");

        try
        {
            switch (rule.Action)
            {
                case ActionType.Teams:
                    await PostTeams(client, rule.ActionTarget, payload, ct);
                    break;
                case ActionType.Email:
                    await PostEmail(client, rule.ActionTarget, payload, ct);
                    break;
                case ActionType.LogicApp:
                    await PostLogicApp(client, rule.ActionTarget, payload, ct);
                    break;
                case ActionType.Webhook:
                    await PostWebhook(client, rule.ActionTarget, payload, ct);
                    break;
            }
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Action dispatch failed for rule {RuleId}", rule.Id);
            throw;
        }
    }

    private async Task PostTeams(HttpClient client, string target, object payload, CancellationToken ct)
    {
        // target = Teams incoming webhook URL (Key Vault secret reference resolved at startup)
        var card = new
        {
            type = "message",
            attachments = new[]
            {
                new
                {
                    contentType = "application/vnd.microsoft.card.adaptive",
                    content = new
                    {
                        type = "AdaptiveCard",
                        version = "1.5",
                        body = new object[]
                        {
                            new { type = "TextBlock", size = "Large", weight = "Bolder", text = ((dynamic)payload).Title },
                            new { type = "TextBlock", wrap = true, text = ((dynamic)payload).Reason },
                            new { type = "FactSet", facts = new object[]
                                {
                                    new { title = "Object", value = ((dynamic)payload).ObjectId },
                                    new { title = "Rule", value = ((dynamic)payload).RuleName },
                                    new { title = "Time", value = ((dynamic)payload).Timestamp },
                                }
                            }
                        }
                    }
                }
            }
        };
        await PostJson(client, target, card, ct);
    }

    private Task PostEmail(HttpClient client, string target, object payload, CancellationToken ct)
        // Email dispatch routes through a Logic App with the email connector.
        // target = Logic App HTTP trigger URL.
        => PostJson(client, target, payload, ct);

    private Task PostLogicApp(HttpClient client, string target, object payload, CancellationToken ct)
        => PostJson(client, target, payload, ct);

    private Task PostWebhook(HttpClient client, string target, object payload, CancellationToken ct)
        => PostJson(client, target, payload, ct);

    private static async Task PostJson(HttpClient client, string url, object body, CancellationToken ct)
    {
        var json = JsonSerializer.Serialize(body);
        using var req = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json")
        };
        using var res = await client.SendAsync(req, ct);
        res.EnsureSuccessStatusCode();
    }

    private static object BuildPayload(FireDecision decision) => new
    {
        Title = $"Loom Activator: {decision.Rule.Name}",
        RuleId = decision.Rule.Id,
        RuleName = decision.Rule.Name,
        WorkspaceId = decision.Rule.WorkspaceId,
        ObjectId = decision.ObjectId,
        Reason = decision.Reason,
        Primitive = decision.Rule.Primitive.ToString(),
        Property = decision.Rule.Property,
        Threshold = decision.Rule.Threshold,
        Timestamp = decision.Timestamp.ToString("O"),
        TriggeringValue = decision.TriggeringPoint.NumericValue ?? (object?)decision.TriggeringPoint.StringValue,
    };
}
