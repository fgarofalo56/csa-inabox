// Minimal SSE chat — no frameworks, no build step.
(function () {
  "use strict";
  const root = document.querySelector(".chat");
  if (!root) return;
  const endpoint = root.getAttribute("data-sse-endpoint") || "/chat/send";
  const form = document.getElementById("chat-form");
  const input = document.getElementById("question");
  const messages = document.getElementById("messages");
  let currentBotBubble = null;

  function appendBubble(cls, text) {
    const li = document.createElement("li");
    li.className = cls;
    li.textContent = text;
    messages.appendChild(li);
    li.scrollIntoView({ behavior: "smooth", block: "end" });
    return li;
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    const question = input.value.trim();
    if (!question) return;
    appendBubble("user", question);
    currentBotBubble = appendBubble("bot", "");
    input.value = "";
    const url = endpoint + "?question=" + encodeURIComponent(question);
    const source = new EventSource(url);
    source.addEventListener("token", function (event) {
      if (!currentBotBubble) return;
      currentBotBubble.textContent = currentBotBubble.textContent + event.data;
    });
    source.addEventListener("status", function (event) {
      if (String(event.data).startsWith("refused")) {
        if (currentBotBubble) currentBotBubble.classList.add("refused");
      }
    });
    source.addEventListener("done", function () {
      source.close();
      currentBotBubble = null;
    });
    source.addEventListener("ping", function () {
      // keep-alive — no-op.
    });
    source.onerror = function () {
      source.close();
      if (currentBotBubble && !currentBotBubble.textContent) {
        currentBotBubble.textContent = "[connection closed]";
        currentBotBubble.classList.add("refused");
      }
      currentBotBubble = null;
    };
  });
})();
