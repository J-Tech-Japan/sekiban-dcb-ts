/* global document, fetch, FormData */

const result = document.querySelector("#result");

function show(value) {
  result.textContent = JSON.stringify(value, null, 2);
}

async function request(path, init) {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => ({ error: response.statusText }));
  show(body);
}

for (const form of document.querySelectorAll("form[data-command]")) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = Object.fromEntries(new FormData(form).entries());
    await request(`/api/commands/${form.dataset.command}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input }),
    });
  });
}

for (const button of document.querySelectorAll("button[data-read]")) {
  button.addEventListener("click", async () => {
    const kind = button.dataset.read;
    if (kind === "room") {
      const id = document.querySelector("#room-read-id").value;
      await request(`/api/read/room?roomId=${encodeURIComponent(id)}`);
    } else if (kind === "reservation") {
      const id = document.querySelector("#reservation-read-id").value;
      await request(`/api/read/reservation?reservationId=${encodeURIComponent(id)}`);
    } else {
      await request("/api/read/reservations");
    }
  });
}
