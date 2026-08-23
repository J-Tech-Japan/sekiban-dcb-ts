using System.Text;
using System.Text.Json;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Sekiban.Dcb.Common;
using Sekiban.Dcb.CosmosDb.Models;
using Sekiban.Dcb.Domains;
using Sekiban.Dcb.Events;
using Sekiban.Dcb.Postgres.DbModels;

static class Program
{
    // This is an authoring payload for SimpleEventTypes, not a parallel
    // logical-record model. Every durable representation below comes from
    // Sekiban's real EventSerializationExtensions / DbEvent / CosmosEvent.
    private sealed record RoomReserved(string ReservationId, string RoomId, string UserId) : IEventPayload;

    private const string ServiceId = "parity-service";
    private static readonly Guid EventId = Guid.Parse("018f9c51-6b74-7f5e-8ca1-0123456789ab");

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 1 && args[0] == "produce")
            {
                Console.WriteLine(Produce());
                return 0;
            }
            if (args.Length == 2 && args[0] == "consume-postgres")
            {
                ConsumePostgres(args[1]);
                return 0;
            }
            if (args.Length == 2 && args[0] == "consume-cosmos")
            {
                ConsumeCosmos(args[1]);
                return 0;
            }
            throw new ArgumentException("usage: produce | consume-postgres <actual-ts-provider-row.json> | consume-cosmos <actual-ts-provider-row.json>");
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"sekiban-parity: {error.Message}");
            return 1;
        }
    }

    private static SimpleEventTypes EventTypes()
    {
        var types = new SimpleEventTypes();
        types.RegisterEventType<RoomReserved>("RoomReserved");
        return types;
    }

    private static Event SourceEvent()
    {
        var sortableUniqueId = SortableUniqueId.Generate(
            new DateTime(2026, 8, 22, 17, 0, 0, 123, DateTimeKind.Utc),
            EventId);
        return new Event(
            new RoomReserved("reservation-1", "room-1", "user-1"),
            sortableUniqueId,
            "RoomReserved",
            EventId,
            new EventMetadata(EventId.ToString(), "SerializedCommit", "SerializedSekibanExecutor"),
            ["test:sekiban-parity"]);
    }

    private static string Produce()
    {
        var eventTypes = EventTypes();
        var source = SourceEvent();
        var serializable = source.ToSerializableEvent(eventTypes);
        var restored = serializable.ToEvent(eventTypes).GetValue();
        var payload = Encoding.UTF8.GetString(serializable.Payload);

        // The two provider models are constructed and consumed through their
        // shipped APIs. Their timestamp implementation is intentionally not
        // reimplemented in this runner.
        var postgres = DbEvent.FromEvent(restored, payload, ServiceId);
        var postgresRestored = postgres.ToEvent(restored.Payload);
        var cosmos = CosmosEvent.FromEvent(restored, payload, ServiceId);
        var cosmosRestored = cosmos.ToEvent(restored.Payload);
        AssertEquivalent(source, restored, "EventSerializationExtensions");
        AssertEquivalent(restored, postgresRestored, "DbEvent");
        AssertEquivalent(restored, cosmosRestored, "CosmosEvent");

        var output = new JObject
        {
            ["serializable"] = JObject.FromObject(serializable),
            ["postgres"] = JObject.FromObject(postgres),
            // Newtonsoft is the provider's actual Cosmos wire serializer and
            // therefore applies CosmosEvent's JsonProperty attributes.
            ["cosmos"] = JObject.Parse(JsonConvert.SerializeObject(cosmos)),
        };
        return output.ToString(Formatting.None);
    }

    private static void ConsumePostgres(string path)
    {
        var row = System.Text.Json.JsonSerializer.Deserialize<DbEvent>(File.ReadAllText(path), new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
        }) ?? throw new InvalidDataException("actual TS PostgreSQL provider row did not deserialize as DbEvent");
        var eventTypes = EventTypes();
        var payload = eventTypes.DeserializeEventPayload(row.EventType, row.Payload)
            ?? throw new InvalidDataException("DbEvent payload did not deserialize through SimpleEventTypes");
        var restored = row.ToEvent(payload);
        var serializable = restored.ToSerializableEvent(eventTypes);
        Require(Encoding.UTF8.GetString(serializable.Payload) == row.Payload, "DbEvent round-trip changed payload bytes");
        Require(serializable.EventPayloadName == row.EventType, "DbEvent round-trip changed EventType");
    }

    private static void ConsumeCosmos(string path)
    {
        var row = JsonConvert.DeserializeObject<CosmosEvent>(File.ReadAllText(path))
            ?? throw new InvalidDataException("actual TS Cosmos provider row did not deserialize as CosmosEvent");
        var eventTypes = EventTypes();
        var payload = eventTypes.DeserializeEventPayload(row.EventType, row.Payload)
            ?? throw new InvalidDataException("CosmosEvent payload did not deserialize through SimpleEventTypes");
        var restored = row.ToEvent(payload);
        var serializable = restored.ToSerializableEvent(eventTypes);
        Require(Encoding.UTF8.GetString(serializable.Payload) == row.Payload, "CosmosEvent round-trip changed payload bytes");
        Require(serializable.EventPayloadName == row.EventType, "CosmosEvent round-trip changed EventType");
        Require(row.Pk == $"{row.ServiceId}|{row.Id}", "CosmosEvent partition key is not ServiceId|Id");
    }

    private static void AssertEquivalent(Event expected, Event actual, string path)
    {
        Require(expected.Id == actual.Id, $"{path} changed Id");
        Require(expected.SortableUniqueIdValue == actual.SortableUniqueIdValue, $"{path} changed SortableUniqueId");
        Require(expected.EventType == actual.EventType, $"{path} changed EventType");
        Require(expected.Tags.SequenceEqual(actual.Tags), $"{path} changed Tags");
        Require(expected.EventMetadata == actual.EventMetadata, $"{path} changed metadata");
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidDataException(message);
    }
}
