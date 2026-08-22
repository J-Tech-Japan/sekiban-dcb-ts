using System.Text.Json;

static class Program
{
    private const string Pin = "855feaa93564fef54defec76e9ccff969d4ee01a";

    private sealed record LogicalEvent(
        string serviceId,
        string id,
        string sortableUniqueId,
        string eventType,
        string payload,
        string[] tags,
        string timestamp,
        string? causationId,
        string? correlationId,
        string? executedUser);

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 2 && args[0] == "verify-source")
            {
                VerifyPinnedSource(args[1]);
                return 0;
            }
            if (args.Length == 2 && args[0] == "generate")
            {
                VerifyPinnedSource(args[1]);
                Console.WriteLine(JsonSerializer.Serialize(Generate(false), JsonOptions));
                return 0;
            }
            if (args.Length == 2 && args[0] == "generate-null")
            {
                VerifyPinnedSource(args[1]);
                Console.WriteLine(JsonSerializer.Serialize(Generate(true), JsonOptions));
                return 0;
            }
            if (args.Length == 3 && args[0] == "consume")
            {
                VerifyPinnedSource(args[1]);
                Consume(args[2]);
                return 0;
            }
            throw new ArgumentException("usage: verify-source <Sekiban-root> | generate <Sekiban-root> | consume <Sekiban-root> <logical-event.json>");
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"sekiban-parity: {error.Message}");
            return 1;
        }
    }

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = false,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    private static LogicalEvent Generate(bool nullMetadata)
    {
        var ticks = DateTimeOffset.FromUnixTimeMilliseconds(1787414836102).UtcDateTime.Ticks;
        var suid = ticks.ToString("0000000000000000000") + "00000000001";
        const string id = "018f9c51-6b74-7f5e-8ca1-0123456789ab";
        return new LogicalEvent(
            "parity-service",
            id,
            suid,
            "RoomReserved",
            "{\"reservationId\":\"reservation-1\", \"roomId\":\"room-1\",\"userId\":\"user-1\"}",
            ["room:room-1", "reservation:reservation-1"],
            "2026-08-22T17:00:00.1230000Z",
            nullMetadata ? null : id,
            nullMetadata ? null : "SerializedCommit",
            nullMetadata ? null : "SerializedSekibanExecutor");
    }

    private static void Consume(string path)
    {
        var source = File.ReadAllText(path);
        using var document = JsonDocument.Parse(source);
        var root = document.RootElement;
        foreach (var property in new[] { "serviceId", "id", "sortableUniqueId", "eventType", "payload", "tags", "timestamp", "causationId", "correlationId", "executedUser" })
        {
            if (!root.TryGetProperty(property, out _)) throw new InvalidDataException($"missing logical record field {property}");
        }
        var suid = RequireString(root, "sortableUniqueId");
        if (suid.Length != 30 || !suid.All(char.IsAsciiDigit)) throw new InvalidDataException("sortableUniqueId is not 30 ASCII digits");
        var eventType = RequireString(root, "eventType");
        if (string.IsNullOrWhiteSpace(eventType) || eventType.Contains(':')) throw new InvalidDataException("eventType must be eventPayloadName only");
        var id = RequireString(root, "id");
        if (!Guid.TryParse(id, out _)) throw new InvalidDataException("id is not an RFC4122 UUID");
        var causationId = OptionalString(root, "causationId");
        var correlationId = OptionalString(root, "correlationId");
        var executedUser = OptionalString(root, "executedUser");
        var metadataIsNull = causationId is null && correlationId is null && executedUser is null;
        var metadataIsSerialized = string.Equals(causationId, id, StringComparison.Ordinal)
            && string.Equals(correlationId, "SerializedCommit", StringComparison.Ordinal)
            && string.Equals(executedUser, "SerializedSekibanExecutor", StringComparison.Ordinal);
        if (!metadataIsNull && !metadataIsSerialized) throw new InvalidDataException("metadata must be either all null or SerializedCommit constants");
        if (root.GetProperty("tags").ValueKind != JsonValueKind.Array || root.GetProperty("tags").EnumerateArray().Any(tag => tag.ValueKind != JsonValueKind.String)) throw new InvalidDataException("tags must be a string array");
        var timestamp = RequireString(root, "timestamp");
        if (!DateTimeOffset.TryParse(timestamp, out var parsedTimestamp) || parsedTimestamp.Offset != TimeSpan.Zero) throw new InvalidDataException("timestamp is not UTC");
        JsonDocument.Parse(RequireString(root, "payload"));
    }

    private static string RequireString(JsonElement root, string property)
    {
        var value = root.GetProperty(property);
        return value.ValueKind == JsonValueKind.String ? value.GetString()! : throw new InvalidDataException($"{property} must be a string");
    }

    private static string? OptionalString(JsonElement root, string property)
    {
        var value = root.GetProperty(property);
        if (value.ValueKind == JsonValueKind.Null) return null;
        return value.ValueKind == JsonValueKind.String ? value.GetString() : throw new InvalidDataException($"{property} must be a string or null");
    }

    private static void VerifyPinnedSource(string sourceRoot)
    {
        var sortable = Read(sourceRoot, "dcb/src/Sekiban.Dcb.Core.Model/Common/SortableUniqueId.cs");
        var dbEvent = Read(sourceRoot, "dcb/src/Sekiban.Dcb.Postgres/DbModels/DbEvent.cs");
        var dbContext = Read(sourceRoot, "dcb/src/Sekiban.Dcb.Postgres/SekibanDcbDbContext.cs");
        var cosmos = Read(sourceRoot, "dcb/src/Sekiban.Dcb.CosmosDb/Models/CosmosEvent.cs");
        Require(sortable, "TickNumberOfLength = 19", "IdNumberOfLength = 11", "TickFormatter = \"0000000000000000000\"", "IdFormatter = \"00000000000\"", "GetIdString(Guid id)");
        Require(dbEvent, "[Table(\"dcb_events\")]", "public string ServiceId", "public Guid Id", "public string SortableUniqueId", "public string EventType", "[Column(TypeName = \"json\")]", "[Column(TypeName = \"jsonb\")]", "public DateTime Timestamp", "public string? CausationId", "public string? CorrelationId", "public string? ExecutedUser");
        Require(dbContext, "entity.HasKey(e => new { e.ServiceId, e.Id })", "IX_Events_ServiceId", "IX_Events_Service_SortableUniqueId", "entity.HasIndex(e => e.EventType)", "entity.HasIndex(e => e.Timestamp)", "HasMaxLength(100)", "HasMaxLength(64)");
        Require(cosmos, "[JsonProperty(\"pk\")]", "[JsonProperty(\"serviceId\")]", "[JsonProperty(\"id\")]", "[JsonProperty(\"sortableUniqueId\")]", "[JsonProperty(\"eventType\")]", "[JsonProperty(\"payload\")]", "[JsonProperty(\"tags\")]", "[JsonProperty(\"timestamp\")]", "[JsonProperty(\"causationId\")]", "[JsonProperty(\"correlationId\")]", "[JsonProperty(\"executedUser\")]", "[JsonProperty(\"_etag\")]", "Pk = $\"{serviceId}|{id}\"");
    }

    private static void Require(string source, params string[] fragments)
    {
        foreach (var fragment in fragments)
            if (!source.Contains(fragment, StringComparison.Ordinal))
                throw new InvalidDataException($"pinned C# contract drifted: missing {fragment}");
    }

    private static string Read(string root, string relative)
    {
        var path = Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar));
        return File.Exists(path) ? File.ReadAllText(path) : throw new FileNotFoundException($"missing pinned source {relative}", path);
    }
}
