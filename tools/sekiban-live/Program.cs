using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Sekiban.Dcb.Common;
using Sekiban.Dcb.Domains;
using Sekiban.Dcb.Events;
using Sekiban.Dcb.Postgres;
using Sekiban.Dcb.Postgres.DbModels;
using Sekiban.Dcb.ServiceId;

static class Program
{
    private const string Generator = "process-shared";

    private sealed record RoomReserved(string ReservationId, string RoomId, string UserId) : IEventPayload;

    private static async Task<int> Main(string[] args)
    {
        try
        {
            if (args.Length != 3 || args[0] is not ("write" or "read" or "hold"))
            {
                throw new ArgumentException("usage: write|read|hold <connection-string> <service-id>");
            }

            var command = args[0];
            var connectionString = args[1];
            var serviceId = args[2];
            var services = new ServiceCollection();
            services.AddLogging(builder => builder.SetMinimumLevel(LogLevel.None));
            services.AddDbContextFactory<SekibanDcbDbContext>(options => options.UseNpgsql(connectionString));
            var eventTypes = new SimpleEventTypes();
            eventTypes.RegisterEventType<RoomReserved>("RoomReserved");
            services.AddSingleton<IEventTypes>(eventTypes);
            services.AddSingleton<IServiceIdProvider>(new FixedServiceIdProvider(serviceId));
            services.AddSingleton<PostgresEventStore>();
            await using var provider = services.BuildServiceProvider();
            var factory = provider.GetRequiredService<IDbContextFactory<SekibanDcbDbContext>>();
            await using (var context = await factory.CreateDbContextAsync())
            {
                await context.Database.EnsureCreatedAsync();
            }

            var store = provider.GetRequiredService<PostgresEventStore>();
            if (command == "read")
            {
                var read = await store.ReadAllEventsAsync();
                if (!read.IsSuccess) throw read.GetException();
                var events = read.GetValue().Select(item => ProjectProvider(serviceId, eventTypes, item)).ToList();
                Write(new { generator = Generator, pid = Environment.ProcessId, events });
                return 0;
            }

            var id = Guid.NewGuid();
            var sortableUniqueId = SortableUniqueId.GenerateNew();
            var written = new Event(
                new RoomReserved("reservation-g33", "room-g33", "user-g33"),
                sortableUniqueId,
                "RoomReserved",
                id,
                new EventMetadata(id.ToString(), "SerializedCommit", "SerializedSekibanExecutor"),
                ["room:g33"]);
            var result = await store.WriteEventsAsync([written]);
            if (!result.IsSuccess) throw result.GetException();
            await using (var context = await factory.CreateDbContextAsync())
            {
                var row = await context.Events.AsNoTracking().SingleAsync(item => item.ServiceId == serviceId && item.Id == id);
                Write(new { generator = Generator, pid = Environment.ProcessId, @event = Project(row) });
            }

            if (command == "hold")
            {
                await Task.Delay(Timeout.Infinite);
            }

            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"sekiban-live: {error.Message}");
            return 1;
        }
    }

    private static object ProjectProvider(string serviceId, IEventTypes eventTypes, Event ev) => new
    {
        serviceId,
        id = ev.Id.ToString(),
        sortableUniqueId = ev.SortableUniqueIdValue,
        eventType = ev.EventType,
        payload = eventTypes.SerializeEventPayload(ev.Payload),
        tags = ev.Tags,
        causationId = ev.EventMetadata.CausationId,
        correlationId = ev.EventMetadata.CorrelationId,
        executedUser = ev.EventMetadata.ExecutedUser,
    };

    private static object Project(DbEvent row) => new
    {
        serviceId = row.ServiceId,
        id = row.Id.ToString(),
        sortableUniqueId = row.SortableUniqueId,
        eventType = row.EventType,
        payload = row.Payload,
        tags = JsonSerializer.Deserialize<List<string>>(row.Tags) ?? new List<string>(),
        timestamp = DateTime.SpecifyKind(row.Timestamp, DateTimeKind.Utc).ToString("o"),
        causationId = row.CausationId,
        correlationId = row.CorrelationId,
        executedUser = row.ExecutedUser,
    };

    private static void Write(object value) =>
        Console.WriteLine(JsonSerializer.Serialize(value));
}
