// Generated provenance source: J-Tech-Japan/Sekiban@f9953dc4.
// Command: dotnet run --project test/fixtures/g23-csharp-reference
// The two SerializableEvent identities are emitted in arrival (unsafe) order.
// They target one row: the early arrival is older than the tentative late
// winner, while a SUID-ordered safe fold deterministically reaches that same
// late final winner.
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Sekiban.Dcb.Events;

SerializableEvent Event(string id, string suid, byte payload) => new(
  new[] { payload }, suid, Guid.Parse(id), new EventMetadata("g23", "g23", "reference"), new List<string> { "g23:orders" }, "G23ReferenceEvent");

var early = Event("11111111-1111-1111-1111-111111111111", "suid-00000000000000000000000000000001", 1);
var late = Event("22222222-2222-2222-2222-222222222222", "suid-00000000000000000000000000000002", 2);
var output = JsonSerializer.Serialize(new {
  arrivals = new[] {
    new { eventId = late.Id.ToString(), suid = late.SortableUniqueIdValue, payload = Convert.ToBase64String(late.Payload) },
    new { eventId = early.Id.ToString(), suid = early.SortableUniqueIdValue, payload = Convert.ToBase64String(early.Payload) }
  },
  unsafeTentative = new[] { late.Id.ToString() },
  safeOrderedFold = new[] { late.Id.ToString() }
}) + "\n";
Console.Write(output);
Console.Error.WriteLine(Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(output))).ToLowerInvariant());
