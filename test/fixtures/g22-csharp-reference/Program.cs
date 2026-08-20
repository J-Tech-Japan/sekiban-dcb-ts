// Generated fixture provenance source: J-Tech-Japan/Sekiban@f9953dc4's Sekiban.Dcb.Events.SerializableEvent.
// Command: dotnet run --project test/fixtures/g22-csharp-reference > test/fixtures/g22-csharp-fixture.generated.json
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Sekiban.Dcb.Events;

var serialized = new SerializableEvent(new byte[] { 1, 2 }, "suid-00000000000000000000000000000001", Guid.Parse("11111111-1111-1111-1111-111111111111"), new EventMetadata("cause", "correlation", "operator"), new List<string> { "orders", "users" }, "ReferenceEvent");
var json = JsonSerializer.Serialize(new { events = new[] { new { eventId = serialized.Id.ToString(), suid = serialized.SortableUniqueIdValue, payload = Convert.ToBase64String(serialized.Payload), eventTags = serialized.Tags } } });
var output = json + "\n";
Console.Write(output);
Console.Error.WriteLine(Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(output))).ToLowerInvariant());
