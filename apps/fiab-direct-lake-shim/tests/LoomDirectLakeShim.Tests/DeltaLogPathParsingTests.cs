using FluentAssertions;
using System.Text.RegularExpressions;
using Xunit;

namespace CsaLoom.DirectLakeShim.Tests;

/// <summary>
/// Tests the regex that DeltaLogEventHandler uses to identify which
/// Storage events correspond to Delta commit log writes.
///
/// The pattern is duplicated here from the handler so the test
/// doesn't take a runtime dependency on the BackgroundService.
/// </summary>
public class DeltaLogPathParsingTests
{
    private static readonly Regex DeltaLogPath =
        new(@"^/[^/]+/(?<schema>[^/]+)/(?<table>[^/]+)/_delta_log/(?<commit>\d+)\.json$",
            RegexOptions.Compiled);

    [Theory]
    [InlineData("/bronze/dbo/orders/_delta_log/00000000000000000001.json", "dbo", "orders", "00000000000000000001")]
    [InlineData("/silver/finance/fact_sales/_delta_log/00000000000000000042.json", "finance", "fact_sales", "00000000000000000042")]
    [InlineData("/gold/marketing/dim_campaign/_delta_log/00000000000000123456.json", "marketing", "dim_campaign", "00000000000000123456")]
    public void Parses_valid_delta_commit_paths(string path, string expectedSchema, string expectedTable, string expectedCommit)
    {
        var match = DeltaLogPath.Match(path);
        match.Success.Should().BeTrue();
        match.Groups["schema"].Value.Should().Be(expectedSchema);
        match.Groups["table"].Value.Should().Be(expectedTable);
        match.Groups["commit"].Value.Should().Be(expectedCommit);
    }

    [Theory]
    [InlineData("/bronze/dbo/orders/_delta_log/_last_checkpoint")]  // not a json commit
    [InlineData("/bronze/dbo/orders/_delta_log/00000000000000000001.checkpoint.parquet")]
    [InlineData("/bronze/dbo/orders/data/part-0001.parquet")]  // data file, not commit
    [InlineData("/_delta_log/00000000000000000001.json")]  // missing schema/table
    [InlineData("/bronze/dbo/orders/_delta_log/abc.json")]  // commit must be numeric
    public void Rejects_non_commit_paths(string path)
    {
        DeltaLogPath.Match(path).Success.Should().BeFalse();
    }

    [Theory]
    [InlineData("/bronze/finance/fact_sales/event_date=2026-05-22/_delta_log/00000000000000000010.json", false)]
    public void Rejects_partition_subdirectory_commit_paths(string path, bool _)
    {
        // Delta commits live ONLY at the table root; partition dirs
        // contain data files, not _delta_log/ entries. If we ever see
        // a "commit" inside a partition dir, ignore it — likely a
        // misnamed file from an external writer.
        DeltaLogPath.Match(path).Success.Should().BeFalse();
    }
}
